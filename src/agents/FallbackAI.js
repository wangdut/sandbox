// 脚本兜底 AI：无 API / 解析失败 / 超预算 / 成员被关闭 LLM 时使用
//
// 产出与 LLM 完全相同的决策结构，便于 AgentManager 统一执行。
// 配合意识不依赖大模型：这里读的是与快照同一份班组黑板（集火、求援、空闲战术位、分工），
// 所以没有 API Key 时三个人照样会补火力、支援、分散、抢高地。

import { TEAM_NAMES, MAP_WIDTH, MAP_HEIGHT } from '../constants.js';
import { isAIAutoTargetable } from './targeting.js';
import { buildSquadBoard, onSandbag, onSummit } from './squadBoard.js';
import { canSee } from './vision.js';
import { isRecovering } from '../sandbox/memberSystem.js';

const RETREAT_LINES = ['我先撤回去补血！', '撑不住了，回防！', '血量太低，撤！'];
const RECOVER_LINES = ['我在基地回血，好了再上。', '先回满血再出去打。', '躲回基地缓一缓。'];
const DEFEND_LINES = ['指挥所被打了，回防！', '家要没了，撤回来守！', '回去保指挥所！'];
const FIGHT_LINES = ['发现敌人，开火！', '交给我，打！', '有敌人，吃我一发！'];
const FOCUS_LINES = ['队友在集火，我补炮！', '一起打这个，先把它秒了！', '锁定同一个目标，开火！'];
const SUPPORT_LINES = ['顶住，我来支援！', '往我这边靠，交叉火力别扎堆！', '我绕过去帮你，别一个人冲！'];
const PUSH_LINES = ['继续推进！', '向敌方指挥所前进！', '掩护我，我上！'];
const HOLD_LINES = ['原地待命。', '收到，守着。'];
const BOARD_LINES = ['有载具，我上车打！', '我开坦克压上去！', '上车，碾过去！'];
const EJECT_LINES = ['车要爆了，弃车！', '弃车，步行撤！'];
const COVER_LINES = ['进沙袋阵地架枪，让他打不动我！', '找到掩体了，蹲住开火！', '我在沙袋后面，安全，能打！'];
const SCOUT_LINES = ['上山顶占观察位，射程更远我先报点！', '我占了山头，队友往前压，我看着。'];
const SUMMIT_HOLD_LINES = ['山顶观察位到手，正面来敌我全看见了，队友放心压上！', '我趴在山头盯着，射程占优，来一个点一个。'];
const COVER_HOLD_LINES = ['我卡住沙袋了，他的子弹打我不疼，你们从两侧绕！', '沙袋阵地守住，我在这吸火力，队友别挤过来。'];

function pick(arr, seed) {
  return arr[Math.abs(Math.floor(seed)) % arr.length];
}

function centerOf(e) {
  return { x: Math.floor(e.x + (e.isBuilding ? e.size / 2 : 0.5)), y: Math.floor(e.y + (e.isBuilding ? e.size / 2 : 0.5)) };
}

/** 最近的本方空闲载具（isMount=true 即无人乘驾；已被队友预定赶去的不再抢） */
function nearestFreeMount(gameState, member, maxDist) {
  let best = null, bd = maxDist * maxDist;
  gameState.entities.forEach(function (e) {
    if (e.dead || !e.isMount || e.team !== member.team) return;
    if (isClaimed(gameState, e, member)) return;
    const d = (e.x - member.x) * (e.x - member.x) + (e.y - member.y) * (e.y - member.y);
    if (d < bd) { bd = d; best = e; }
  });
  return best;
}

/** 载具是否已被其他成员预定（对方正走向它乘驾） */
function isClaimed(gameState, mount, member) {
  for (let i = 0; i < gameState.entities.length; i++) {
    const other = gameState.entities[i];
    if (other === member || other.dead || !other.isMember) continue;
    if (other.boardTarget === mount) return true;
  }
  return false;
}

/** 成员在本队内的稳定序号（按 id 排），用于给目标点分配扇形站位 */
function teamIndex(gameState, member) {
  let idx = 0;
  for (let i = 0; i < gameState.entities.length; i++) {
    const e = gameState.entities[i];
    if (e === member || e.dead || !e.isMember || e.team !== member.team) continue;
    if (e.id < member.id) idx++;
  }
  return idx;
}

// 推进/集合的目标点偏移：0 号走原点，其余散到两侧，避免三人叠在一格挨一发炮弹
const FAN = [[0, 0], [2, -2], [-2, 2], [3, 1], [-3, -1]];

/** 按序号给目标点加扇形偏移；偏移格越界或本单位走不到就顺延下一个偏移 */
function fanPoint(gameState, member, base) {
  const map = gameState.map;
  const idx = teamIndex(gameState, member);
  // 步长 3 与偏移数 5 互质：首选择格走不到时，各人的顺延顺序也不会撞在一起
  for (let k = 0; k < FAN.length; k++) {
    const off = FAN[(idx + k * 3) % FAN.length];
    const x = Math.round(base.x + off[0]), y = Math.round(base.y + off[1]);
    if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) continue;
    if (map && map.isPassableForUnit && !map.isPassableForUnit(x, y, member)) continue;
    return { x: x, y: y };
  }
  return { x: Math.round(base.x), y: Math.round(base.y) };
}

/** 是否已经站在自己那一份战术位上：侦察手占山顶，其余分工占沙袋阵地 */
function isOnOwnTacticalSpot(map, member, role) {
  if (!map) return false;
  return role === 'recon' ? onSummit(map, member) : onSandbag(map, member);
}

/**
 * @param ctx { spec, board:{ownHq, enemyHq} }
 */
export function fallbackDecide(gameState, member, ctx) {
  const seed = (member.id || 0) + Math.floor((member.x + member.y) * 7);
  const ownHq = ctx.board.ownHq;
  const enemyHq = ctx.board.enemyHq;
  const hpRatio = member.hp / member.maxHp;
  // 班组黑板：队友在打谁、谁在挨揍求援、哪些山顶/沙袋还没人占、自己该扮演什么角色
  const squad = buildSquadBoard(gameState, member);

  // 0) 载具快报废 → 弃车保命；附近有空车且受压/残血 → 先上车再打
  if (member.mountType && hpRatio < 0.25) {
    return {
      say: pick(EJECT_LINES, seed),
      to: null,
      action: 'dismount',
      target: null,
      weapon: 'mg',
      intent: '载具将毁，弃车保命',
    };
  }
  if (!member.mountType) {
    const m = nearestFreeMount(gameState, member, 8);
    const pressured = hpRatio < 0.6 || gameState.getEnemiesInRange(member, 14).length > 0;
    if (m && pressured) {
      return {
        say: pick(BOARD_LINES, seed),
        to: null,
        action: 'board',
        target: { 类型: 'unit', id: m.id },
        weapon: null,
        intent: '乘驾附近载具再战',
      };
    }
  }

  // 0.5) 回血重整：脱战 + 在基地附近 + 未回满七成 → 驻守回血，别带伤再冲出去
  if (isRecovering(gameState, member)) {
    return {
      say: pick(RECOVER_LINES, seed),
      to: null,
      action: 'hold',
      target: null,
      weapon: null,
      intent: '回血重整',
    };
  }

  // 0.6) 己方指挥所正在挨打且自己不在近处交火 → 回防（成员不能眼睁睁看家被拆）
  if (ownHq && ownHq.lastDamagedTimer > 0) {
    const hc = centerOf(ownHq);
    const far = (member.x - hc.x) * (member.x - hc.x) + (member.y - hc.y) * (member.y - hc.y) > 8 * 8;
    if (far && gameState.getEnemiesInRange(member, member.range).length === 0) {
      return {
        say: pick(DEFEND_LINES, seed),
        to: '队友',
        action: 'guard',
        target: { 类型: 'position', x: hc.x, y: hc.y },
        weapon: 'mg',
        intent: '回防指挥所',
      };
    }
  }

  // 1) 残血撤退回指挥所附近
  if (hpRatio < 0.35 && ownHq) {
    const c = centerOf(ownHq);
    return {
      say: pick(RETREAT_LINES, seed),
      to: null,
      action: 'retreat',
      target: { 类型: 'position', x: c.x, y: c.y },
      weapon: 'mg',
      intent: '撤回指挥所回血',
    };
  }

  // 1.5) 已占住自己该占的战术位、且近处有仗可打：就地守着伏击，不要下来重走一遍（否则会在"上去了→去推家→又上来"之间震荡）
  const onSpot = isOnOwnTacticalSpot(gameState.map, member, squad.role);
  if (onSpot && gameState.getEnemiesInRange(member, member.range + 8).length > 0) {
    const recon = squad.role === 'recon';
    return {
      say: pick(recon ? SUMMIT_HOLD_LINES : COVER_HOLD_LINES, seed),
      to: '队友',
      action: 'hold',
      target: null,
      weapon: 'mg',
      intent: recon ? '山顶观察并伏击' : '沙袋阵地坚守掩护',
    };
  }

  // 2) 射程内有敌人：队友已经在集火的那个优先补枪，其次打最近的
  const inRange = gameState.getEnemiesInRange(member, member.range);
  if (inRange.length > 0) {
    const focusEnt = squad.focus && inRange.indexOf(squad.focus.target) >= 0 ? squad.focus.target : null;
    let best = focusEnt, bd = Infinity;
    if (!best) {
      inRange.forEach(function (e) {
        const d = (e.x - member.x) * (e.x - member.x) + (e.y - member.y) * (e.y - member.y);
        if (d < bd) { bd = d; best = e; }
      });
    }
    const wantRocket = best.isBuilding || best.type2 === 'vehicle';
    return {
      say: focusEnt ? pick(FOCUS_LINES, seed) : pick(FIGHT_LINES, seed),
      to: null,
      action: 'attack',
      target: { 类型: 'unit', id: best.id },
      weapon: wantRocket ? 'rocket' : 'mg',
      intent: focusEnt ? '配合队友集火' : '攻击射程内目标',
    };
  }

  // 3) 队友残血且在交火：靠过去组成交叉火力，而不是各自往前冲
  if (squad.wounded) {
    const mate = squad.wounded.mate;
    const p = fanPoint(gameState, member, centerOf(mate));
    return {
      say: pick(SUPPORT_LINES, seed),
      to: '队友',
      action: 'attack_move',
      target: { 类型: 'position', x: p.x, y: p.y },
      weapon: 'mg',
      intent: '支援' + (mate.memberName || '队友') + '并拉开射界',
    };
  }

  // 4) 视野内最近的敌方成员/建筑：推过去打（中立高楼是掩体，不主动打）
  let nearest = null, nd = Infinity;
  gameState.entities.forEach(function (e) {
    if (!isAIAutoTargetable(e, member.team)) return;
    if (!canSee(gameState, member, e)) return;
    const d = (e.x - member.x) * (e.x - member.x) + (e.y - member.y) * (e.y - member.y);
    if (d < nd) { nd = d; nearest = e; }
  });
  if (nearest) {
    return {
      say: pick(PUSH_LINES, seed),
      to: null,
      action: 'attack_move',
      target: { 类型: 'unit', id: nearest.id },
      weapon: nearest.isBuilding ? 'rocket' : 'mg',
      intent: '接近并交战',
    };
  }

  // 5) 空闲时才抢战术位；已经站在上面的由 1.5 驻守分支处理，不再反复改派
  if (squad.role === 'recon') {
    if (!onSpot && squad.highGround && squad.highGround.dist <= 20) {
      return {
        say: pick(SCOUT_LINES, seed), to: '队友', action: 'highground',
        target: null, weapon: 'mg', intent: '占领山顶观察位报点',
      };
    }
  } else if (!onSpot && squad.cover && squad.cover.dist <= 14) {
    return {
      say: pick(COVER_LINES, seed), to: null, action: 'cover',
      target: null, weapon: 'mg', intent: '进沙袋阵地建火力点',
    };
  }

  // 6) 无事：朝敌方指挥所推进（拆家需要火箭筒；三人分三股压上，别挤在一格）
  if (enemyHq) {
    const p = fanPoint(gameState, member, centerOf(enemyHq));
    return {
      say: pick(PUSH_LINES, seed + 3),
      to: null,
      action: 'attack_move',
      target: { 类型: 'position', x: p.x, y: p.y },
      weapon: 'rocket',
      intent: '进攻敌方指挥所',
    };
  }

  return {
    say: pick(HOLD_LINES, seed),
    to: null,
    action: 'hold',
    target: null,
    weapon: null,
    intent: '原地待命',
  };
}

/** 快捷命令（不消耗 token）对应的直接指令 */
export function quickCommandDecision(kind, member, ctx) {
  const ownHq = ctx.board.ownHq;
  const enemyHq = ctx.board.enemyHq;
  const ownCenter = ownHq ? centerOf(ownHq) : { x: Math.floor(member.x), y: Math.floor(member.y) };
  const enemyCenter = enemyHq ? centerOf(enemyHq) : null;
  switch (kind) {
    case 'allAttack':
      return {
        say: '全体进攻！', to: null, action: enemyCenter ? 'attack_move' : 'hold',
        target: enemyHq ? { 类型: 'unit', id: enemyHq.id } : null,
        weapon: 'rocket', intent: '执行总攻命令',
      };
    case 'retreat':
      return {
        say: '收到，全体撤退！', to: null, action: 'retreat',
        target: { 类型: 'position', x: ownCenter.x, y: ownCenter.y },
        weapon: 'mg', intent: '执行撤退命令',
      };
    case 'defend':
      return {
        say: '明白，回防指挥所。', to: null, action: 'guard',
        target: { 类型: 'position', x: ownCenter.x, y: ownCenter.y },
        weapon: 'mg', intent: '执行防守命令',
      };
    case 'regroup': {
      const p = ctx.gameState ? fanPoint(ctx.gameState, member, ownCenter) : ownCenter;
      return {
        say: '集合！', to: null, action: 'move',
        target: { 类型: 'position', x: p.x, y: p.y },
        weapon: null, intent: '向指挥所集合',
      };
    }
    case 'mount': {
      if (member.mountType) {
        return { say: '我已经在载具里了。', to: null, action: 'hold', target: null, weapon: null, intent: '已在载具中' };
      }
      const gs = ctx.gameState;
      const m = gs ? nearestFreeMount(gs, member, 9999) : null;
      if (!m) {
        return { say: '附近没有可用载具。', to: null, action: 'hold', target: null, weapon: null, intent: '无载具可乘' };
      }
      return {
        say: '收到，上车！', to: null, action: 'board',
        target: { 类型: 'unit', id: m.id },
        weapon: null, intent: '乘驾最近空载具',
      };
    }
    case 'dismount':
      if (!member.mountType) {
        return { say: '我们没在车上。', to: null, action: 'hold', target: null, weapon: null, intent: '未乘驾' };
      }
      return {
        say: '下车展开！', to: null, action: 'dismount',
        target: null, weapon: 'mg', intent: '下车步行作战',
      };
    case 'cover':
    case 'highground': {
      const gs = ctx.gameState;
      const squad = gs ? buildSquadBoard(gs, member) : null;
      const spot = squad ? (kind === 'cover' ? squad.cover : squad.highGround) : null;
      const empty = kind === 'cover' ? '附近没有空闲沙袋阵地。' : '附近没有空闲山顶观察位。';
      if (!spot) {
        return { say: empty, to: null, action: 'hold', target: null, weapon: null, intent: '无可用战术位' };
      }
      const at = '（' + spot.x + ',' + spot.y + '）';
      return {
        say: (kind === 'cover' ? '收到，进沙袋工事' : '收到，占山顶观察位') + at,
        to: null, action: kind, target: null, weapon: 'mg',
        intent: kind === 'cover' ? '执行寻找掩体命令' : '执行抢占高地命令',
      };
    }
    default:
      return null;
  }
}

// ==================== 上帝自由文本命令的本地解析（零 token、当帧执行） ====================
//
// 上帝命令不必每次都去问 LLM：常见战术口令（撤退/回防/集合/找掩体/占高地/上车/下车/
// 停火/进攻/支援队友）在这里直接翻译成决策并当帧执行——这就是「以最快速度执行」的保证。
// 匹配不到的口令返回 matched:false，由 AgentManager 走命令快车道去问 LLM，保证口吻自然。
// 决策结构与 LLM 输出完全一致（另带 fromCommand 标记），供 _applyDecision 统一执行。

const CMD_ACK_LINES = ['收到。', '明白！', '收到，听候指示。'];
const CMD_LINES = {
  retreat: ['收到，立刻撤退！', '明白，撤！', '好，往回撤！'],
  guard: ['收到，回去守家！', '明白，回防指挥所！', '好，守住基地！'],
  regroup: ['收到，这就集合！', '明白，靠拢！', '好，过来了！'],
  cover: ['收到，进掩体！', '明白，找沙袋！', '好，隐蔽！'],
  highground: ['收到，占高地！', '明白，上山顶！', '好，抢制高点！'],
  board: ['收到，上车！', '明白，去开载具！', '好，装甲压上！'],
  dismount: ['收到，下车！', '明白，步行作战！', '好，弃车！'],
  hold: ['收到，停！', '明白，原地待命。', '好，停火。'],
  attack: ['收到，进攻！', '明白，上！', '好，打！'],
  support: ['收到，来支援！', '明白，这就去！', '好，掩护你！'],
};

// 口令关键词（两字起步，避免单字误伤："进攻"里含"攻"，但"守"不能单用）
const CMD_RE = {
  retreat: /撤退|后撤|撤回|退回来|快撤|别打了/,
  guard: /防守|回防|守卫|守家|保卫|护家|守住|死守/,
  regroup: /集合|靠拢|汇合|过来|归队/,
  cover: /掩体|沙袋|隐蔽|躲起来|躲一下/,
  highground: /高地|山顶|制高点|上山/,
  board: /上车|乘驾|驾驶|开坦克|开装甲|开载具/,
  dismount: /下车|步行|弃车/,
  hold: /待命|停火|停止攻击|别动|原地|停手|等待命令/,
  attack: /进攻|攻击|总攻|冲锋|推进|压上|集火|冲啊|上啊|打|拆|轰|炸|消灭|围殴|干掉/,
  support: /支援|掩护|帮助|跟(我|上|着)|救我/,
};

// 队友点名：支持全名（"蓝2号"）与简写（"2号"/"二号"）；"红2号"点的是敌方，不算点队友
const CN_NUM = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' };
function findNamedMate(mates, t) {
  const full = mates.find(function (e) { return e.memberName && t.indexOf(e.memberName) >= 0; });
  if (full) return full;
  if (!mates.length) return null;
  const enemyColor = mates[0].memberName && mates[0].memberName.charAt(0) === '蓝' ? '红' : '蓝';
  const re = /([一二三四五六七八九1-9])\s*号/g;
  let m;
  while ((m = re.exec(t))) {
    if (m.index > 0 && t.charAt(m.index - 1) === enemyColor) continue;  // "红2号"是敌方编号
    const num = /^\d+$/.test(m[1]) ? m[1] : CN_NUM[m[1]];
    const hit = mates.find(function (e) { return e.memberName && e.memberName.indexOf(num + '号') >= 0; });
    if (hit) return hit;
  }
  return null;
}

/** 按命令文本在敌方实体里找指名目标（最长名优先："打敌方指挥所"不会误配到别的楼） */
function findNamedEnemy(gameState, member, text) {
  const hits = [];
  gameState.entities.forEach(function (e) {
    if (e.dead || e.team === member.team || e.aiIgnore) return;
    const names = [e.name, e.memberName];
    if (e.isBuilding) {
      names.push('指挥所');
      if (e.category === 'defenses') names.push(e.type === 'pillbox' ? '碉堡' : '炮塔');
    }
    if (e.mountType === 'tank' || e.type2 === 'vehicle') names.push('坦克', '载具');
    if (e.mountType === 'apc') names.push('装甲车', '载具');
    if (e.isAirUnit) names.push('飞机', '载具');
    if (e.mountType === 'gunship') names.push('炮艇机');
    if (e.mountType === 'bomber') names.push('轰炸机');
    names.forEach(function (n) {
      if (n && text.indexOf(n) >= 0) hits.push({ e: e, len: String(n).length });
    });
  });
  if (!hits.length) return null;
  hits.sort(function (a, b) { return b.len - a.len; });
  return hits[0].e;
}

/** 决策骨架：与 LLM 输出同构，另带 fromCommand 标记供执行层识别 */
function cmdDecision(say, action, target, weapon, intent, to) {
  return { matched: true, decision: { say: say, to: to || null, action: action, target: target, weapon: weapon || null, intent: intent, fromCommand: true } };
}

/**
 * 解析上帝自由文本命令 → 决策（零 token）。
 * @param ctx { spec, board:{ownHq, enemyHq}, frameCount? }
 * @returns {matched:false} | {matched:true, decision} | {matched:true, ackOnly:true, say}
 *   matched:false 表示该口令本解析器不认识，需交给 LLM 快车道。
 */
export function parseGodCommand(gameState, member, text, ctx) {
  if (!text) return { matched: false };
  const t = String(text).trim();
  if (!t) return { matched: false };
  const board = ctx.board || {};
  const seed = (member.id || 0) + (ctx.frameCount || 0);
  const ownHq = board.ownHq;
  const enemyHq = board.enemyHq;
  const ownCenter = ownHq ? centerOf(ownHq) : { x: Math.floor(member.x), y: Math.floor(member.y) };

  // 本队队友（除自己）
  let mates = [];
  gameState.entities.forEach(function (e) {
    if (e.isMember && !e.dead && e.team === member.team && e !== member) mates.push(e);
  });
  const mateNamed = findNamedMate(mates, t);

  // 1) "掩护蓝2号"类：听者去支援被点名的队友（不是被点名者自己去执行）
  if (CMD_RE.support.test(t) && mateNamed) {
    const p = fanPoint(gameState, member, centerOf(mateNamed));
    return cmdDecision(pick(CMD_LINES.support, seed), 'move', { 类型: 'position', x: p.x, y: p.y },
      null, '执行命令：支援' + mateNamed.memberName, '队友');
  }

  // 2) 点名了其他成员（如"蓝2号 撤退"）：被点名的执行，其他人只应声、不越权
  if (mateNamed) {
    return { matched: true, ackOnly: true, say: pick(CMD_ACK_LINES, seed) };
  }

  // 3) 撤退/脱离：纯赶路回指挥所（fleeTo 通路，不恋战不还手）
  if (CMD_RE.retreat.test(t)) {
    return cmdDecision(pick(CMD_LINES.retreat, seed), 'retreat', { 类型: 'position', x: ownCenter.x, y: ownCenter.y },
      'mg', '执行命令：撤退');
  }
  // 4) 回防/守家
  if (CMD_RE.guard.test(t)) {
    return cmdDecision(pick(CMD_LINES.guard, seed), 'guard', { 类型: 'position', x: ownCenter.x, y: ownCenter.y },
      'mg', '执行命令：回防');
  }
  // 5) 集合/靠拢
  if (CMD_RE.regroup.test(t)) {
    const p = fanPoint(gameState, member, ownCenter);
    return cmdDecision(pick(CMD_LINES.regroup, seed), 'move', { 类型: 'position', x: p.x, y: p.y },
      null, '执行命令：集合');
  }
  // 6) 找掩体 / 占高地（坐标由班组黑板挑，模型/解析器都只表达意图）
  if (CMD_RE.cover.test(t)) {
    return cmdDecision(pick(CMD_LINES.cover, seed), 'cover', null, 'mg', '执行命令：进掩体');
  }
  if (CMD_RE.highground.test(t)) {
    return cmdDecision(pick(CMD_LINES.highground, seed), 'highground', null, 'mg', '执行命令：占高地');
  }
  // 7) 上车 / 下车
  if (CMD_RE.board.test(t)) {
    if (member.mountType) {
      return cmdDecision('我已经在载具里了。', 'hold', null, null, '已在载具中');
    }
    const m = nearestFreeMount(gameState, member, 9999);
    if (!m) return cmdDecision('附近没有可用载具。', 'hold', null, null, '无载具可乘');
    return cmdDecision(pick(CMD_LINES.board, seed), 'board', { 类型: 'unit', id: m.id }, null, '执行命令：乘驾载具');
  }
  if (CMD_RE.dismount.test(t)) {
    if (!member.mountType) return cmdDecision('我们没在车上。', 'hold', null, null, '未乘驾');
    return cmdDecision(pick(CMD_LINES.dismount, seed), 'dismount', null, 'mg', '执行命令：下车');
  }
  // 8) 停火/待命
  if (CMD_RE.hold.test(t)) {
    return cmdDecision(pick(CMD_LINES.hold, seed), 'hold', null, null, '执行命令：待命');
  }
  // 9) 进攻/攻击：能指名就打指名的目标，否则推进敌方指挥所
  if (CMD_RE.attack.test(t)) {
    const named = findNamedEnemy(gameState, member, t);
    if (named) {
      const heavy = named.isBuilding || named.mountType || named.type2 === 'vehicle';
      return cmdDecision(pick(CMD_LINES.attack, seed), 'attack_move',
        { 类型: named.isBuilding ? 'building' : 'unit', id: named.id },
        heavy ? 'rocket' : 'mg', '执行命令：攻击' + (named.memberName || named.name));
    }
    if (enemyHq) {
      return cmdDecision(pick(CMD_LINES.attack, seed), 'attack_move', { 类型: 'building', id: enemyHq.id },
        'rocket', '执行命令：总攻敌方指挥所');
    }
    return cmdDecision(pick(CMD_LINES.attack, seed), 'hold', null, null, '没有可进攻的目标');
  }
  // 10) 支援但没有点名：去找最近残血/最近的队友
  if (CMD_RE.support.test(t)) {
    let best = null, bestScore = Infinity;
    mates.forEach(function (e) {
      const d = (e.x - member.x) * (e.x - member.x) + (e.y - member.y) * (e.y - member.y);
      const score = d + (e.hp < e.maxHp * 0.7 ? -10000 : 0);
      if (score < bestScore) { bestScore = score; best = e; }
    });
    if (best) {
      const p = fanPoint(gameState, member, centerOf(best));
      return cmdDecision(pick(CMD_LINES.support, seed), 'move', { 类型: 'position', x: p.x, y: p.y },
        null, '执行命令：支援' + best.memberName, '队友');
    }
    return cmdDecision('我这边没有队友可支援。', 'hold', null, null, '无人可支援');
  }

  return { matched: false };
}

export function teamName(team) {
  return TEAM_NAMES[team] || '未知';
}
