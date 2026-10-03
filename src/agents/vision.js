// 成员视野：大脑（LLM + 脚本兜底）能"看到"什么
//
// 与引擎的自动索敌（武器射程 getEnemiesInRange）不同，这里约束的是"决策依据"：
// 成员只能看到自己视野范围内的敌人（距离 + 视线），以及队友报点共享过来的远处情报。
// 视野远大于武器射程（射程最高约 8 格，视野 ≥ 10 格），保证"能打到的一定看得见"。
//
// 视线只挡岩石与占用中的建筑（高楼会截断视野），不挡水面与树林——
// 河面开阔、树林低矮，都是"看得过去"的地形。这与移动寻路的 hasLineOfSight
// （水面不可通行）语义不同，故单独实现。

import { MAP_WIDTH, MAP_HEIGHT, ROCK, FPS } from '../constants.js';
import { getMemberSpec } from '../sandbox/memberDefs.js';

export const SIGHT_BASE = 10;    // 步兵基础视野（格）
export const SIGHT_RECON = 12;   // 侦察手视野更远
export const SIGHT_MOUNT = 12;   // 乘驾载具后视野
export const SIGHT_AIR = 14;     // 空军视野最远
export const INTEL_TTL_FRAMES = 12 * FPS;   // 队友报点情报的保留时长（12 秒）

/** 成员的视野半径（格），按角色/载具/是否空中判定 */
export function sightRangeOf(member) {
  if (!member) return SIGHT_BASE;
  if (member.isAirUnit) return SIGHT_AIR;
  if (member.mountType) return SIGHT_MOUNT;
  const spec = member.memberKey ? getMemberSpec(member.memberKey) : null;
  if (spec && spec.role === 'recon') return SIGHT_RECON;
  return SIGHT_BASE;
}

/** 两点（格坐标）之间是否有视线：只挡 ROCK 与占用中的建筑 */
export function hasVisionLOS(map, x0, y0, x1, y1) {
  if (!map || !map.terrain) return true;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0, guard = 0;
  while ((x !== x1 || y !== y1) && guard++ < MAP_WIDTH * MAP_HEIGHT) {
    if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) return false;
    const row = map.terrain[y];
    if (row && row[x] === ROCK) return false;
    const occ = map.occupancy && map.occupancy[y] ? map.occupancy[y][x] : null;
    if (occ && occ.isBuilding && !occ.dead) return false;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return true;
}

/** 该成员能否看到目标实体：距离 ≤ 视野 + （非建筑需）视线可达 */
export function canSee(gameState, member, e) {
  if (!e || e.dead) return false;
  const r = sightRangeOf(member);
  const mx = member.x + (member.isBuilding ? member.size / 2 : 0.5);
  const my = member.y + (member.isBuilding ? member.size / 2 : 0.5);
  const ex = e.x + (e.isBuilding ? e.size / 2 : 0.5);
  const ey = e.y + (e.isBuilding ? e.size / 2 : 0.5);
  const dx = ex - mx, dy = ey - my;
  if (dx * dx + dy * dy > r * r) return false;
  // 大型建筑/工事在视野内即可知（且建筑格被自身占用，逐格视线会误判遮挡）
  if (e.isBuilding) return true;
  const map = gameState && gameState.map;
  if (!map || !map.terrain) return true;   // 无地图（单测假对象）不设视线门槛
  return hasVisionLOS(map, Math.floor(mx), Math.floor(my), Math.floor(ex), Math.floor(ey));
}
