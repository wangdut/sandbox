// 沙盘布景：40×40 对称战场，双指挥所对角相望
//
// 与基座的程序化随机地图不同，沙盘需要可复现的对称布景：
// 红方阵地在蓝方的中心对称点上，保证双方条件完全一致（公平 + 便于调试）。

import {
  MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, GRASS, CONCRETE, SAND, TREE, ROCK,
  TEAM_PLAYER, TEAM_ENEMY, FACTION_ALLIED, FACTION_SOVIET,
} from '../constants.js';
import { MEMBERS, createMember } from './memberDefs.js';

// 蓝方（左下）布局；红方由中心对称推导，确保绝对公平
const BLUE_LAYOUT = {
  base: { x: 7, y: 52 },
  pillbox: { x: 11, y: 51 },
  turret: { x: 9, y: 49 },
  members: [
    { key: 'blue_1', x: 7, y: 56 },
    { key: 'blue_2', x: 9, y: 56 },
  ],
};

// 树丛（掩体与视觉装饰）：按蓝方侧定义，红方镜像。只种在草地上，不会堵住主通路
const TREE_CLUMPS = [
  { x: 4, y: 8 }, { x: 13, y: 5 }, { x: 4, y: 24 }, { x: 22, y: 15 },
  { x: 31, y: 5 }, { x: 6, y: 40 }, { x: 15, y: 58 }, { x: 27, y: 45 },
];
// 岩石群（不可通行，作为天然掩体/绕行点）
const ROCK_CLUMPS = [
  { x: 18, y: 8 }, { x: 5, y: 33 }, { x: 24, y: 24 }, { x: 34, y: 16 },
];
// 沙地（占位视觉，不改变通行性）
const SAND_CLUMPS = [
  { x: 10, y: 16 }, { x: 21, y: 33 }, { x: 3, y: 46 }, { x: 30, y: 28 },
];

// 中心对称：size 为建筑占地边长（1 表示单格）
function mirror(p, size) {
  const s = size || 1;
  return { x: MAP_WIDTH - p.x - s, y: MAP_HEIGHT - p.y - s };
}

function fillTerrain(map) {
  for (let y = 0; y < MAP_HEIGHT; y++) {
    map.terrain[y] = [];
    map.oreAmount[y] = [];
    map.occupancy[y] = [];
    for (let x = 0; x < MAP_WIDTH; x++) {
      map.terrain[y][x] = GRASS;
      map.oreAmount[y][x] = 0;
      map.occupancy[y][x] = null;
    }
  }
}

/** 菱形点缀：只写在草地上，保证不会盖掉主通路与基地混凝土 */
function stampClump(map, center, terrain, size) {
  const r = size || 1;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > r) continue;
      const tx = center.x + dx, ty = center.y + dy;
      if (tx < 0 || tx >= MAP_WIDTH || ty < 0 || ty >= MAP_HEIGHT) continue;
      if (map.terrain[ty][tx] !== GRASS) continue;
      map.terrain[ty][tx] = terrain;
    }
  }
}

/** 撒装饰：树/岩石/沙地，蓝方侧定义 + 中心对称镜像（确定性，不随机） */
function decorate(map) {
  const mirrored = function (list) {
    return list.concat(list.map(function (c) { return mirror(c, 1); }));
  };
  mirrored(TREE_CLUMPS).forEach(function (c) { stampClump(map, c, TREE, 1); });
  mirrored(ROCK_CLUMPS).forEach(function (c) { stampClump(map, c, ROCK, 1); });
  mirrored(SAND_CLUMPS).forEach(function (c) { stampClump(map, c, SAND, 2); });
}

function setConcretePad(map, p, size) {
  const s = size || 1;
  for (let dy = -1; dy <= s; dy++) {
    for (let dx = -1; dx <= s; dx++) {
      const tx = p.x + dx, ty = p.y + dy;
      if (tx >= 0 && tx < MAP_WIDTH && ty >= 0 && ty < MAP_HEIGHT) map.terrain[ty][tx] = CONCRETE;
    }
  }
}

// 基地间的主通路：一条斜向的沙土路，指示进攻方向（纯视觉，不改变通行性）
function drawRoad(map) {
  const from = { x: BLUE_LAYOUT.base.x + 1, y: BLUE_LAYOUT.base.y + 1 };
  const to = mirror(BLUE_LAYOUT.base, 3);
  const goal = { x: to.x + 1, y: to.y + 1 };
  let x = from.x, y = from.y;
  const dx = Math.abs(goal.x - x), dy = Math.abs(goal.y - y);
  const sx = x < goal.x ? 1 : -1, sy = y < goal.y ? 1 : -1;
  let err = dx - dy;
  let guard = 0;
  while ((x !== goal.x || y !== goal.y) && guard++ < MAP_WIDTH * MAP_HEIGHT) {
    for (let o = 0; o <= 1; o++) {
      const tx = x + o, ty = y;
      if (tx >= 0 && tx < MAP_WIDTH && ty >= 0 && ty < MAP_HEIGHT && map.terrain[ty][tx] === GRASS) {
        map.terrain[ty][tx] = SAND;
      }
    }
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

function spawnStructures(gameState, layout, team, faction, flip) {
  const map = gameState.map;
  const basePos = flip ? mirror(layout.base, 3) : layout.base;
  const base = gameState.spawnEntity('base', team, basePos.x, basePos.y);
  base.built = true;
  base.buildProgress = 100;
  base.faction = faction;
  setConcretePad(map, basePos, 3);
  map.setOccupancy(base);

  ['pillbox', 'turret'].forEach(function (type) {
    const p = flip ? mirror(layout[type], 1) : layout[type];
    const b = gameState.spawnEntity(type, team, p.x, p.y);
    b.built = true;
    b.buildProgress = 100;
    b.faction = faction;
    setConcretePad(map, p, 1);
    map.setOccupancy(b);
  });

  return base;
}

function spawnMembers(gameState, layout, team, flip) {
  const specs = MEMBERS.filter(function (m) { return m.team === team; });
  specs.forEach(function (spec, idx) {
    const slot = layout.members[idx] || layout.members[0];
    const p = flip ? mirror(slot, 1) : slot;
    createMember(gameState, spec, p.x, p.y);
  });
}

/**
 * 构建沙盘场景：替换基座的 initPlayer/initEnemy
 * @param humanTeam 上帝玩家操控的队伍（0=蓝方 / 1=红方）——只影响"谁是我方"，双方布景始终对称
 */
export function buildSandboxScenario(gameState, humanTeam) {
  const map = gameState.map;
  gameState.humanTeam = humanTeam === 1 ? 1 : 0;
  fillTerrain(map);
  // 先铺路再撒装饰：装饰只落在草地上，因此主通路永不被树石堵住
  drawRoad(map);
  decorate(map);

  gameState.playerFaction = FACTION_ALLIED;
  gameState.enemyFaction = FACTION_SOVIET;
  // 极简对抗：无采矿无建造，资金恒为 0
  gameState.playerCredits = 0;
  gameState.enemyCredits = 0;

  const blueBase = spawnStructures(gameState, BLUE_LAYOUT, TEAM_PLAYER, FACTION_ALLIED, false);
  spawnMembers(gameState, BLUE_LAYOUT, TEAM_PLAYER, false);
  spawnStructures(gameState, BLUE_LAYOUT, TEAM_ENEMY, FACTION_SOVIET, true);
  spawnMembers(gameState, BLUE_LAYOUT, TEAM_ENEMY, true);

  map.recomputeRegions();
  map._oreDirty = true;
  gameState.rebuildDanger();   // 初始威胁网格（成员寻路要用）
  return { spawn: { x: blueBase.x, y: blueBase.y }, humanTeam: gameState.humanTeam };
}

/**
 * 取某方指挥所（重生点 / 胜负目标）
 */
export function findHQ(gameState, team) {
  for (let i = 0; i < gameState.entities.length; i++) {
    const e = gameState.entities[i];
    if (!e.dead && e.type === 'base' && e.team === team) return e;
  }
  return null;
}

/**
 * 在指挥所周围找最近的可通行落点（成员重生用）
 */
export function findRespawnSpot(gameState, hq) {
  const cx = Math.floor(hq.x) + hq.size / 2;
  const cy = Math.floor(hq.y) + hq.size / 2;
  let best = null, bestD = Infinity;
  for (let dy = -3; dy < hq.size + 3; dy++) {
    for (let dx = -3; dx < hq.size + 3; dx++) {
      const px = Math.floor(hq.x) + dx, py = Math.floor(hq.y) + dy;
      if (px < 0 || px >= MAP_WIDTH || py < 0 || py >= MAP_HEIGHT) continue;
      if (!gameState.map.isPassable(px, py)) continue;
      const d = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      if (d < bestD) { bestD = d; best = { x: px, y: py }; }
    }
  }
  return best || { x: Math.min(MAP_WIDTH - 1, Math.floor(hq.x)), y: Math.min(MAP_HEIGHT - 1, Math.floor(hq.y)) };
}

/**
 * 世界坐标 → 地图格（面板/AI 快照常用）
 */
export function worldToTile(wx, wy) {
  return { x: Math.floor(wx / TILE_SIZE), y: Math.floor(wy / TILE_SIZE) };
}
