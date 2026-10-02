// 虚拟成员定义：4 名成员的人设、初始武器与武器档案
//
// 成员是沙盘的核心单位——每名成员背后都是一个 LLM 智能体（见 agents/），
// 这里只描述「它是什么、能开什么火」，不涉及决策逻辑。

import { TEAM_PLAYER, TEAM_ENEMY, FACTION_ALLIED, FACTION_SOVIET } from '../constants.js';

// ==================== 武器档案 ====================
// 切换武器 = 整体覆盖单位的战斗参数（Entity 每帧直接读这些字段，
// 因此改完立刻生效，无需重建实体）。
export const WEAPONS = {
  mg: {
    key: 'mg', name: '机枪', icon: '🔫',
    damage: 14, range: 4.5, fireRate: 20,
    damageType: 'bullet', antiArmor: false, splashRadius: 0,
    desc: '射速快，专杀步兵；对建筑几乎无效',
  },
  rocket: {
    key: 'rocket', name: '火箭筒', icon: '🚀',
    damage: 60, range: 6, fireRate: 55,
    damageType: 'rocket', antiArmor: true, splashRadius: 0,
    desc: '拆建筑、破装甲的利器；射速慢',
  },
};

export const DEFAULT_WEAPON = 'mg';

// ==================== 成员名册 ====================
// persona 为 M2 提示词的基础人设，M1 仅用于面板展示。
export const MEMBERS = [
  {
    key: 'blue_1', name: '雷霆', team: TEAM_PLAYER, faction: FACTION_ALLIED, weapon: 'mg',
    persona: '蓝方突击手。直率勇猛，喜欢正面压制与抢攻，看不起拖泥带水。',
  },
  {
    key: 'blue_2', name: '寒鸦', team: TEAM_PLAYER, faction: FACTION_ALLIED, weapon: 'rocket',
    persona: '蓝方爆破手。冷静谨慎，擅长远程拆建筑，判断不利时会果断撤退保存实力。',
  },
  {
    key: 'red_1', name: '烈焰', team: TEAM_ENEMY, faction: FACTION_SOVIET, weapon: 'mg',
    persona: '红方突击手。暴躁好战，崇尚进攻，喜欢挑衅对手。',
  },
  {
    key: 'red_2', name: '夜枭', team: TEAM_ENEMY, faction: FACTION_SOVIET, weapon: 'rocket',
    persona: '红方爆破手。阴沉多疑，热衷心理战，常试图劝降蓝方成员。',
  },
];

export function getMemberSpec(key) {
  return MEMBERS.find(function (m) { return m.key === key; }) || null;
}

/**
 * 切换单位武器：把武器档案的战斗参数整体写到实体上
 */
export function applyWeapon(unit, mode) {
  const w = WEAPONS[mode];
  if (!unit || !w) return false;
  unit.weaponMode = w.key;
  unit.damage = w.damage;
  unit.range = w.range;
  unit.fireRate = w.fireRate;
  unit.damageType = w.damageType;
  unit.antiArmor = w.antiArmor;
  unit.splashRadius = w.splashRadius;
  return true;
}

/**
 * 按名册生成一名成员实体
 */
export function createMember(gameState, spec, x, y) {
  const e = gameState.spawnEntity('member', spec.team, x, y);
  e.faction = spec.faction;
  e.isMember = true;
  e.memberKey = spec.key;
  e.memberName = spec.name;
  e.name = spec.name;
  applyWeapon(e, spec.weapon || DEFAULT_WEAPON);
  return e;
}
