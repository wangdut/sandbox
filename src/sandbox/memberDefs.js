// 虚拟成员定义：4 名成员的人设、初始武器与武器档案
//
// 成员是沙盘的核心单位——每名成员背后都是一个 LLM 智能体（见 agents/），
// 这里只描述「它是什么、能开什么火」，不涉及决策逻辑。

import { TEAM_PLAYER, TEAM_ENEMY, FACTION_ALLIED, FACTION_SOVIET, TYPE_AIRCRAFT, TYPE_HELICOPTER, TYPE_AIRSHIP } from '../constants.js';
import { UNIT_DEFS } from '../definitions.js';

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
    antiAir: true,   // 可对空，克制敌方炮艇机
    desc: '拆建筑、破装甲、可对空；射速慢',
  },
};

export const DEFAULT_WEAPON = 'mg';

// ==================== 成员名册 ====================
// persona 为提示词的基础人设。每阵营 3 名，共 6 名。
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
    key: 'blue_3', name: '孤星', team: TEAM_PLAYER, faction: FACTION_ALLIED, weapon: 'mg',
    persona: '蓝方侦察手。机敏多谋，喜欢迂回牵制、给队友报点，从不恋战。',
  },
  {
    key: 'red_1', name: '烈焰', team: TEAM_ENEMY, faction: FACTION_SOVIET, weapon: 'mg',
    persona: '红方突击手。暴躁好战，崇尚进攻，喜欢挑衅对手。',
  },
  {
    key: 'red_2', name: '夜枭', team: TEAM_ENEMY, faction: FACTION_SOVIET, weapon: 'rocket',
    persona: '红方爆破手。阴沉多疑，热衷心理战，常试图劝降蓝方成员。',
  },
  {
    key: 'red_3', name: '赤潮', team: TEAM_ENEMY, faction: FACTION_SOVIET, weapon: 'rocket',
    persona: '红方重装兵。火力至上，信奉正面强攻，会主动找重武器用。',
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
  unit.antiAir = !!w.antiAir;
  return true;
}

/**
 * 按名册生成一名成员实体
 */
export function createMember(gameState, spec, x, y) {
  const e = gameState.spawnEntity('member', spec.team, x, y);
  e.faction = spec.faction;
  e.isMember = true;
  e.avoidDanger = true;   // 成员寻路会规避敌方碉堡/炮塔射程
  e.memberKey = spec.key;
  e.memberName = spec.name;
  e.name = spec.name;
  applyWeapon(e, spec.weapon || DEFAULT_WEAPON);
  return e;
}

/**
 * 成员乘驾载具：把成员实体"变身"成载具（保留大脑与姓名），武器切换暂时由载具接管。
 * 载具被打爆 → 成员阵亡 → 30 秒后按步兵重生。
 */
export function boardVehicle(member, mountEntity) {
  const def = UNIT_DEFS[mountEntity.type];
  if (!member || !def || !def.mount) return false;
  member.mountType = mountEntity.type;
  member.isMount = false;
  member.maxHp = def.hp;
  member.hp = def.hp;
  member.speed = def.speed;
  member.damage = def.damage;
  member.range = def.range;
  member.fireRate = def.fireRate;
  member.damageType = def.damageType;
  member.armorType = def.armorType || 'medium';
  member.splashRadius = def.splashRadius || 0;
  member.antiAir = !!def.antiAir;
  member.antiArmor = false;
  member.type2 = def.type;
  member.size = def.size || 1;
  member.isAirUnit = def.type === TYPE_AIRCRAFT || def.type === TYPE_HELICOPTER || def.type === TYPE_AIRSHIP;
  member.path = [];
  member.pathIndex = 0;
  member.attackTarget = null;
  member.attackMoveTarget = null;
  member.guardPos = null;
  member.boardTarget = null;
  member.fireCooldown = Math.floor(Math.random() * 10);
  return true;
}

/** 成员离开载具，恢复步兵形态（保留血量比例与当前步兵武器） */
export function dismountVehicle(member) {
  if (!member || !member.mountType) return false;
  const ratio = member.hp / member.maxHp;
  const inf = UNIT_DEFS.member;
  member.mountType = null;
  member.maxHp = inf.hp;
  member.hp = Math.max(1, Math.round(inf.hp * ratio));
  member.speed = inf.speed;
  member.type2 = inf.type;
  member.size = 1;
  member.isAirUnit = false;
  member.antiAir = false;
  member.splashRadius = 0;
  member.armorType = 'none';
  applyWeapon(member, member.weaponMode || DEFAULT_WEAPON);
  member.path = [];
  member.pathIndex = 0;
  member.attackTarget = null;
  member.attackMoveTarget = null;
  member.guardPos = null;
  return true;
}
