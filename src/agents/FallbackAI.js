// 脚本兜底 AI：无 API / 解析失败 / 超预算 / 成员被关闭 LLM 时使用
//
// 产出与 LLM 完全相同的决策结构，便于 AgentManager 统一执行。
// 配合意识不依赖大模型：这里读的是与快照同一份班组黑板（集火、求援、空闲战术位、分工），
// 所以没有 API Key 时三个人照样会补火力、支援、分散、抢高地。

import { TEAM_NAMES, MAP_WIDTH, MAP_HEIGHT } from '../constants.js';
import { isAIAutoTargetable } from './targeting.js';
import { buildSquadBoard, onSandbag, onSummit } from './squadBoard.js';

const RETREAT_LINES = ['我先撤回去补血！', '撑不住了，回防！', '血量太低，撤！'];
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
    const d = (e.x - member.x) * (e.x - member.x) + (e.y - member.y) * (e.y - member.y);
    if (d < nd) { nd = d; nearest = e; }
  });
  if (nearest && nd < 14 * 14) {
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

export function teamName(team) {
  return TEAM_NAMES[team] || '未知';
}
