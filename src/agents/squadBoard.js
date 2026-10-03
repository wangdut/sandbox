// 班组协同黑板：零 token 的本地共享态势，同时喂给 LLM 快照与脚本兜底 AI
//
// 三名成员要"有配合意识"，前提是它们看得见彼此的意图。成员之间直接通信太贵，
// 所以这里把「队友在做什么、谁在集火哪个目标、哪些战术位还空着、按人设该怎么分工」
// 压成几行短字段随快照发出；兜底 AI 读的是同一份数据，保证无 Key 时也会配合。
//
// 战术位（山顶/沙袋）用"队友已站/已走向"当作占用标记，不额外维护预定表：
// 人一走开位置自然释放，不会出现成员阵亡后格子被永久锁死。

import { MAP_WIDTH, MAP_HEIGHT, HILL_TOP, SANDBAG } from '../constants.js';
import { getMemberSpec } from '../sandbox/memberDefs.js';
import { isAIAutoTargetable } from './targeting.js';

const FOCUS_MIN = 2;         // 含自己在内，≥2 人锁定同一目标才叫"集火"
const CLAIM_RADIUS = 2.5;    // 队友站/走到战术位这个距离内，就视为已被预定
const SUPPORT_HP = 0.55;     // 队友血量低于此比例且正在交战 → 前去支援
const SUPPORT_RANGE = 16;    // 超过这个距离就不值得跨半个地图去救

export const ROLE_NAMES = { assault: '突击手', demolition: '爆破手', recon: '侦察手', heavy: '重装兵' };

/** 各分工的标准动作：写进快照，也直接驱动兜底 AI 的选位偏好 */
export const ROLE_DOCTRINE = {
  assault: '正面压上，占最近的沙袋阵地建火力点，替队友吃掉直射火力',
  demolition: '躲在掩体后远程点名敌方载具与建筑，绝不贴脸',
  recon: '绕到空闲山顶做观察位（射程与伤害都有加成），先报点再开火',
  heavy: '跟着突击手正面推进，与队友集火同一个目标',
};

/** 地形在地图生成后不再变化，战术格按 map 对象记忆化一次即可，避免每次扫 4096 格 */
const reliefMemo = new WeakMap();
export function reliefTiles(map) {
  let r = reliefMemo.get(map);
  if (r) return r;
  r = { summits: [], posts: [] };
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      const t = map.terrain[y][x];
      if (t === HILL_TOP) r.summits.push({ x: x, y: y });
      else if (t === SANDBAG) r.posts.push({ x: x, y: y });
    }
  }
  reliefMemo.set(map, r);
  return r;
}

export function roleOf(member) {
  const spec = getMemberSpec(member.memberKey);
  return (spec && spec.role) || 'assault';
}

/** 单位脚下地形枚举（实体坐标以「格」为单位）；越界返回 null */
export function tileUnder(map, e) {
  if (!map || !map.terrain) return null;
  const tx = Math.floor(e.x), ty = Math.floor(e.y);
  if (tx < 0 || ty < 0 || tx >= MAP_WIDTH || ty >= MAP_HEIGHT) return null;
  const row = map.terrain[ty];
  return row ? row[tx] : null;
}

export function onSandbag(map, e) {
  return tileUnder(map, e) === SANDBAG;
}

export function onSummit(map, e) {
  return tileUnder(map, e) === HILL_TOP;
}

function tileDist(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function liveMates(gameState, member) {
  const out = [];
  for (let i = 0; i < gameState.entities.length; i++) {
    const e = gameState.entities[i];
    if (e === member || e.dead || !e.isMember || e.team !== member.team) continue;
    out.push(e);
  }
  return out;
}

/** 本队锁定同一目标人数最多、且达到 FOCUS_MIN 的那个敌方实体 */
function findFocus(gameState, member, mates) {
  const counts = new Map();
  const consider = function (e) {
    if (!e || !isAIAutoTargetable(e, member.team)) return;
    const rec = counts.get(e.id) || { e: e, n: 0 };
    rec.n++;
    counts.set(e.id, rec);
  };
  consider(member.attackTarget);
  for (let i = 0; i < mates.length; i++) consider(mates[i].attackTarget);
  let best = null;
  counts.forEach(function (rec) {
    if (rec.n < FOCUS_MIN) return;
    if (!best || rec.n > best.count) best = { target: rec.e, count: rec.n };
  });
  return best;
}

/** 战术位是否还空着：没被实体占住，且没有队友正站在上面或朝它走 */
function tileFree(map, tile, mates) {
  const occ = map.occupancy[tile.y] && map.occupancy[tile.y][tile.x];
  if (occ && !occ.dead) return false;
  for (let i = 0; i < mates.length; i++) {
    const m = mates[i];
    if (tileDist(m.x, m.y, tile.x + 0.5, tile.y + 0.5) <= CLAIM_RADIUS) return false;
    const path = m.path;
    if (path && path.length) {
      const end = path[path.length - 1];
      if (end && Math.abs(end.x - tile.x) <= 1 && Math.abs(end.y - tile.y) <= 1) return false;
    }
  }
  return true;
}

function nearestFreeTile(gameState, from, list, mates) {
  const map = gameState.map;
  if (!map) return null;
  let best = null, bd = Infinity;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const d = tileDist(from.x, from.y, t.x + 0.5, t.y + 0.5);
    if (d >= bd || d > 30) continue;
    if (!tileFree(map, t, mates)) continue;
    bd = d; best = t;
  }
  return best ? { x: best.x, y: best.y, dist: Math.round(bd * 10) / 10 } : null;
}

/**
 * 生成该成员视角的班组黑板。
 * @returns {{role:string, mates:object[], focus:{target,count}|null,
 *            wounded:object|null, highGround:object|null, cover:object|null}}
 */
export function buildSquadBoard(gameState, member) {
  const mates = liveMates(gameState, member);
  const rel = gameState.map ? reliefTiles(gameState.map) : { summits: [], posts: [] };
  let wounded = null;
  for (let i = 0; i < mates.length; i++) {
    const m = mates[i];
    const ratio = m.hp / m.maxHp;
    if (ratio >= SUPPORT_HP) continue;
    if (!m.lastDamagedTimer && !m.attackTarget) continue;   // 没交火的残血是自己在养伤，不用救
    if (tileDist(member.x, member.y, m.x, m.y) > SUPPORT_RANGE) continue;
    if (!wounded || ratio < wounded.hpRatio) wounded = { mate: m, hpRatio: ratio };
  }
  return {
    role: roleOf(member),
    mates: mates,
    focus: findFocus(gameState, member, mates),
    wounded: wounded,
    highGround: nearestFreeTile(gameState, member, rel.summits, mates),
    cover: nearestFreeTile(gameState, member, rel.posts, mates),
  };
}

/** 压成快照的「协同」字段（中文短键省 token；队友明细由快照自己的 队友 列表给出） */
export function squadBrief(board) {
  const out = {};
  if (board.focus) {
    out.集火 = board.focus.count + ' 人正在打「' + board.focus.target.name + '」，若它在你射程内优先补它的火力';
  }
  if (board.wounded) {
    out.求援 = board.wounded.mate.memberName + ' 只剩 ' + Math.round(board.wounded.hpRatio * 100) + '% 血且在交火，' +
      '向它靠拢形成交叉火力，别各自冲锋';
  }
  if (board.highGround) out.空闲山顶 = [board.highGround.x, board.highGround.y];
  if (board.cover) out.空闲沙袋 = [board.cover.x, board.cover.y];
  out.分工 = (ROLE_NAMES[board.role] || '突击手') + '：' + ROLE_DOCTRINE[board.role] +
    '；三人不要扎堆，同一时间最多一人占山顶、一人进同一段沙袋';
  return out;
}
