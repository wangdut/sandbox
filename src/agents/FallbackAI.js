// 脚本兜底 AI：无 API / 解析失败 / 超预算 / 成员被关闭 LLM 时使用
//
// 产出与 LLM 完全相同的决策结构，便于 AgentManager 统一执行。
// 行为刻意简单：低血撤退 → 打最近敌人 → 否则推进敌方指挥所。

import { TEAM_NAMES } from '../constants.js';

const RETREAT_LINES = ['我先撤回去补血！', '撑不住了，回防！', '血量太低，撤！'];
const FIGHT_LINES = ['发现敌人，开火！', '交给我，打！', '有敌人，吃我一发！'];
const PUSH_LINES = ['继续推进！', '向敌方指挥所前进！', '掩护我，我上！'];
const HOLD_LINES = ['原地待命。', '收到，守着。'];
const BOARD_LINES = ['有载具，我上车打！', '我开坦克压上去！', '上车，碾过去！'];
const EJECT_LINES = ['车要爆了，弃车！', '弃车，步行撤！'];

function pick(arr, seed) {
  return arr[Math.abs(Math.floor(seed)) % arr.length];
}

function centerOf(e) {
  return { x: Math.floor(e.x + (e.isBuilding ? e.size / 2 : 0.5)), y: Math.floor(e.y + (e.isBuilding ? e.size / 2 : 0.5)) };
}

/** 最近的本方空闲载具（isMount=true 即无人乘驾） */
function nearestFreeMount(gameState, member, maxDist) {
  let best = null, bd = maxDist * maxDist;
  gameState.entities.forEach(function (e) {
    if (e.dead || !e.isMount || e.team !== member.team) return;
    const d = (e.x - member.x) * (e.x - member.x) + (e.y - member.y) * (e.y - member.y);
    if (d < bd) { bd = d; best = e; }
  });
  return best;
}

/**
 * @param ctx { spec, board:{ownHq, enemyHq} }
 */
export function fallbackDecide(gameState, member, ctx) {
  const seed = (member.id || 0) + Math.floor((member.x + member.y) * 7);
  const ownHq = ctx.board.ownHq;
  const enemyHq = ctx.board.enemyHq;
  const hpRatio = member.hp / member.maxHp;

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

  // 2) 射程内有敌人：直接打（建筑/装甲换火箭筒，步兵用机枪）
  const inRange = gameState.getEnemiesInRange(member, member.range);
  if (inRange.length > 0) {
    let best = inRange[0], bd = Infinity;
    inRange.forEach(function (e) {
      const d = (e.x - member.x) * (e.x - member.x) + (e.y - member.y) * (e.y - member.y);
      if (d < bd) { bd = d; best = e; }
    });
    const wantRocket = best.isBuilding || best.type2 === 'vehicle';
    return {
      say: pick(FIGHT_LINES, seed),
      to: null,
      action: 'attack',
      target: { 类型: 'unit', id: best.id },
      weapon: wantRocket ? 'rocket' : 'mg',
      intent: '攻击射程内目标',
    };
  }

  // 3) 视野内最近的敌方成员/建筑：推过去打
  let nearest = null, nd = Infinity;
  gameState.entities.forEach(function (e) {
    if (e.dead || e.team === member.team) return;
    const d = (e.x - member.x) * (e.x - member.x) + (e.y - member.y) * (e.y - member.y);
    if (d < nd) { nd = d; nearest = e; }
  });
  if (nearest && nd < 14 * 14) {
    const c = centerOf(nearest);
    return {
      say: pick(PUSH_LINES, seed),
      to: null,
      action: 'attack_move',
      target: { 类型: 'unit', id: nearest.id },
      weapon: nearest.isBuilding ? 'rocket' : (nearest.isMember ? 'mg' : 'mg'),
      intent: '接近并交战',
    };
  }

  // 4) 无事：朝敌方指挥所推进（拆家需要火箭筒）
  if (enemyHq) {
    return {
      say: pick(PUSH_LINES, seed + 3),
      to: null,
      action: 'attack_move',
      target: { 类型: 'unit', id: enemyHq.id },
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
    case 'regroup':
      return {
        say: '集合！', to: null, action: 'move',
        target: { 类型: 'position', x: ownCenter.x, y: ownCenter.y },
        weapon: null, intent: '向指挥所集合',
      };
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
    default:
      return null;
  }
}

export function teamName(team) {
  return TEAM_NAMES[team] || '未知';
}
