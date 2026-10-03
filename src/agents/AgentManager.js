// AgentManager：4 名虚拟成员的大脑调度器
//
// 职责：
//   · 触发判定（收到上帝命令 / 受击 / 低血 / 发现敌人 / 目标被毁 / 队友喊话 / 空闲）
//   · 冷却与预算控制（每成员决策冷却、喊话冷却、每分钟调用上限、每局 token 上限）
//   · 一次调用同时拿到「台词 + 决策」，失败或超限时降级为脚本 AI
//   · 把决策翻译成引擎指令（寻路 / 锁定目标 / 切换武器 / 守卫）
//   · 阵营内协作与跨阵营喊话的消息分发

import { FPS, TEAM_PLAYER, TEAM_NAMES, MAP_WIDTH, MAP_HEIGHT, SANDBAG } from '../constants.js';
import { MEMBERS, WEAPONS, dismountVehicle } from '../sandbox/memberDefs.js';
import { findHQ } from '../sandbox/scenario.js';
import { session } from '../core/session.js';
import { buildSystemPrompt, buildSnapshot } from './prompts.js';
import { parseDecision } from './parser.js';
import { fallbackDecide, quickCommandDecision, parseGodCommand } from './FallbackAI.js';
import { isAIAutoTargetable } from './targeting.js';
import { buildSquadBoard } from './squadBoard.js';
import { canSee, INTEL_TTL_FRAMES } from './vision.js';
import { chatOnce } from './LLMClient.js';
import { isAgentEnabled, resolveMemberAuth, isLLMReady } from './config.js';

const MAX_INFLIGHT = 6;          // 同时在途的 LLM 请求上限（六名成员六把独立 Key，可全并行，不必排队）
// 命令快车道：本地解析失败转 LLM 时，两次命令调用之间的最小间隔（帧）——只防连发刷屏，不拖命令
const COMMAND_FASTLANE_FRAMES = 30;
const EVENT_CAP = 8;
const MSG_CAP = 4;
const MAX_CONSECUTIVE_ERRORS = 3;
// 低血紧急再决策：允许突破常规冷却，让"快死了还在硬刚"能被及时纠正（只对受伤/低血触发）
const EMERGENCY_HP_RATIO = 0.5;
const EMERGENCY_COOLDOWN_SEC = 4;
// 自保反射（零 token）：身处敌方火力覆盖 + 正在受击 + 血量低于阈值 → 立刻脱离，不等待 LLM。
// 成员"硬刚碉堡到死"的主因是等下一次 LLM 决策的几秒空档里就被射杀，反射补上这个空档。
const REFLEX_HP_RATIO = 0.55;
const REFLEX_COOLDOWN_FRAMES = 240;
const REFLEX_DANGER_MIN = 0.4;

const TRIGGER_RANK = { command: 0, hurt: 1, lowhp: 2, targetdown: 3, contact: 4, chat: 5, idle: 6 };

// 上帝命令执行完毕后的自主续接窗口：命令行动一结束，若 LLM 冷却还没到，
// 先由脚本兜底续接下一仗（零 token），成员不会"执行完命令就站桩发呆"
const COMMAND_DONE_WINDOW_FRAMES = 15 * FPS;

function tileCenter(e) {
  return {
    x: Math.floor(e.x + (e.isBuilding ? e.size / 2 : 0.5)),
    y: Math.floor(e.y + (e.isBuilding ? e.size / 2 : 0.5)),
  };
}

function findEntityById(gameState, id) {
  for (let i = 0; i < gameState.entities.length; i++) {
    if (gameState.entities[i].id === id) return gameState.entities[i];
  }
  return null;
}

/**
 * 喊话是否允许广播（阵营内协作 / 跨阵营劝降共用的硬冷却）
 * 抽成纯函数便于单测：token 成本控制的关键闸门，必须能被验证。
 */
export function canDeliverShout(lastChatFrame, frameCount, cooldownSec) {
  return frameCount - lastChatFrame >= cooldownSec * FPS;
}

export class AgentManager {
  constructor() {
    this.agents = new Map();
    this.cfg = null;
    this.memberSystem = null;
    this.commandBus = null;
    this.hooks = {};
    this.llmReady = false;
    this.inFlight = 0;
    this.callStamps = [];       // 调用时间戳（滚动 60 秒窗口）
    this.totalTokens = 0;
    this.totalCalls = 0;
    this.totalErrors = 0;
    this.budgetExceeded = false;
    this.lastBudgetWarnFrame = -99999;
    // 社交统计（M3：用于验证喊话频率受控）
    this.chatCounts = { self: 0, ally: 0, enemy: 0 };
    this.shoutLog = [];
  }

  init(opts) {
    this.cfg = opts.config;
    this.memberSystem = opts.memberSystem;
    this.commandBus = opts.commandBus;
    this.hooks = {
      onChat: opts.onChat || function () {},
      onNotify: opts.notify || function () {},
    };
    this.llmReady = isLLMReady(this.cfg);

    const self = this;
    this.agents = new Map();
    MEMBERS.forEach(function (spec) {
      const enabled = isAgentEnabled(self.cfg, spec.key);
      self.agents.set(spec.key, {
        spec: spec,
        enabled: enabled,
        degraded: false,
        inFlight: false,
        lastCallFrame: -99999,
        lastChatFrame: -99999,
        lastFallbackLineFrame: -99999,
        lastDecision: null,
        lastSay: '',
        currentIntent: '',
        currentOrderTargetId: 0,
        // 决策序号：每次「发起 LLM 调用 / 本地执行命令」+1；旧响应晚到时不覆盖新行动
        callSeq: 0,
        lastCommandCallFrame: -99999,
        // 记忆
        events: [],
        allyMsgs: [],
        enemyMsgs: [],
        lastHp: null,
        lastHurtEventFrame: -99999,
        lastContactId: 0,
        lastContactFrame: -99999,
        lastCoverId: 0,
        lowHpFlag: false,
        pendingCommand: null,
        commandSeen: 0,
        // 命令生命周期：commandActive=命令行动进行中，行动一结束记录 commandDoneFrame，
        // 供调度层在 LLM 冷却空档用脚本续接下一仗（执行完命令要有自主性）
        commandActive: false,
        commandDoneFrame: -99999,
        // 统计
        tokens: 0,
        calls: 0,
        errors: 0,
        consecutiveErrors: 0,
      });
    });
  }

  /** 红方（或任何成员）在无 LLM 时的自主兜底由调用方决定是否启用 */
  update(gameState, frameCount) {
    if (!this.cfg || this.agents.size === 0) return;
    this.checkBudgetAndWarn(frameCount);

    // 一次性建立 memberKey → 实体 映射，供本轮所有 agent 使用
    const live = new Map();
    for (let i = 0; i < gameState.entities.length; i++) {
      const e = gameState.entities[i];
      if (e.isMember && !e.dead) live.set(e.memberKey, e);
    }

    const self = this;
    this.agents.forEach(function (agent) {
      try {
        self._tickAgent(agent, gameState, frameCount, live);
      } catch (err) {
        console.warn('[agents] tick 异常', agent.spec.key, err);
      }
    });
  }

  // ==================== 单个成员的每帧调度 ====================

  _tickAgent(agent, gameState, frameCount, live) {
    const member = live.get(agent.spec.key);
    if (!member) {
      // 阵亡等待重生：清掉触发状态，避免复活瞬间用旧事件决策
      agent.lastHp = null;
      agent.currentOrderTargetId = 0;
      agent.lowHpFlag = false;
      agent.actionBlocked = false;
      return;
    }

    this._observe(agent, member, gameState, frameCount);

    // 自保反射（零 token）：残血 + 挨打 + 身处敌方火力覆盖 → 立刻脱离，不给 LLM 留空档。
    // 例外：有上帝命令待执行时命令优先——玩家指挥权高于自保反射，否则命令会被"保命"吃掉。
    const pendingCmd = this.commandBus ? this.commandBus.peekFor(agent.spec.key) : null;
    if (!pendingCmd && this._reflexWithdraw(agent, member, gameState, frameCount)) return;

    const trigger = this._pickTrigger(agent, member, gameState, frameCount);
    if (!trigger) return;

    const canLLM = this.llmReady && agent.enabled && !agent.degraded && !this.budgetExceeded;
    let cooldownOk = frameCount - agent.lastCallFrame >= this.cfg.budget.decisionCooldownSec * FPS;
    // 紧急通道：血量过半 + 正在挨打/血低 → 允许缩短冷却，尽快把"硬刚"改成撤退/换位
    if (!cooldownOk && (trigger === 'hurt' || trigger === 'lowhp') &&
        member.hp / member.maxHp < EMERGENCY_HP_RATIO &&
        frameCount - agent.lastCallFrame >= EMERGENCY_COOLDOWN_SEC * FPS) {
      cooldownOk = true;
      agent.emergencyCalls = (agent.emergencyCalls || 0) + 1;
    }

    if (trigger === 'command') {
      // 命令快车道：先本地解析（零 token、当帧执行），解析不了才绕过常规决策冷却直接问 LLM。
      // 本地解析是「最快速度执行」与「不恋战」的保证——撤退/回防等命令不再等冷却 + LLM 往返。
      if (this._tryExecuteCommandLocal(agent, member, gameState, frameCount)) return;
      if (frameCount - agent.lastCommandCallFrame < COMMAND_FASTLANE_FRAMES) return;
      if (canLLM) {
        if (!this._globalBudgetOk()) return;
        this._callLLM(agent, member, gameState, frameCount, trigger);
      } else {
        // 无 LLM 且本地解析失败：消费命令按脚本 AI 行动并回应，避免命令石沉大海
        if (this.commandBus) this.commandBus.takeFor(agent.spec.key);
        agent.pendingCommand = null;
        this._applyFallback(agent, member, gameState, frameCount, trigger, true);
        this.hooks.onChat({
          key: agent.spec.key,
          name: agent.spec.name,
          team: agent.spec.team,
          teamName: TEAM_NAMES[agent.spec.team],
          text: '（按既定战术行动）',
          to: null,
          at: Date.now(),
        });
      }
      return;
    }

    if (canLLM) {
      // 有 LLM：排不上队（冷却/并发/限流）就等下一帧，绝不用脚本兜底抢答——
      // 否则付费拿到的战术会被脚本决策覆盖，还会刷屏
      if (!cooldownOk) {
        // 唯一例外：上帝命令刚执行完、冷却还没到——先由脚本续接下一仗（零 token），
        // 让成员"执行完命令后仍有自主性"；只续接一次，冷却一到 LLM 照常接管
        if ((trigger === 'idle' || trigger === 'targetdown' || trigger === 'contact') &&
            frameCount - (agent.commandDoneFrame || -99999) <= COMMAND_DONE_WINDOW_FRAMES &&
            !agent.inFlight && this.inFlight < MAX_INFLIGHT) {
          agent.commandDoneFrame = -99999;
          this._applyFallback(agent, member, gameState, frameCount, trigger, true);
        }
        return;
      }
      if (agent.inFlight || this.inFlight >= MAX_INFLIGHT) return;
      if (!this._globalBudgetOk()) return;
      this._callLLM(agent, member, gameState, frameCount, trigger);
      return;
    }

    // 真正无 LLM（未配置 / 被关闭 / 已降级 / 超预算）才走兜底
    const humanTeam = agent.spec.team === session.humanTeam;
    if (humanTeam && this._isBusy(member)) return;  // 不覆盖玩家鼠标下达的指令
    this._applyFallback(agent, member, gameState, frameCount, trigger);
  }

  _isBusy(member) {
    const hasPath = member.path && member.path.length > 0 && member.pathIndex < member.path.length;
    return !!(hasPath || member.attackTarget || member.attackMoveTarget || member.guardPos);
  }

  /**
   * 自保反射：残血 + 正在受击 + 身处敌方防御射程内 → 立刻脱离火力。
   * 这是零 token 的脚本兜底，专门补"等下一次 LLM 决策的几秒里被碉堡射死"的空档。
   * @returns true 表示已执行脱离，本帧不再走 LLM 决策
   */
  _reflexWithdraw(agent, member, gameState, frameCount) {
    const ratio = member.hp / member.maxHp;
    if (ratio > REFLEX_HP_RATIO) return false;
    if (member.lastDamagedTimer <= 0) return false;                 // 没在挨打就不跑
    if (member.isAirUnit) return false;                             // 载具/空中单位不适用步兵反射
    const danger = gameState.danger && gameState.danger[member.team];
    if (!danger) return false;
    const mx = Math.floor(member.x), my = Math.floor(member.y);
    const idx = my * MAP_WIDTH + mx;
    if (!(danger[idx] > REFLEX_DANGER_MIN)) return false;           // 不在敌方火力覆盖内
    if (frameCount - (agent.lastReflexFrame || -99999) < REFLEX_COOLDOWN_FRAMES) return false;

    agent.lastReflexFrame = frameCount;
    agent.reflexCount = (agent.reflexCount || 0) + 1;
    const dest = this._findSafeTile(gameState, member, danger);
    member.attackTarget = null;
    member.attackMoveTarget = null;
    member.burstRemaining = 0;
    member.burstTarget = null;
    member.guardPos = null;
    member.fleeTo = { x: dest.x, y: dest.y };   // 纯脱离，不恋战（与 retreat 共用同一条撤离通路）
    member.path = gameState.map.findPath(mx, my, dest.x, dest.y, 3000, member, true);
    member.pathIndex = 0;
    agent.currentOrderTargetId = 0;
    agent.currentIntent = '脱离火力重整';
    agent.lastSay = '';
    if (frameCount - (agent.lastReflexEventFrame || -99999) > 360) {
      agent.lastReflexEventFrame = frameCount;
      agent.events.push('受到重创，主动脱离敌方火力');
    }
    return true;
  }

  /** 找最近的"安全格"（威胁 < 0.3 且可通行），同等距离下优先沙袋工事；找不到就退回己方指挥所 */
  _findSafeTile(gameState, member, danger) {
    const mx = Math.floor(member.x), my = Math.floor(member.y);
    const terrain = gameState.map && gameState.map.terrain;
    for (let r = 2; r <= 9; r++) {
      let best = null, bestD = Infinity, bag = null, bagD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;  // 只搜半径 r 的方环
          const tx = mx + dx, ty = my + dy;
          if (tx < 0 || tx >= MAP_WIDTH || ty < 0 || ty >= MAP_HEIGHT) continue;
          if (danger[ty * MAP_WIDTH + tx] > 0.3) continue;
          if (!gameState.map.isPassable(tx, ty)) continue;
          const d = dx * dx + dy * dy;
          if (terrain && terrain[ty] && terrain[ty][tx] === SANDBAG) {
            if (d < bagD) { bagD = d; bag = { x: tx, y: ty }; }
          } else if (d < bestD) { bestD = d; best = { x: tx, y: ty }; }
        }
      }
      // 一样能脱离火力，蹲进沙袋还能把接下来的伤害削掉四成
      if (bag) return bag;
      if (best) return best;
    }
    const hq = findHQ(gameState, member.team);
    if (hq) return { x: Math.floor(hq.x + hq.size / 2), y: Math.floor(hq.y + hq.size / 2) };
    return { x: mx, y: my };
  }

  /** 更新记忆：受击、低血、目标被毁、发现敌人 */
  _observe(agent, member, gameState, frameCount) {
    // 受击
    if (agent.lastHp != null && member.hp < agent.lastHp &&
        frameCount - agent.lastHurtEventFrame > 90) {
      const lost = Math.round(agent.lastHp - member.hp);
      agent.events.push('你受到攻击，损失 ' + lost + ' 血');
      agent.lastHurtEventFrame = frameCount;
    }
    agent.lastHp = member.hp;

    // 低血
    const ratio = member.hp / member.maxHp;
    if (!agent.lowHpFlag && ratio < 0.5) {
      agent.lowHpFlag = true;
      agent.events.push('你的血量已低于一半');
    } else if (agent.lowHpFlag && ratio > 0.7) {
      agent.lowHpFlag = false;
    }

    // 目标被摧毁
    if (agent.currentOrderTargetId) {
      const tgt = findEntityById(gameState, agent.currentOrderTargetId);
      if (!tgt || tgt.dead) {
        agent.memoryTargetDown = true;
        agent.events.push('你的目标已被摧毁');
        agent.currentOrderTargetId = 0;
      }
    }
    // 上帝标记的目标已死/失效：清掉，别让快照一直挂着一个已消灭的目标
    if (agent.godTargetId) {
      const gt = findEntityById(gameState, agent.godTargetId);
      if (!gt || gt.dead) agent.godTargetId = 0;
    }

    // 发现敌人（按视野 + 视线，中立高楼是掩体不是敌人，走统一判定剔除）
    // 每个看到的敌人同步写进班组情报板，供队友"报点共享"。
    let nearest = null, nd = Infinity;
    let cover = null, cd = Infinity;
    const units = gameState.entities;
    const intel = gameState.squadIntel ? gameState.squadIntel[member.team] : null;
    for (let i = 0; i < units.length; i++) {
      const e = units[i];
      if (e.dead) continue;
      const dx = e.x - member.x, dy = e.y - member.y;
      const d = dx * dx + dy * dy;
      if (e.aiIgnore) {
        if (d < cd) { cd = d; cover = e; }
        continue;
      }
      if (e.team === member.team) continue;
      if (canSee(gameState, member, e)) {
        if (intel) intel[e.id] = { x: e.x, y: e.y, atFrame: frameCount };
        if (d < nd) { nd = d; nearest = e; }
      }
    }
    // 节流清理过期/阵亡的报点，避免 long-run 里情报板无限膨胀
    if (intel && frameCount % 60 === 0) {
      for (const id in intel) {
        const rec = intel[id];
        const e = findEntityById(gameState, Number(id));
        if (!e || e.dead || frameCount - rec.atFrame > INTEL_TTL_FRAMES) delete intel[id];
      }
    }
    if (cover && cd <= 8 * 8 && agent.lastCoverId !== cover.id) {
      agent.lastCoverId = cover.id;
      agent.events.push('附近有' + cover.name + '，可贴到它背向来敌的一侧躲子弹（不要主动拆它）');
    }
    const nearDist = Math.sqrt(nd);
    if (nearest) {
      if (agent.lastContactId !== nearest.id) {
        agent.lastContactId = nearest.id;
        agent.lastContactFrame = frameCount;
        agent.events.push('发现敌方' + (nearest.isMember ? '成员' : '目标') + '：' + nearest.name +
          '（距离 ' + Math.round(nearDist) + ' 格）');
      }
    } else {
      agent.lastContactId = 0;
    }

    // 己方指挥所正在被攻击：自己没挨打也要回防（否则成员会眼睁睁看基地被拆）。
    // 每 30 帧（0.5 秒）查一次，命中后按 300 帧（5 秒）节流提示。
    if (frameCount - (agent.lastHqCheckFrame || -99999) > 30) {
      agent.lastHqCheckFrame = frameCount;
      const ownHq = findHQ(gameState, member.team);
      if (ownHq && ownHq.lastDamagedTimer > 0 && frameCount - (agent.lastHqAlertFrame || -99999) > 300) {
        agent.lastHqAlertFrame = frameCount;
        agent.events.push('我方指挥所正在被攻击，回防！');
      }
    }

    if (agent.events.length > EVENT_CAP) agent.events = agent.events.slice(-EVENT_CAP);
    if (agent.allyMsgs.length > MSG_CAP) agent.allyMsgs = agent.allyMsgs.slice(-MSG_CAP);
    if (agent.enemyMsgs.length > MSG_CAP) agent.enemyMsgs = agent.enemyMsgs.slice(-MSG_CAP);

    // 上帝命令执行完毕检测：命令行动一结束（不再有任何进行中的动作）就标记完成，
    // 供调度层在 LLM 冷却空档用脚本续接下一仗（执行完命令要有自主性，不能站桩）
    if (agent.commandActive && !member.boardTarget && !member.fleeTo && !member.attackTarget &&
        !member.attackMoveTarget && !member.guardPos &&
        !(member.path && member.path.length > 0 && member.pathIndex < member.path.length)) {
      agent.commandActive = false;
      agent.commandDoneFrame = frameCount;
    }
  }

  /** 选出一个触发原因（优先级最高者） */
  _pickTrigger(agent, member, gameState, frameCount) {
    const triggers = [];
    const budget = this.cfg.budget;

    // 上帝命令（点名或广播）：只看不取，真正发起调用时才消费，避免冷却期把命令吃掉
    const cmd = this.commandBus ? this.commandBus.peekFor(agent.spec.key) : null;
    if (cmd) {
      agent.pendingCommand = cmd;
      if (!agent.commandSeen || agent.commandSeen !== cmd.id) {
        agent.commandSeen = cmd.id;
        agent.events.push('收到上帝命令：' + cmd.text);
      }
      triggers.push('command');
    }

    if (frameCount - agent.lastHurtEventFrame <= 30) triggers.push('hurt');
    if (frameCount - (agent.lastHqAlertFrame || -99999) <= 30) triggers.push('hurt');
    if (agent.lowHpFlag) triggers.push('lowhp');
    if (agent.memoryTargetDown) { triggers.push('targetdown'); agent.memoryTargetDown = false; }
    if (agent.lastContactId && frameCount - agent.lastContactFrame <= 30) triggers.push('contact');

    // 队友消息 / 敌方喊话：需要满足喊话冷却才值得为此花钱
    const hasMsg = agent.allyMsgs.length > 0 || agent.enemyMsgs.length > 0;
    if (hasMsg && frameCount - agent.lastChatFrame >= budget.chatCooldownSec * FPS) triggers.push('chat');

    // 空闲：没有进行中的动作，且距上次决策超过空闲节拍
    const idleDue = !this._isBusy(member) &&
      frameCount - agent.lastCallFrame >= budget.idleIntervalSec * FPS;
    if (idleDue) triggers.push('idle');

    if (triggers.length === 0) return null;
    triggers.sort(function (a, b) { return TRIGGER_RANK[a] - TRIGGER_RANK[b]; });
    return triggers[0];
  }

  // ==================== LLM 调用 ====================

  _globalBudgetOk() {
    const budget = this.cfg.budget;
    const now = Date.now();
    this.callStamps = this.callStamps.filter(function (t) { return now - t < 60000; });
    if (budget.maxCallsPerMinute > 0 && this.callStamps.length >= budget.maxCallsPerMinute) return false;
    if (budget.maxTokensPerGame > 0 && this.totalTokens >= budget.maxTokensPerGame) return false;
    return true;
  }

  _callLLM(agent, member, gameState, frameCount, trigger) {
    const self = this;
    const auth = resolveMemberAuth(this.cfg, agent.spec.key);
    const board = this._boardFor(gameState, agent.spec.team);
    const ctx = {
      spec: agent.spec,
      board: board,
      humanTeam: session.humanTeam,
      frameCount: frameCount,
      // 上帝右键标记的目标：快照会置顶为「标记」来源，成员应优先攻击
      godTargetId: agent.godTargetId || 0,
      // 命令只取"本队"的：跨阵营绝不能看到上帝给对方下的指令
      lastCommand: this.commandBus ? this.commandBus.lastForTeam(agent.spec.team) : null,
      events: agent.events.slice(),
      allyMsgs: agent.allyMsgs.slice(),
      enemyMsgs: agent.enemyMsgs.slice(),
      currentAction: this._currentAction(gameState, agent, member, frameCount),
    };
    const snapshot = buildSnapshot(gameState, member, ctx);
    // 留痕：出问题时可以直接看"模型当时到底看到了什么"（也用于验证阵营情报隔离）
    agent.lastSnapshot = snapshot;
    const messages = [
      { role: 'system', content: buildSystemPrompt(agent.spec, session.humanTeam) },
      { role: 'user', content: snapshot },
    ];

    agent.inFlight = true;
    this.inFlight++;
    agent.lastCallFrame = frameCount;
    if (trigger === 'command') agent.lastCommandCallFrame = frameCount;
    // 本次调用的决策序号：响应晚到时若已有更新的决策（本地命令/更晚的调用），只收台词不覆盖行动
    const mySeq = (agent.callSeq = (agent.callSeq || 0) + 1);
    this.callStamps.push(Date.now());
    this.totalCalls++;
    agent.calls++;
    // 真正发起调用才消费命令：失败也会给出「通讯中断」的回应；文本先留存供失败后本地解析兜底
    let cmdText = null;
    if (trigger === 'command' && this.commandBus) {
      const taken = this.commandBus.takeFor(agent.spec.key);
      cmdText = taken ? taken.text : null;
      agent.pendingCommand = null;
    }

    chatOnce(this.cfg, auth, messages).then(function (res) {
      const parsed = parseDecision(res.text);
      if (!parsed.ok) {
        throw new Error('决策解析失败：' + parsed.error);
      }
      if (res.usage && typeof res.usage.total_tokens === 'number') {
        self.totalTokens += res.usage.total_tokens;
        agent.tokens += res.usage.total_tokens;
      }
      agent.consecutiveErrors = 0;
      if (agent.callSeq !== mySeq) {
        // 本调用在途时已有更新的决策（如本地命令当帧执行）：台词照常展示，行动不覆盖。
        // 喊话冷却用当前帧判断（旧 frameCount 会低估间隔、多放行广播）
        const nowFrame = self.memberSystem ? self.memberSystem.frameCount : frameCount;
        self._handleChat(agent, member, gameState, nowFrame, parsed.decision);
        self._clearMemory(agent, trigger);
        return;
      }
      agent.lastDecision = parsed.decision;
      agent.lastSay = parsed.decision.say;
      agent.currentIntent = parsed.decision.intent || '';
      self._applyDecision(agent, member, gameState, frameCount, parsed.decision);
      self._handleChat(agent, member, gameState, frameCount, parsed.decision);
      self._clearMemory(agent, trigger);
    }).catch(function (err) {
      agent.errors++;
      self.totalErrors++;
      agent.consecutiveErrors++;
      console.warn('[agents] ' + agent.spec.key + ' 调用失败：' + err.message);
      const msg = err.message || String(err);
      if (agent.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS && !agent.degraded) {
        agent.degraded = true;
        self.hooks.onNotify(agent.spec.name + ' 连续调用失败，已降级为脚本 AI（' + msg.slice(0, 40) + '）', 'warn');
      }
      if (agent.callSeq !== mySeq) {
        // 已有更新的决策接管，本次失败不再兜底（避免旧兜底覆盖新行动）
        self._clearMemory(agent, trigger);
        return;
      }
      // 命令失败先试本地解析兜底：让"撤退/回防"这类口令即使 LLM 挂了也能当帧执行
      if (trigger === 'command' && cmdText &&
          self._tryExecuteCommandLocal(agent, member, gameState, frameCount, cmdText)) {
        self._clearMemory(agent, trigger);
        return;
      }
      // 兜底：出错也要有动作，不能让成员站着不动
      self._applyFallback(agent, member, gameState, frameCount, trigger, true);
      if (trigger === 'command') {
        self.hooks.onChat({
          key: agent.spec.key,
          name: agent.spec.name,
          team: agent.spec.team,
          teamName: TEAM_NAMES[agent.spec.team],
          text: '（通讯中断，按既定战术行动）',
          to: null,
          at: Date.now(),
        });
      }
      self._clearMemory(agent, trigger);
    }).then(function () {
      agent.inFlight = false;
      self.inFlight = Math.max(0, self.inFlight - 1);
    });
  }

  _clearMemory(agent, trigger) {
    agent.events = [];
    if (trigger === 'chat') { agent.allyMsgs = []; agent.enemyMsgs = []; }
    if (trigger === 'command') agent.pendingCommand = null;
  }

  /**
   * 命令快车道的本地解析：把上帝自由文本直接翻译成决策并当帧执行（零 token）。
   * 覆盖不了的口令（太自由/太模糊）返回 false，由调用方转 LLM 快车道。
   * @param overrideText 传文本则直接解析该文本（LLM 失败后的兜底），不再从命令总线取。
   */
  _tryExecuteCommandLocal(agent, member, gameState, frameCount, overrideText) {
    const cmd = overrideText != null
      ? { text: overrideText }
      : (this.commandBus ? this.commandBus.peekFor(agent.spec.key) : null);
    if (!cmd || !cmd.text) return false;
    const parsed = parseGodCommand(gameState, member, cmd.text, {
      spec: agent.spec,
      board: this._boardFor(gameState, agent.spec.team),
      frameCount: frameCount,
    });
    if (!parsed || !parsed.matched) return false;

    // 消费命令并作废所有在途 LLM 调用：旧响应晚到后只收台词，不覆盖本次命令执行
    if (overrideText == null && this.commandBus) this.commandBus.takeFor(agent.spec.key);
    agent.pendingCommand = null;
    agent.lastCommandCallFrame = frameCount;
    agent.callSeq = (agent.callSeq || 0) + 1;

    if (parsed.ackOnly) {
      // 命令点的是别人：只应声，不改变自己行动
      agent.currentIntent = '听候指挥';
      this._clearMemory(agent, 'command');
      this._handleChat(agent, member, gameState, frameCount, { say: parsed.say || '收到。', to: null });
      return true;
    }
    const decision = parsed.decision;
    agent.lastDecision = decision;
    agent.lastSay = decision.say;
    agent.currentIntent = decision.intent;
    // 命令开始执行：记下"命令进行中"，行动结束后调度层会给一次脚本自主续接
    agent.commandActive = true;
    agent.commandDoneFrame = -99999;
    this._applyDecision(agent, member, gameState, frameCount, decision);
    this._clearMemory(agent, 'command');
    this._handleChat(agent, member, gameState, frameCount, decision);
    return true;
  }

  _boardFor(gameState, team) {
    const enemyTeam = team === TEAM_PLAYER ? 1 : 0;
    return {
      ownHq: findHQ(gameState, team),
      enemyHq: findHQ(gameState, enemyTeam),
    };
  }

  // ==================== 决策执行 ====================

  _applyFallback(agent, member, gameState, frameCount, trigger, force) {
    // 非强制路径要遵守决策冷却：否则低血/交战这类持续触发的状态会每帧重算路径
    if (!force && frameCount - agent.lastCallFrame < this.cfg.budget.decisionCooldownSec * FPS) return;
    const board = this._boardFor(gameState, agent.spec.team);
    const decision = fallbackDecide(gameState, member, { spec: agent.spec, board: board });
    agent.lastDecision = decision;
    agent.lastSay = decision.say;
    agent.currentIntent = decision.intent;
    agent.lastCallFrame = frameCount;   // 兜底也计入节拍，避免每帧重算
    this._applyDecision(agent, member, gameState, frameCount, decision);
    // 兜底的台词只做展示，且按喊话冷却节流，避免脚本模式刷屏
    const chatGap = this.cfg.budget.chatCooldownSec * FPS;
    if (frameCount - agent.lastFallbackLineFrame >= chatGap) {
      agent.lastFallbackLineFrame = frameCount;
      this._handleChat(agent, member, gameState, frameCount, decision);
    }
  }

  /**
   * 当前正在执行的动作快照（喂给模型，避免它"忘了自己在上一个命令里说要干嘛"）
   */
  _currentAction(gameState, agent, member, frameCount) {
    if (!agent.lastDecision) return null;
    const d = agent.lastDecision;
    const targetEnt = agent.currentOrderTargetId ? findEntityById(gameState, agent.currentOrderTargetId) : null;
    const remaining = (member.path && member.path.length > member.pathIndex)
      ? member.path.length - member.pathIndex : 0;
    return {
      动作: d.action,
      意图: d.intent || '',
      目标: targetEnt && !targetEnt.dead ? targetEnt.name : null,
      剩余路程: remaining,
      已持续秒: agent.lastApplyFrame ? Math.round((frameCount - agent.lastApplyFrame) / FPS) : 0,
      受阻: !!agent.actionBlocked,
    };
  }

  /** 记录"决策没能落实"：这是意图与行为脱节的直接证据，必须让模型和玩家都看见 */
  _noteBlocked(agent, why, frameCount) {
    agent.actionBlocked = true;
    agent.blockedCount = (agent.blockedCount || 0) + 1;
    const fc = typeof frameCount === 'number' ? frameCount : agent.lastApplyFrame || 0;
    if (fc - (agent.lastBlockedEventFrame || -9999) > 180) {
      agent.lastBlockedEventFrame = fc;
      agent.events.push('你的行动未能落实：' + why);
    }
  }

  _applyDecision(agent, member, gameState, frameCount, decision) {
    // 1) 武器切换
    if (decision.weapon && WEAPONS[decision.weapon]) {
      this.memberSystem.setWeapon(member, decision.weapon);
    }
    agent.lastApplyFrame = frameCount;
    agent.actionBlocked = false;
    member.fleeTo = null;   // 任何新决策都覆盖先前的"脱离"状态

    const action = decision.action;
    const target = decision.target;
    // 赶路类行动禁止途中自动接敌：否则"收到撤退/集合却恋战"会重演——
    // 引擎（UnitAI）只在 attack_move 上自动索敌，这里把赶路标记写回实体，到位后恢复正常迎敌
    member.noAutoAcquire = (action === 'move' || action === 'guard' || action === 'cover' ||
                            action === 'highground' || action === 'retreat');

    // 2) 目标实体解析（id 非法则退化为兜底，避免站着不动）
    let targetEntity = null;
    if (target && (target.类型 === 'unit' || target.类型 === 'building') && target.id != null) {
      targetEntity = findEntityById(gameState, target.id);
      if (!targetEntity || targetEntity.dead || targetEntity.team === member.team) {
        targetEntity = null;
      }
    }
    // 乘驾目标：己方空载具。上面的"敌方过滤"会把己方实体置空，
    // 必须在此单独解析，否则 board / move 指向载具 id 永远被判无效目标
    let mountTarget = null;
    if (target && target.id != null) {
      const cand = findEntityById(gameState, target.id);
      if (cand && !cand.dead && cand.isMount && cand.team === member.team) mountTarget = cand;
    }

    // 下车：无需目标，直接恢复步兵形态
    if (action === 'dismount') {
      if (member.mountType) {
        dismountVehicle(member);
        agent.currentOrderTargetId = 0;
        agent.currentIntent = '下车步行作战';
      } else {
        this._noteBlocked(agent, '当前未乘驾载具', frameCount);
      }
      return true;
    }

    if ((action === 'attack' || action === 'attack_move') && !targetEntity && !mountTarget && !(target && target.类型 === 'position')) {
      // 上帝命令的执行不许"偷换目标"：目标失效就如实报告，而不是顺手接敌（否则又成恋战）
      if (decision.fromCommand) {
        this._noteBlocked(agent, '目标无效', frameCount);
        return false;
      }
      const board = this._boardFor(gameState, agent.spec.team);
      const fb = fallbackDecide(gameState, member, { spec: agent.spec, board: board });
      this._noteBlocked(agent, '目标无效', frameCount);
      if (fb && fb.target) { return this._applyDecision(agent, member, gameState, frameCount, fb); }
      return false;
    }

    const map = gameState.map;
    const mx = Math.floor(member.x), my = Math.floor(member.y);

    // 目标是己方停放载具 → 走过去乘驾（获得载具装甲与火力）
    if (mountTarget && (action === 'board' || action === 'move' || action === 'attack_move' || action === 'attack')) {
      if (member.mountType) { this._noteBlocked(agent, '已在载具中，先 dismount', frameCount); return false; }
      const c = tileCenter(mountTarget);
      member.boardTarget = mountTarget;
      member.attackTarget = null;
      member.attackMoveTarget = null;
      member.guardPos = null;
      member.path = map.findPath(mx, my, c.x, c.y, 3000, member, true);
      member.pathIndex = 0;
      agent.currentOrderTargetId = 0;
      agent.currentIntent = '前往乘驾' + mountTarget.name;
      return true;
    }
    if (action === 'board') {
      this._noteBlocked(agent, '乘驾目标无效（非己方空载具）', frameCount);
      return false;
    }

    switch (action) {
      case 'attack':
        member.attackTarget = targetEntity;
        member.attackMoveTarget = null;
        member.guardPos = null;
        member.path = [];
        member.pathIndex = 0;
        member.burstRemaining = 0;
        agent.currentOrderTargetId = targetEntity ? targetEntity.id : 0;
        break;

      case 'attack_move': {
        const dest = targetEntity ? tileCenter(targetEntity) : { x: Math.round(target.x), y: Math.round(target.y) };
        member.attackTarget = targetEntity || null;
        member.attackMoveTarget = dest;
        member.guardPos = null;
        member.path = map.findPath(mx, my, dest.x, dest.y, 3000, member, true);
        member.pathIndex = 0;
        agent.currentOrderTargetId = targetEntity ? targetEntity.id : 0;
        break;
      }

      case 'move': {
        const dest = target && target.类型 === 'position'
          ? { x: Math.round(target.x), y: Math.round(target.y) }
          : (targetEntity ? tileCenter(targetEntity) : null);
        if (!dest) { this._noteBlocked(agent, '移动目标缺失', frameCount); return false; }
        member.attackTarget = null;
        member.attackMoveTarget = null;
        member.guardPos = null;
        member.path = map.findPath(mx, my, dest.x, dest.y, 3000, member, true);
        member.pathIndex = 0;
        agent.currentOrderTargetId = 0;
        break;
      }

      case 'retreat': {
        const board = this._boardFor(gameState, agent.spec.team);
        const hq = board.ownHq;
        const dest = hq ? tileCenter(hq) : (target && target.类型 === 'position' ? target : null);
        if (!dest) { this._noteBlocked(agent, '找不到己方指挥所', frameCount); return false; }
        member.attackTarget = null;
        member.attackMoveTarget = null;
        member.guardPos = null;
        member.burstRemaining = 0;
        member.burstTarget = null;
        member.fleeTo = { x: dest.x, y: dest.y };   // 纯脱离：赶回指挥所，不恋战
        member.path = map.findPath(mx, my, dest.x, dest.y, 3000, member, true);
        member.pathIndex = 0;
        agent.currentOrderTargetId = 0;
        break;
      }

      case 'hold':
        member.path = [];
        member.pathIndex = 0;
        member.attackTarget = null;
        member.attackMoveTarget = null;
        member.burstRemaining = 0;
        member.guardPos = { x: mx, y: my };
        agent.currentOrderTargetId = 0;
        break;

      case 'guard': {
        const board = this._boardFor(gameState, agent.spec.team);
        const hq = board.ownHq;
        const dest = target && target.类型 === 'position'
          ? { x: Math.round(target.x), y: Math.round(target.y) }
          : (hq ? tileCenter(hq) : { x: mx, y: my });
        member.attackTarget = null;
        member.attackMoveTarget = null;
        member.guardPos = { x: dest.x, y: dest.y };
        const far = Math.abs(dest.x - mx) + Math.abs(dest.y - my) > 5;
        member.path = far ? map.findPath(mx, my, dest.x, dest.y, 3000, member, true) : [];
        member.pathIndex = 0;
        agent.currentOrderTargetId = 0;
        break;
      }

      case 'cover':
      case 'highground': {
        // 坐标由班组黑板挑「队友没占」的战术位，模型只表达意图、不报数
        const squad = buildSquadBoard(gameState, member);
        const spot = action === 'cover' ? squad.cover : squad.highGround;
        if (!spot) {
          this._noteBlocked(agent, action === 'cover' ? '附近没有空闲沙袋阵地' : '附近没有空闲山顶观察位', frameCount);
          return false;
        }
        member.attackTarget = null;
        // 用 attackMoveTarget 而非 guardPos：赶路途中照打，找掩体不等于停止交火
        member.attackMoveTarget = { x: spot.x, y: spot.y };
        member.guardPos = null;
        member.path = map.findPath(mx, my, spot.x, spot.y, 3000, member, true);
        member.pathIndex = 0;
        agent.currentOrderTargetId = 0;
        break;
      }

      default:
        break;
    }

    // 3) 落实校验：行动类指令必须真的产生路径或锁定目标，否则就是"说了不做"
    let inEffect = true;
    if (action === 'attack') {
      inEffect = !!member.attackTarget;
      if (!inEffect) this._noteBlocked(agent, '没有可攻击的目标', frameCount);
    } else if (action === 'attack_move' || action === 'move' || action === 'retreat' || action === 'guard' ||
               action === 'cover' || action === 'highground') {
      const hasPath = member.path && member.path.length > member.pathIndex;
      const dest = member.attackMoveTarget || member.guardPos;
      const atDest = dest ? (Math.abs(dest.x - member.x) + Math.abs(dest.y - member.y) <= 2) : true;
      inEffect = hasPath || atDest;
      if (!inEffect) this._noteBlocked(agent, '路径不通（前方被阻挡）', frameCount);
    }
    agent.actionInEffect = inEffect;
    return inEffect;
  }

  // ==================== 喊话分发（阵营内协作 + 跨阵营喊话）====================

  _handleChat(agent, member, gameState, frameCount, decision) {
    if (!decision.say) return;
    const teamName = TEAM_NAMES[agent.spec.team];
    const deliverChat = decision.to !== null &&
      canDeliverShout(agent.lastChatFrame, frameCount, this.cfg.budget.chatCooldownSec);
    if (deliverChat) agent.lastChatFrame = frameCount;

    const msg = {
      key: agent.spec.key,
      name: agent.spec.name,
      team: agent.spec.team,
      teamName: teamName,
      text: decision.say,
      to: deliverChat ? decision.to : null,
      // 可见范围：阵营内喊话仅本方可见，跨阵营喊话双方可见（供 UI 标注与审计）
      audience: deliverChat ? (decision.to === '敌方' ? 'both' : (agent.spec.team === 0 ? 'blue' : 'red')) : 'self',
      at: Date.now(),
    };
    this.hooks.onChat(msg);

    // 战场气泡：让"成员在说话"这件事在上帝视角里可见
    const bubbleColor = decision.to === '敌方'
      ? '#f1c40f'
      : (agent.spec.team === TEAM_PLAYER ? '#7fc4ec' : '#ef8b7c');
    const prefix = decision.to === '敌方' ? '📣 ' : (decision.to === '队友' ? '💬 ' : '');
    gameState.addSpeech(member, prefix + decision.say, bubbleColor);

    if (!deliverChat) {
      this.chatCounts.self++;
      return;
    }
    if (decision.to === '队友') this.chatCounts.ally++;
    if (decision.to === '敌方') this.chatCounts.enemy++;
    this.shoutLog.push({
      key: agent.spec.key,
      name: agent.spec.name,
      team: agent.spec.team,
      to: decision.to,
      text: decision.say,
      at: Date.now(),
      // 发起决策的帧号（供验证喊话间隔；注意不是响应到达的帧号）
      frame: frameCount,
    });
    if (this.shoutLog.length > 40) this.shoutLog.shift();

    const line = agent.spec.name + '：' + decision.say;
    this.agents.forEach(function (other) {
      if (other === agent) return;
      if (decision.to === '队友' && other.spec.team === agent.spec.team) {
        other.allyMsgs.push(line);
      } else if (decision.to === '敌方' && other.spec.team !== agent.spec.team) {
        other.enemyMsgs.push(line);
      }
    });
  }

  // ==================== 快捷命令（结构化指令，不消耗 token）====================

  /**
   * 玩家点快捷按钮：直接下发给该阵营成员，不发起 LLM 调用。
   * 成员会「立刻执行 + 出一句台词」，等价于一次零成本决策。
   */
  applyQuickCommand(gameState, team, kind) {
    const self = this;
    const live = new Map();
    for (let i = 0; i < gameState.entities.length; i++) {
      const e = gameState.entities[i];
      if (e.isMember && !e.dead) live.set(e.memberKey, e);
    }
    let applied = 0;
    this.agents.forEach(function (agent) {
      if (agent.spec.team !== team) return;
      const member = live.get(agent.spec.key);
      if (!member) return;
      const board = self._boardFor(gameState, agent.spec.team);
      const decision = quickCommandDecision(kind, member, { spec: agent.spec, board: board, gameState: gameState });
      if (!decision) return;
      agent.lastDecision = decision;
      agent.lastSay = decision.say;
      agent.currentIntent = decision.intent;
      agent.events.push('收到快捷命令：' + decision.intent);
      self._applyDecision(agent, member, gameState, self.memberSystem.frameCount, decision);
      self.hooks.onChat({
        key: agent.spec.key,
        name: agent.spec.name,
        team: agent.spec.team,
        teamName: TEAM_NAMES[agent.spec.team],
        text: decision.say,
        to: null,
        at: Date.now(),
      });
      applied++;
    });
    return applied;
  }

  // ==================== 对外统计（HUD / 面板）====================

  /**
   * 上帝右键标记敌人：被选中的己方成员立即锁定并攻击该目标（零 token）；未指定作用域时回退全员。
   * 引擎层直接改 attackTarget 保证即时响应；godTargetId 喂给快照，
   * 让成员下一轮 LLM 决策也把这个目标当「标记」优先处理，而不是以"不在视野"为由拒绝。
   * @returns 受命成员数
   */
  markEnemy(gameState, targetEntity, scopeMembers) {
    if (!targetEntity || targetEntity.dead || targetEntity.aiIgnore) return 0;
    // scopeMembers：只命令被选中的成员（main 按选中集传入）；为空则回退全员
    const scoped = (Array.isArray(scopeMembers) && scopeMembers.length > 0)
      ? new Set(scopeMembers.map(function (m) { return m.memberKey; }).filter(Boolean))
      : null;
    let applied = 0;
    this.agents.forEach(function (agent) {
      if (agent.spec.team !== session.humanTeam) return;
      if (scoped && !scoped.has(agent.spec.key)) return;
      for (let i = 0; i < gameState.entities.length; i++) {
        const e = gameState.entities[i];
        if (!e.isMember || e.dead || e.memberKey !== agent.spec.key) continue;
        e.attackTarget = targetEntity;
        e.attackMoveTarget = null;
        e.guardPos = null;
        e.fleeTo = null;
        e.noAutoAcquire = false;   // 显式攻击命令：解除赶路标记，恢复交战
        e.path = [];
        e.pathIndex = 0;
        applied++;
      }
      agent.godTargetId = targetEntity.id;
      if (agent.events.length >= EVENT_CAP) agent.events = agent.events.slice(-(EVENT_CAP - 1));
      agent.events.push('上帝标记了「' + targetEntity.name + '」，立即攻击');
    });
    return applied;
  }

  stats() {
    const self = this;
    const perMember = [];
    this.agents.forEach(function (a) {
      perMember.push({
        key: a.spec.key,
        name: a.spec.name,
        team: a.spec.team,
        enabled: a.enabled,
        degraded: a.degraded,
        tokens: a.tokens,
        calls: a.calls,
        errors: a.errors,
        intent: a.currentIntent,
        lastSay: a.lastSay,
        inFlight: a.inFlight,
        actionBlocked: !!a.actionBlocked,
        blockedCount: a.blockedCount || 0,
        emergencyCalls: a.emergencyCalls || 0,
      });
    });
    return {
      llmReady: this.llmReady,
      budgetExceeded: this.budgetExceeded,
      totalTokens: this.totalTokens,
      totalCalls: this.totalCalls,
      totalErrors: this.totalErrors,
      inFlight: this.inFlight,
      chatCounts: { self: this.chatCounts.self, ally: this.chatCounts.ally, enemy: this.chatCounts.enemy },
      shoutLog: this.shoutLog.slice(-10),
      perMember: perMember,
    };
  }

  /** 超预算时由 update 之外的地方调用（保持单一入口，便于 UI 提示一次） */
  checkBudgetAndWarn(frameCount) {
    const caps = this.cfg && this.cfg.budget;
    if (!caps) return;
    if (caps.maxTokensPerGame > 0 && this.totalTokens >= caps.maxTokensPerGame && !this.budgetExceeded) {
      this.budgetExceeded = true;
      this.hooks.onNotify('已达每局 token 上限（' + this.totalTokens + '），成员降级为脚本 AI；点顶部「+5万额度」可继续', 'warn');
    }
  }

  /**
   * 调整每局 token 上限：追加额度时立刻解除降级，让成员在下一次触发就恢复 LLM
   * （激战正酣时被降级最扫兴，所以这里必须能把状态清干净）
   */
  setBudgetCap(newCap) {
    if (!this.cfg || !this.cfg.budget) return;
    this.cfg.budget.maxTokensPerGame = newCap;
    const wasExceeded = this.budgetExceeded;
    if (this.totalTokens < newCap) {
      this.budgetExceeded = false;
      // 因超限而"看起来降级"的成员同步复活
      this.agents.forEach(function (agent) {
        if (agent.degraded && agent.consecutiveErrors === 0) agent.degraded = false;
      });
    }
    return wasExceeded && !this.budgetExceeded;
  }

  /** 本局是否已彻底结束（供 UI 显示结算） */
  abortGame() {
    this.agents.forEach(function (a) { a.inFlight = false; });
    this.inFlight = 0;
  }
}
