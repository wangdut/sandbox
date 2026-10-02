// AgentManager：4 名虚拟成员的大脑调度器
//
// 职责：
//   · 触发判定（收到上帝命令 / 受击 / 低血 / 发现敌人 / 目标被毁 / 队友喊话 / 空闲）
//   · 冷却与预算控制（每成员决策冷却、喊话冷却、每分钟调用上限、每局 token 上限）
//   · 一次调用同时拿到「台词 + 决策」，失败或超限时降级为脚本 AI
//   · 把决策翻译成引擎指令（寻路 / 锁定目标 / 切换武器 / 守卫）
//   · 阵营内协作与跨阵营喊话的消息分发

import { FPS, TEAM_PLAYER, TEAM_NAMES } from '../constants.js';
import { MEMBERS, WEAPONS } from '../sandbox/memberDefs.js';
import { findHQ } from '../sandbox/scenario.js';
import { buildSystemPrompt, buildSnapshot } from './prompts.js';
import { parseDecision } from './parser.js';
import { fallbackDecide, quickCommandDecision } from './FallbackAI.js';
import { chatOnce } from './LLMClient.js';
import { isAgentEnabled, resolveMemberAuth, isLLMReady } from './config.js';

const MAX_INFLIGHT = 3;          // 同时在途的 LLM 请求上限（避免瞬时打爆限流）
const CONTACT_RANGE = 10;        // 判定"发现敌人"的距离（格）
const EVENT_CAP = 8;
const MSG_CAP = 4;
const MAX_CONSECUTIVE_ERRORS = 3;

const TRIGGER_RANK = { command: 0, hurt: 1, lowhp: 2, targetdown: 3, contact: 4, chat: 5, idle: 6 };

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
        // 记忆
        events: [],
        allyMsgs: [],
        enemyMsgs: [],
        lastHp: null,
        lastHurtEventFrame: -99999,
        lastContactId: 0,
        lastContactFrame: -99999,
        lowHpFlag: false,
        pendingCommand: null,
        commandSeen: 0,
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
      return;
    }

    this._observe(agent, member, gameState, frameCount);

    const trigger = this._pickTrigger(agent, member, gameState, frameCount);
    if (!trigger) return;

    const canLLM = this.llmReady && agent.enabled && !agent.degraded && !this.budgetExceeded;
    const cooldownOk = frameCount - agent.lastCallFrame >= this.cfg.budget.decisionCooldownSec * FPS;

    if (canLLM) {
      // 有 LLM：排不上队（冷却/并发/限流）就等下一帧，绝不用脚本兜底抢答——
      // 否则付费拿到的战术会被脚本决策覆盖，还会刷屏
      if (!cooldownOk || agent.inFlight || this.inFlight >= MAX_INFLIGHT) return;
      if (!this._globalBudgetOk()) return;
      this._callLLM(agent, member, gameState, frameCount, trigger);
      return;
    }

    // 真正无 LLM（未配置 / 被关闭 / 已降级 / 超预算）才走兜底
    const humanTeam = agent.spec.team === TEAM_PLAYER;
    if (humanTeam && this._isBusy(member)) return;  // 不覆盖玩家鼠标下达的指令
    this._applyFallback(agent, member, gameState, frameCount, trigger);
  }

  _isBusy(member) {
    const hasPath = member.path && member.path.length > 0 && member.pathIndex < member.path.length;
    return !!(hasPath || member.attackTarget || member.attackMoveTarget || member.guardPos);
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

    // 发现敌人
    let nearest = null, nd = Infinity;
    const units = gameState.entities;
    for (let i = 0; i < units.length; i++) {
      const e = units[i];
      if (e.dead || e.team === member.team) continue;
      const dx = e.x - member.x, dy = e.y - member.y;
      const d = dx * dx + dy * dy;
      if (d < nd) { nd = d; nearest = e; }
    }
    const nearDist = Math.sqrt(nd);
    if (nearest && nearDist <= CONTACT_RANGE) {
      if (agent.lastContactId !== nearest.id) {
        agent.lastContactId = nearest.id;
        agent.lastContactFrame = frameCount;
        agent.events.push('发现敌方' + (nearest.isMember ? '成员' : '目标') + '：' + nearest.name +
          '（距离 ' + Math.round(nearDist) + ' 格）');
      }
    } else {
      agent.lastContactId = 0;
    }

    if (agent.events.length > EVENT_CAP) agent.events = agent.events.slice(-EVENT_CAP);
    if (agent.allyMsgs.length > MSG_CAP) agent.allyMsgs = agent.allyMsgs.slice(-MSG_CAP);
    if (agent.enemyMsgs.length > MSG_CAP) agent.enemyMsgs = agent.enemyMsgs.slice(-MSG_CAP);
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
      lastCommand: this.commandBus ? this.commandBus.lastForTeam(agent.spec.team) : null,
      events: agent.events.slice(),
      allyMsgs: agent.allyMsgs.slice(),
      enemyMsgs: agent.enemyMsgs.slice(),
    };
    const messages = [
      { role: 'system', content: buildSystemPrompt(agent.spec) },
      { role: 'user', content: buildSnapshot(gameState, member, ctx) },
    ];

    agent.inFlight = true;
    this.inFlight++;
    agent.lastCallFrame = frameCount;
    this.callStamps.push(Date.now());
    this.totalCalls++;
    agent.calls++;
    // 真正发起调用才消费命令：失败也会给出「通讯中断」的回应
    if (trigger === 'command' && this.commandBus) {
      this.commandBus.takeFor(agent.spec.key);
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

  _applyDecision(agent, member, gameState, frameCount, decision) {
    // 1) 武器切换
    if (decision.weapon && WEAPONS[decision.weapon]) {
      this.memberSystem.setWeapon(member, decision.weapon);
    }

    const action = decision.action;
    const target = decision.target;

    // 2) 目标实体解析（id 非法则退化为兜底，避免站着不动）
    let targetEntity = null;
    if (target && (target.类型 === 'unit' || target.类型 === 'building') && target.id != null) {
      targetEntity = findEntityById(gameState, target.id);
      if (!targetEntity || targetEntity.dead || targetEntity.team === member.team) {
        targetEntity = null;
      }
    }
    if ((action === 'attack' || action === 'attack_move') && !targetEntity && !(target && target.类型 === 'position')) {
      const board = this._boardFor(gameState, agent.spec.team);
      const fb = fallbackDecide(gameState, member, { spec: agent.spec, board: board });
      if (fb && fb.target) { return this._applyDecision(agent, member, gameState, frameCount, fb); }
      return;
    }

    const map = gameState.map;
    const mx = Math.floor(member.x), my = Math.floor(member.y);

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
        if (!dest) return;
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
        if (!dest) return;
        member.attackTarget = null;
        member.attackMoveTarget = null;
        member.path = map.findPath(mx, my, dest.x, dest.y, 3000, member, true);
        member.pathIndex = 0;
        member.guardPos = { x: dest.x, y: dest.y };
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

      default:
        break;
    }
  }

  // ==================== 喊话分发（阵营内协作 + 跨阵营喊话）====================

  _handleChat(agent, member, gameState, frameCount, decision) {
    if (!decision.say) return;
    const teamName = TEAM_NAMES[agent.spec.team];
    const deliverChat = decision.to !== null &&
      frameCount - agent.lastChatFrame >= this.cfg.budget.chatCooldownSec * FPS;
    if (deliverChat) agent.lastChatFrame = frameCount;

    const msg = {
      key: agent.spec.key,
      name: agent.spec.name,
      team: agent.spec.team,
      teamName: teamName,
      text: decision.say,
      to: deliverChat ? decision.to : null,
      at: Date.now(),
    };
    this.hooks.onChat(msg);

    if (!deliverChat) return;
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
      const decision = quickCommandDecision(kind, member, { spec: agent.spec, board: board });
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
      });
    });
    return {
      llmReady: this.llmReady,
      budgetExceeded: this.budgetExceeded,
      totalTokens: this.totalTokens,
      totalCalls: this.totalCalls,
      totalErrors: this.totalErrors,
      inFlight: this.inFlight,
      perMember: perMember,
    };
  }

  /** 超预算时由 update 之外的地方调用（保持单一入口，便于 UI 提示一次） */
  checkBudgetAndWarn(frameCount) {
    const caps = this.cfg && this.cfg.budget;
    if (!caps) return;
    if (caps.maxTokensPerGame > 0 && this.totalTokens >= caps.maxTokensPerGame && !this.budgetExceeded) {
      this.budgetExceeded = true;
      this.hooks.onNotify('已达每局 token 上限（' + this.totalTokens + '），成员降级为脚本 AI', 'warn');
    }
  }
}
