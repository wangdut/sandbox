// 零 API 成本的断言脚本：覆盖 token 成本控制与协议解析这些"错了很贵"的纯逻辑
//
// 运行：npm test    （或 node tools/test-agents.mjs）
// 不依赖浏览器、不调用任何 LLM。

import { canDeliverShout, AgentManager } from '../src/agents/AgentManager.js';
import { parseDecision } from '../src/agents/parser.js';
import { CommandBus } from '../src/core/commandBus.js';
import { MEMBERS, WEAPONS, applyWeapon, boardVehicle, dismountVehicle } from '../src/sandbox/memberDefs.js';
import { fallbackDecide, quickCommandDecision, parseGodCommand } from '../src/agents/FallbackAI.js';
import { isAIAutoTargetable } from '../src/agents/targeting.js';
import { buildSystemPrompt, buildSnapshot } from '../src/agents/prompts.js';
import { DEFAULT_CONFIG, resolveMemberAuth, isAgentEnabled, migrateConfig, CONFIG_SCHEMA } from '../src/agents/config.js';
import { buildSquadBoard, squadBrief, reliefTiles, onSandbag, onSummit, ROLE_NAMES } from '../src/agents/squadBoard.js';
import { DEFENSE_DEFS, UNIT_DEFS } from '../src/definitions.js';
import { GameMap } from '../src/GameMap.js';
import { GameState, SANDBAG_DAMAGE_MULT } from '../src/GameState.js';
import { updateProjectiles } from '../src/Combat.js';
import { MemberSystem, HG_RANGE_BONUS, HG_DAMAGE_MULT, isRecovering, RECOVER_HP_RATIO } from '../src/sandbox/memberSystem.js';
import { buildSandboxScenario, findHQ } from '../src/sandbox/scenario.js';
import { canSee, sightRangeOf, hasVisionLOS } from '../src/agents/vision.js';
import { FPS, TEAM_PLAYER, TEAM_ENEMY, TEAM_NEUTRAL, GRASS, WATER, ROCK, MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, HILL, HILL_TOP, SANDBAG } from '../src/constants.js';

let passed = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { passed++; return; }
  failures.push(name + (extra ? ' — ' + extra : ''));
}

function eq(name, actual, expected) {
  ok(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}

// ==================== 1. 喊话冷却（token 成本闸门） ====================
const cd = DEFAULT_CONFIG.budget.chatCooldownSec;
eq('冷却: 首条喊话放行', canDeliverShout(-99999, 0, cd), true);
eq('冷却: 冷却内拦截', canDeliverShout(1000, 1000 + cd * FPS - 1, cd), false);
eq('冷却: 整好到点放行', canDeliverShout(1000, 1000 + cd * FPS, cd), true);
eq('冷却: 远超冷却放行', canDeliverShout(1000, 1000 + cd * FPS * 3, cd), true);

// ==================== 2. 决策解析（LLM 输出清洗） ====================
const good = parseDecision('{"台词":"绕后拆家","对谁":"队友","动作":"attack_move","目标":{"类型":"building","id":9},"武器":"火箭筒","说明":"绕北"}');
ok('解析: 正常 JSON', good.ok, good.error);
eq('解析: 动作', good.decision.action, 'attack_move');
eq('解析: 武器别名 火箭筒→rocket', good.decision.weapon, 'rocket');
eq('解析: 目标 id', good.decision.target.id, 9);

const fenced = parseDecision('```json\n{"台词":"收到","对谁":null,"动作":"hold","目标":null,"武器":"机枪","说明":"待命"}\n```');
ok('解析: 代码块围栏可剥离', fenced.ok, fenced.error);
eq('解析: 武器别名 机枪→mg', fenced.decision.weapon, 'mg');

const chatty = parseDecision('好的，我的想法是：\n{"台词":"我上！","对谁":null,"动作":"attack","目标":{"类型":"unit","id":3},"武器":"机枪","说明":"打步兵"}\n以上。');
ok('解析: 前后缀解释可容忍', chatty.ok, chatty.error);

ok('解析: 非法动作被拒', !parseDecision('{"台词":"x","动作":"dance","目标":null}').ok);
ok('解析: 缺台词被拒', !parseDecision('{"动作":"hold"}').ok);
ok('解析: attack 缺目标被拒', !parseDecision('{"台词":"x","动作":"attack"}').ok);
ok('解析: move 缺目标被拒', !parseDecision('{"台词":"x","动作":"move"}').ok);
ok('解析: move 可指向实体 id（乘驾/接近）', parseDecision('{"台词":"上车","动作":"move","目标":{"类型":"unit","id":9}}').ok);
ok('解析: 空内容给出可读错误', /max_tokens|未返回内容/.test(parseDecision('').error));
// 掩体/高地动作不带目标（坐标由引擎挑）
ok('解析: cover 无需目标', parseDecision('{"台词":"我去找沙袋","动作":"cover"}').ok);
eq('解析: highground 动作可用', parseDecision('{"台词":"上山顶","动作":"highground","目标":null,"武器":"机枪"}').decision.action, 'highground');
eq('解析: 战术意图截到 24 字', parseDecision('{"台词":"打","动作":"hold","说明":"' + '难'.repeat(30) + '"}').decision.intent.length, 24);

const longSay = parseDecision('{"台词":"' + '字'.repeat(55) + '","对谁":"敌人","动作":"hold","目标":null}');
ok('解析: 台词截断到 40 字', longSay.ok && longSay.decision.say.length === 40);
eq('解析: 40 字台词原样保留', parseDecision('{"台词":"' + '字'.repeat(40) + '","动作":"hold"}').decision.say.length, 40);
eq('解析: 非法"对谁"归零', longSay.decision.to, null);

const posMove = parseDecision('{"台词":"过去","对谁":null,"动作":"move","目标":{"类型":"position","x":12,"y":8}}');
ok('解析: 位置目标可用', posMove.ok && posMove.decision.target.x === 12);

// ==================== 3. 命令通道（上帝命令分发） ====================
const bus = new CommandBus();
bus.setMemberKeysResolver((team) => MEMBERS.filter((m) => m.team === team).map((m) => m.key));
const cmd = bus.sendCommand({ team: TEAM_PLAYER, type: 'text', text: '进攻' });
eq('命令: 广播给己方 2 名成员', [bus.peekFor('blue_1') ? 1 : 0, bus.peekFor('blue_2') ? 1 : 0].join(','), '1,1');
eq('命令: 不会误发给敌方', bus.peekFor('red_1'), null);
eq('命令: peek 不消费', bus.peekFor('blue_1').id, cmd.id);
eq('命令: take 后清空', (bus.takeFor('blue_1'), bus.peekFor('blue_1')), null);
eq('命令: 另一成员仍持有', bus.peekFor('blue_2').id, cmd.id);
eq('命令: 记入历史供快照使用', bus.lastForTeam(TEAM_PLAYER).text, '进攻');
bus.takeFor('blue_2');   // 先清掉文本命令，单独观察快捷命令是否入队
bus.sendCommand({ team: TEAM_PLAYER, type: 'quick', kind: 'retreat', text: '【撤退】', queue: false });
eq('命令: queue=false 不触发 LLM 决策（快捷命令零 token）', bus.peekFor('blue_2'), null);
eq('命令: queue=false 仍写入历史', bus.lastForTeam(TEAM_PLAYER).text, '【撤退】');

// ==================== 4. 成员与武器 ====================
eq('成员: 名册共 6 人（3v3）', MEMBERS.length, 6);
eq('成员: 每方 3 人', MEMBERS.filter((m) => m.team === TEAM_PLAYER).length + '/' + MEMBERS.filter((m) => m.team === TEAM_ENEMY).length, '3/3');
const fakeUnit = { weaponMode: 'mg', damage: 14, range: 4.5, fireRate: 20, damageType: 'bullet', antiArmor: false, splashRadius: 0 };
applyWeapon(fakeUnit, 'rocket');
eq('武器: 切火箭筒改伤害', fakeUnit.damage, WEAPONS.rocket.damage);
eq('武器: 切火箭筒改伤害类型', fakeUnit.damageType, 'rocket');
ok('武器: 火箭筒具备反装甲', fakeUnit.antiArmor === true);

// ==================== 5. 兜底 AI（无 Key 时也要能打） ====================
function makeGameState(opts) {
  const enemyHq = { id: 9, name: '指挥所', team: TEAM_ENEMY, isBuilding: true, size: 3, x: 32, y: 7, hp: 1800, maxHp: 1800, dead: false, getCenterX: () => 1072, getCenterY: () => 272 };
  const ownHq = { id: 1, name: '指挥所', team: TEAM_PLAYER, isBuilding: true, size: 3, x: 5, y: 30, hp: 1800, maxHp: 1800, dead: false, getCenterX: () => 208, getCenterY: () => 1008 };
  const enemy = { id: 20, name: '红1号', team: TEAM_ENEMY, isMember: true, type2: 'infantry', x: 10, y: 34, hp: 300, maxHp: 380, dead: false, getCenterX: () => 336, getCenterY: () => 1104 };
  const list = opts.withEnemyInRange ? [enemyHq, ownHq, enemy] : [enemyHq, ownHq];
  return {
    entities: list,
    getEnemiesInRange: () => (opts.withEnemyInRange ? [enemy] : []),
  };
}
const memberLow = { id: 2, team: TEAM_PLAYER, x: 5, y: 34, hp: 40, maxHp: 380, range: 4.5 };
const board = { ownHq: { x: 5, y: 30, size: 3, isBuilding: true }, enemyHq: { x: 32, y: 7, size: 3, isBuilding: true } };
const dLow = fallbackDecide(makeGameState({}), memberLow, { spec: MEMBERS[0], board });
eq('兜底: 残血撤退', dLow.action, 'retreat');
const dFight = fallbackDecide(makeGameState({ withEnemyInRange: true }), { ...memberLow, hp: 380 }, { spec: MEMBERS[0], board });
eq('兜底: 射程内有敌人则开打', dFight.action, 'attack');
eq('兜底: 打完步兵用机枪', dFight.weapon, 'mg');
const dPush = fallbackDecide(makeGameState({}), { ...memberLow, hp: 380 }, { spec: MEMBERS[0], board });
eq('兜底: 无事则推进敌方指挥所', dPush.action, 'attack_move');
eq('兜底: 拆家用火箭筒', dPush.weapon, 'rocket');
eq('快捷: 总攻指向敌方指挥所', quickCommandDecision('allAttack', memberLow, { board }).target.类型, 'unit');
eq('快捷: 撤退回己方指挥所', quickCommandDecision('retreat', memberLow, { board }).action, 'retreat');

// ==================== 5b. 中立高楼 = 掩体，不是 AI 的猎物 ====================
// 故意把高楼放得比敌方指挥所更近：修复前，"最近敌方"扫描会把 team!==myTeam 的高楼当敌人推过去拆
const highrise = { id: 77, name: '高楼大厦', team: TEAM_NEUTRAL, isBuilding: true, aiIgnore: true, blocksFire: true,
  size: 2, x: 8, y: 32, hp: 900, maxHp: 900, dead: false, getCenterX: () => 272, getCenterY: () => 1040 };
ok('楼房: 统一判定剔除中立高楼', isAIAutoTargetable(highrise, TEAM_PLAYER) === false);
ok('楼房: 真敌人仍可被选中', isAIAutoTargetable({ id: 20, team: TEAM_ENEMY, dead: false }, TEAM_PLAYER) === true);

function withCover(opts) {
  const gs = makeGameState(opts || {});
  gs.entities = gs.entities.concat([highrise]);
  return gs;
}
const dCover = fallbackDecide(withCover({}), { ...memberLow, hp: 380 }, { spec: MEMBERS[0], board });
ok('楼房: 兜底 AI 不主动攻击中立高楼（' + dCover.action + '→' + dCover.target.id + '）', dCover.target.id !== highrise.id);

const coverMember = { ...memberLow, hp: 380, maxHp: 380, x: 5, y: 34, weaponMode: 'mg', fireCooldown: 0,
  memberName: '蓝1号', type2: 'infantry', getCenterX: () => 176, getCenterY: () => 1104 };
const coverSnap = JSON.parse(buildSnapshot(withCover({}), coverMember, {
  spec: MEMBERS[0], board, lastCommand: null, events: [], allyMsgs: [], enemyMsgs: [],
}));
ok('楼房: 喂给模型的可选目标不含高楼', (coverSnap['可选目标'] || []).every((t) => t.id !== highrise.id));
ok('楼房: 高楼改列入"掩体"并标注非目标', (coverSnap['掩体'] || []).some((c) => c['定位'].indexOf('非攻击目标') >= 0));
ok('楼房: 系统提示禁止主动拆楼', buildSystemPrompt(MEMBERS[0]).includes('绝不要主动攻击它'));

// ==================== 6. 提示词与快照契约 ====================
const sys = buildSystemPrompt(MEMBERS[0]);
ok('提示词: 含人设姓名', sys.includes(MEMBERS[0].name));
ok('提示词: 含 JSON 字段说明', sys.includes('台词') && sys.includes('attack_move'));
ok('提示词: 明确要求纯 JSON', sys.includes('只输出一个 JSON'));
ok('提示词: 人类阵营提及上帝命令', buildSystemPrompt(MEMBERS[0]).includes('上帝'));
ok('提示词: 电脑阵营为自主模式', buildSystemPrompt(MEMBERS[2]).includes('自主'));
const snap = buildSnapshot(makeGameState({ withEnemyInRange: true }), { ...memberLow, hp: 380, maxHp: 380, weaponMode: 'mg', fireCooldown: 0, memberName: '蓝1号', type2: 'infantry', x: 5, y: 34, getCenterX: () => 176, getCenterY: () => 1104 }, {
  spec: MEMBERS[0], board, lastCommand: { text: '进攻', at: Date.now() },
  events: ['收到上帝命令：进攻'], allyMsgs: [], enemyMsgs: [],
});
const snapObj = JSON.parse(snap);
ok('快照: 字段齐全', !!snapObj['自身'] && !!snapObj['指挥所'] && !!snapObj['可选目标'] && !!snapObj['当前命令']);
ok('快照: 目标带 id 与机器可读种类', snapObj['可选目标'].length > 0 && typeof snapObj['可选目标'][0].id === 'number' && !!snapObj['可选目标'][0]['种类']);

// ==================== 7. 配置解析 ====================
eq('配置: 默认含 effort=low', DEFAULT_CONFIG.effort, 'low');
ok('配置: 默认 max_tokens 足够推理模型', DEFAULT_CONFIG.maxTokens >= 1500);
eq('配置: 独立 Key 覆盖生效', resolveMemberAuth({ ...DEFAULT_CONFIG, apiKey: 'base', memberApiKeys: { blue_1: 'own' } }, 'blue_1').apiKey, 'own');
eq('配置: 未覆盖则共用', resolveMemberAuth({ ...DEFAULT_CONFIG, apiKey: 'base' }, 'blue_2').apiKey, 'base');
eq('配置: 成员可单独关闭', isAgentEnabled({ ...DEFAULT_CONFIG, agentEnabled: { red_1: false } }, 'red_1'), false);

// ==================== 8. 阵营情报隔离（上帝命令与喊话都不能串台） ====================
const bus2 = new CommandBus();
bus2.setMemberKeysResolver((team) => MEMBERS.filter((m) => m.team === team).map((m) => m.key));
bus2.sendCommand({ team: 0, text: '蓝方进攻', type: 'text' });
eq('隔离: 命令只记在蓝方名下', bus2.lastForTeam(0).text, '蓝方进攻');
eq('隔离: 红方拿不到蓝方命令', bus2.lastForTeam(1), null);

// 直接驱动 AgentManager 的喊话分发，验证"阵营内仅本方可见 / 跨阵营才公开"
const chatSeen = [];
function makeFakeGameState() {
  return { entities: [], addSpeech: function () {} };
}
const am = new AgentManager();
const fakeMemberSystem = {
  frameCount: 100,
  setWeapon: function () { return true; },
  slots: [],
};
am.init({
  config: { ...DEFAULT_CONFIG, apiKey: 'x' },
  memberSystem: fakeMemberSystem,
  commandBus: bus2,
  notify: function () {},
  onChat: function (m) { chatSeen.push(m); },
});
const blue1 = am.agents.get('blue_1');
const blue2 = am.agents.get('blue_2');
const red1 = am.agents.get('red_1');
const gs = makeFakeGameState();
const fakeMemberEntity = { isMember: true, getCenterX: () => 0, getCenterY: () => 0 };

am._handleChat(blue1, fakeMemberEntity, gs, 1000, { say: '蓝1号掩护我', to: '队友' });
eq('隔离: 队友喊话进本方队友邮箱', blue2.allyMsgs.length, 1);
eq('隔离: 队友喊话不进敌方邮箱', red1.enemyMsgs.length, 0);
eq('隔离: 标记为仅本方可见', chatSeen[chatSeen.length - 1].audience, 'blue');

am._handleChat(blue1, fakeMemberEntity, gs, 1000 + 60 * DEFAULT_CONFIG.budget.chatCooldownSec, { say: '红方投降吧', to: '敌方' });
eq('隔离: 跨阵营喊话进敌方邮箱', red1.enemyMsgs.length, 1);
eq('隔离: 跨阵营喊话标记为全场', chatSeen[chatSeen.length - 1].audience, 'both');

// 冷却内的第二次喊话应降级为自语（不广播）
const beforeAlly = blue2.allyMsgs.length;
am._handleChat(blue1, fakeMemberEntity, gs, 1000 + 60 * DEFAULT_CONFIG.budget.chatCooldownSec + 60, { say: '再来一次', to: '队友' });
eq('隔离: 冷却内喊话不广播', blue2.allyMsgs.length, beforeAlly);
eq('隔离: 冷却内喊话标记为自语', chatSeen[chatSeen.length - 1].audience, 'self');

// ==================== 9. 威胁感知寻路（成员会绕开防御射程） ====================
function buildOpenMap() {
  const map = new GameMap();
  map.terrain = [];
  map.oreAmount = [];
  map.occupancy = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    map.terrain[y] = []; map.oreAmount[y] = []; map.occupancy[y] = [];
    for (let x = 0; x < MAP_WIDTH; x++) { map.terrain[y][x] = GRASS; map.oreAmount[y][x] = 0; map.occupancy[y][x] = null; }
  }
  map.recomputeRegions();
  // 在 28..32 × 26..38 造一块"炮塔射程"，只有队伍 0 的寻路会规避
  const grid = new Float32Array(MAP_WIDTH * MAP_HEIGHT);
  for (let y = 26; y <= 38; y++) for (let x = 28; x <= 32; x++) grid[y * MAP_WIDTH + x] = 1.0;
  map.danger = [grid, null];
  return map;
}
/** 沿整条路径（含线段）累加危险度：只看路点会漏掉"直线抄近道穿过火力区"的情况 */
function dangerAlong(map, path) {
  let sum = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[i], b = path[i + 1];
    if (!b) { sum += map.danger[0][a.y * 64 + a.x] || 0; continue; }
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
    const sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1;
    let err = dx - dy, x = a.x, y = a.y, guard = 0;
    while ((x !== b.x || y !== b.y) && guard++ < MAP_WIDTH * MAP_HEIGHT) {
      sum += map.danger[0][y * MAP_WIDTH + x] || 0;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }
  return sum;
}
const dmap = buildOpenMap();
const naive = dmap.findPath(20, 32, 40, 32, 3000, { team: 0, avoidDanger: false }, true);
const careful = dmap.findPath(20, 32, 40, 32, 3000, { team: 0, avoidDanger: true }, true);
ok('寻路: 两条路径都可达', naive.length > 0 && careful.length > 0);
ok('寻路: 规避威胁后暴露量更低（' + dangerAlong(dmap, naive) + ' → ' + dangerAlong(dmap, careful) + '）',
  dangerAlong(dmap, careful) < dangerAlong(dmap, naive));
eq('寻路: 非成员单位不受影响（无 danger 时行为一致）', dmap.findPath(2, 2, 5, 5, 3000, null, true).length > 0, true);

// ==================== 10. 本轮改动的数值与配置约定 ====================
eq('配置: 每局 token 上限默认 20 万', DEFAULT_CONFIG.budget.maxTokensPerGame, 200000);
const migrated = migrateConfig({ budget: { maxTokensPerGame: 80000 } });
eq('配置: 老存档的旧默认额度被升级', migrated.budget.maxTokensPerGame, 200000);
eq('配置: 老存档自定义额度不被覆盖', migrateConfig({ budget: { maxTokensPerGame: 12345 } }).budget.maxTokensPerGame, 12345);
eq('配置: 老存档的配音块被清除', migrateConfig({ tts: { enabled: true, rate: 1.2 } }).tts, undefined);
eq('配置: 结构版本升到 3', migrateConfig({}).schemaVersion, CONFIG_SCHEMA);
eq('配置: 喊话冷却放宽到 18 秒（配合需要更密的队内交流）', DEFAULT_CONFIG.budget.chatCooldownSec, 18);
eq('数值: 成员移速已降到 1.2（原 2.0 的 60%）', UNIT_DEFS.member.speed, 1.2);
ok('数值: 成员血量上调', UNIT_DEFS.member.hp >= 420);
ok('数值: 碉堡射速下调（更慢的压制节奏）', DEFENSE_DEFS.pillbox.fireRate >= 40);


// ==================== 11. 载具乘驾与新增防御 ====================
const mountMember = { mountType: null, hp: 100, maxHp: 420, speed: 1.2, type2: 'infantry', size: 1, isAirUnit: false, weaponMode: 'mg', damage: 14, range: 4.5, fireRate: 20, damageType: 'bullet', antiArmor: false, splashRadius: 0, antiAir: false, armorType: 'none', path: [], pathIndex: 0, attackTarget: null, attackMoveTarget: null, guardPos: null, boardTarget: null, fireCooldown: 0 };
boardVehicle(mountMember, { type: 'tank' });
eq('载具: 乘驾后变主战坦克', mountMember.mountType, 'tank');
ok('载具: 继承坦克的血量与重甲', mountMember.maxHp === 650 && mountMember.armorType === 'heavy');
eq('载具: 坦克为地面单位', mountMember.isAirUnit, false);
boardVehicle(mountMember, { type: 'gunship' });
eq('载具: 炮艇机为空中单位', mountMember.isAirUnit, true);
dismountVehicle(mountMember);
eq('载具: 下机恢复步兵', mountMember.mountType, null);
ok('载具: 下机保留血量比例', mountMember.hp > 0 && mountMember.hp <= 420 && mountMember.type2 === 'infantry');
eq('防御: 高射机枪阵地对空对地通吃', DEFENSE_DEFS.aaNest.hitsAll, true);

// ==================== 12. 山包与沙袋：地形生成、通行、高地加成 ====================
const world = new GameState();
buildSandboxScenario(world, TEAM_PLAYER);
const wMap = world.map;
function countTerrain(type) {
  let n = 0;
  for (let y = 0; y < MAP_HEIGHT; y++) for (let x = 0; x < MAP_WIDTH; x++) if (wMap.terrain[y][x] === type) n++;
  return n;
}
function countTerrainHalf(type, south) {
  let n = 0;
  for (let y = south ? MAP_HEIGHT / 2 : 0; y < (south ? MAP_HEIGHT : MAP_HEIGHT / 2); y++)
    for (let x = 0; x < MAP_WIDTH; x++) if (wMap.terrain[y][x] === type) n++;
  return n;
}
const nHill = countTerrain(HILL), nTop = countTerrain(HILL_TOP), nBag = countTerrain(SANDBAG);
ok('地形: 山包连绵（' + nHill + ' 格坡地）', nHill >= 20);
ok('地形: 每座山有可站的平顶（' + nTop + ' 格山顶）', nTop >= 6);
ok('地形: 沙袋阵地成建制（' + nBag + ' 格）', nBag >= 8);
ok('地形: 战术位南北对等（坡 ' + countTerrainHalf(HILL, false) + '/' + countTerrainHalf(HILL, true) +
  '，顶 ' + countTerrainHalf(HILL_TOP, false) + '/' + countTerrainHalf(HILL_TOP, true) +
  '，沙袋 ' + countTerrainHalf(SANDBAG, false) + '/' + countTerrainHalf(SANDBAG, true) + '）',
  countTerrainHalf(HILL, false) === countTerrainHalf(HILL, true) &&
  countTerrainHalf(HILL_TOP, false) === countTerrainHalf(HILL_TOP, true) &&
  countTerrainHalf(SANDBAG, false) === countTerrainHalf(SANDBAG, true));

let summit = null, post = null, flat = null;
for (let y = 0; y < MAP_HEIGHT && !summit; y++)
  for (let x = 0; x < MAP_WIDTH; x++) if (wMap.terrain[y][x] === HILL_TOP) { summit = { x, y }; break; }
for (let y = 0; y < MAP_HEIGHT && !post; y++)
  for (let x = 0; x < MAP_WIDTH; x++) if (wMap.terrain[y][x] === SANDBAG) { post = { x, y }; break; }
for (let y = 0; y < MAP_HEIGHT && !flat; y++)
  for (let x = 0; x < MAP_WIDTH; x++) if (wMap.terrain[y][x] === GRASS) { flat = { x, y }; break; }
const foot = { team: TEAM_PLAYER, type2: 'infantry' };
const car = { team: TEAM_PLAYER, type2: 'vehicle' };
ok('地形: 步兵能爬上山顶', wMap.isPassableForUnit(summit.x, summit.y, foot) === true);
ok('地形: 步兵能进沙袋阵地', wMap.isPassableForUnit(post.x, post.y, foot) === true);
ok('地形: 车辆开不上山包', wMap.isPassableForUnit(summit.x, summit.y, car) === false);
ok('地形: 车辆开不进沙袋', wMap.isPassableForUnit(post.x, post.y, car) === false);

const msys = new MemberSystem();
msys.init(world);
const scout = msys.liveMembers(world).find(function (e) { return e.team === TEAM_PLAYER; });
scout.x = summit.x; scout.y = summit.y;
const baseDmg = scout.damage, baseRange = scout.range;
msys.update(world, 1);
ok('高地: 站上山顶伤害 ×' + HG_DAMAGE_MULT + '（' + baseDmg + '→' + scout.damage + '）',
  scout.damage === Math.floor(baseDmg * HG_DAMAGE_MULT) && scout.onHighGround === true);
eq('高地: 站上山顶射程 +' + HG_RANGE_BONUS, scout.range, baseRange + HG_RANGE_BONUS);
scout.x = flat.x; scout.y = flat.y;   // 走下山包
msys.update(world, 1);
ok('高地: 离开山顶精确回滚（' + scout.damage + '/' + scout.range + '）',
  scout.damage === baseDmg && scout.range === baseRange && scout.onHighGround === false);

// 站在山顶换武器：数值被整体覆盖后，加成必须重新挂在新数值上而不是叠加/错位
scout.x = summit.x; scout.y = summit.y;
msys.update(world, 1);
applyWeapon(scout, scout.weaponMode === 'mg' ? 'rocket' : 'mg');
const wDmg = scout.damage, wRange = scout.range;
msys.update(world, 1);
ok('高地: 换武器后加成重挂而不串味（' + wDmg + '→' + scout.damage + '）',
  scout.damage === Math.floor(wDmg * HG_DAMAGE_MULT) && scout.range === wRange + HG_RANGE_BONUS);

const snapCtx = {
  spec: MEMBERS[0], board: { ownHq: findHQ(world, TEAM_PLAYER), enemyHq: findHQ(world, TEAM_ENEMY) },
  events: [], allyMsgs: [], enemyMsgs: [], lastCommand: null, currentAction: null,
};
const reliefSnap = JSON.parse(buildSnapshot(world, scout, snapCtx));
ok('高地: 快照报出脚下地形与生效中的加成', reliefSnap['地形'].脚下 === '山顶' &&
  /\+2/.test(reliefSnap['地形'].高地状态 || ''));
ok('高地: 快照给出最近战术位坐标', !!reliefSnap['地形'].最近山顶 && !!reliefSnap['地形'].最近沙袋);
ok('地形: 系统提示讲清山顶与沙袋的用法', buildSystemPrompt(MEMBERS[0]).indexOf('【高地与掩体】') >= 0);

// ==================== 13. 掩体与弹道：高楼挡直射、沙袋按比例减伤 ====================
function coverDummy(tx, ty, isBuilding) {
  return {
    x: tx, y: ty, hp: 1000, dead: false, isBuilding: !!isBuilding, flashTimer: 0,
    getCenterX() { return (this.x + 0.5) * TILE_SIZE; },
    getCenterY() { return (this.y + 0.5) * TILE_SIZE; },
  };
}
const onBag = coverDummy(post.x, post.y);
const onFlat = coverDummy(flat.x, flat.y);
const bagBuilding = coverDummy(post.x, post.y, true);
world.damageEntity(onFlat, 100);
world.damageEntity(onBag, 100);
world.damageEntity(bagBuilding, 100);
eq('掩体: 沙袋内步兵减伤（100→' + (1000 - onBag.hp) + '）', 1000 - onBag.hp, Math.floor(100 * SANDBAG_DAMAGE_MULT));
ok('掩体: 开阔地步兵吃满伤（' + (1000 - onFlat.hp) + '）', 1000 - onFlat.hp === 100);
ok('掩体: 建筑是硬目标，不因脚下沙袋减免', 1000 - bagBuilding.hp === 100);

const tower = world.entities.find(function (e) { return e.blocksFire && !e.dead; });
ok('弹道: 战场上有可挡弹的中立高楼', !!tower);
const tcx = tower.getCenterX(), tcy = tower.getCenterY();
function pointDummy(px, py) {
  return { hp: 5000, dead: false, isBuilding: false, getCenterX() { return px; }, getCenterY() { return py; } };
}
/** 从楼西侧 200px 直射楼东侧 200px 的同高目标，返回命中结果 */
function fireThrough(type, offY) {
  world.projectiles.length = 0;
  const tgt = pointDummy(tcx + 200, tcy + offY);
  const shooter = pointDummy(tcx - 200, tcy + offY);
  world.addProjectile({ x: tcx - 200, y: tcy + offY }, tgt, 40, TEAM_ENEMY, type, 0, shooter);
  let guard = 0;
  while (world.projectiles.length && guard++ < 400) updateProjectiles(world);
  return { hit: 5000 - tgt.hp, left: world.projectiles.length };
}
const hpBeforeBullet = tower.hp;
const blockedShot = fireThrough('bullet', 0);
ok('弹道: 直射子弹被高楼截停，墙体吃掉一半伤害（楼 ' + hpBeforeBullet + '→' + tower.hp + '）',
  blockedShot.hit === 0 && blockedShot.left === 0 && tower.hp < hpBeforeBullet &&
  world.floatingTexts.some(function (t) { return t.text === '被高楼阻挡'; }));
const hpAfterBullet = tower.hp;
const arcShot = fireThrough('rocket', 0);
ok('弹道: 火箭走抛物线，越过高楼照样命中', arcShot.hit > 0 && tower.hp === hpAfterBullet);
const clearShot = fireThrough('bullet', -4 * TILE_SIZE);
ok('弹道: 未被遮挡的直射视线照常命中', clearShot.hit > 0);

// ==================== 14. 班组协同：集火、支援、分散、抢战术位 ====================
function resetMember(e, x, y) {
  e.hp = e.maxHp; e.dead = false; e.mountType = e.mountType || null;
  e.attackTarget = null; e.attackMoveTarget = null; e.guardPos = null;
  e.path = []; e.pathIndex = 0; e.boardTarget = null; e.lastDamagedTimer = 0;
  e.x = x; e.y = y;
  return e;
}
const blueTeam = msys.liveMembers(world).filter(function (e) { return e.team === TEAM_PLAYER; });
const redTeam = msys.liveMembers(world).filter(function (e) { return e.team === TEAM_ENEMY; });
eq('协同: 每队三名成员成班', blueTeam.length, 3);
eq('协同: 敌方同样三人', redTeam.length, 3);
ok('协同: 每名成员都有战术分工', MEMBERS.every(function (m) { return !!ROLE_NAMES[m.role]; }));

// 三人挤在地图角落的草地上：既不在山顶也不在沙袋，排除驻守分支的干扰
const bx = flat.x, by = flat.y;
blueTeam.forEach(function (e, i) { resetMember(e, bx + i, by); });
redTeam.forEach(function (e, i) { resetMember(e, 60, 60 - i); });   // 先把敌方挪远，避免被当成"最近目标"
world.spatialDirty = true;
const [b0, b1, b2] = blueTeam;
const [r0, r1] = redTeam;
const boardReal = { ownHq: findHQ(world, TEAM_PLAYER), enemyHq: findHQ(world, TEAM_ENEMY) };
const specOf = (e) => MEMBERS.find(function (m) { return m.key === e.memberKey; });

// 1) 集火优先：两名队友锁定远处那个，第三人就不能去捡身边的另一个
b0.attackTarget = r0; b1.attackTarget = r0;
r0.x = bx + 6; r0.y = by; r0.hp = r0.maxHp;
r1.x = bx + 2; r1.y = by; r1.hp = r1.maxHp;
world.spatialDirty = true;
const focusBoard = buildSquadBoard(world, b2);
ok('协同: 黑板算出集火目标（' + focusBoard.focus.count + ' 人锁定 ' + (focusBoard.focus.target && focusBoard.focus.target.memberName) + '）',
  !!focusBoard.focus && focusBoard.focus.count >= 2 && focusBoard.focus.target === r0);
b2.range = 10;
const dFocus = fallbackDecide(world, b2, { spec: specOf(b2), board: boardReal });
eq('协同: 兜底 AI 补队友的火力而非另开目标', dFocus.action, 'attack');
eq('协同: 集火选择压过最近敌人', dFocus.target.id, r0.id);
ok('协同: 集火意图写进说明', (dFocus.intent || '').indexOf('集火') >= 0, dFocus.intent);

// 2) 支援：队友残血且在交火，第三人靠过去而不是各自冲锋
b0.attackTarget = null; b1.attackTarget = null; b2.attackTarget = null;
resetMember(r0, 60, 60); resetMember(r1, 61, 60);
b1.hp = Math.ceil(b1.maxHp * 0.3); b1.lastDamagedTimer = 120; b1.attackTarget = r0;
r0.x = bx + 4; r0.y = by + 4; r0.hp = r0.maxHp;
b0.range = 0.5;                       // b0 自己射程内没人，才有空去救
world.spatialDirty = true;
const supportBoard = buildSquadBoard(world, b0);
ok('协同: 黑板点名求援队友', !!supportBoard.wounded && supportBoard.wounded.mate === b1);
const dSupport = fallbackDecide(world, b0, { spec: specOf(b0), board: boardReal });
eq('协同: 空闲成员转去支援', dSupport.action, 'attack_move');
ok('协同: 支援意图写进说明', (dSupport.intent || '').indexOf('支援') >= 0, dSupport.intent);
ok('协同: 支援点落在残血队友附近（带扇形偏移不扎堆）',
  Math.abs(dSupport.target.x - b1.x) + Math.abs(dSupport.target.y - b1.y) <= 4,
  JSON.stringify(dSupport.target));

// 3) 分散：三人一起推敌方指挥所时，目标点必须各不相同（一发炮弹不能送走全班）
// 清掉前一组用例留下的射程/血量改动并把敌人挪远，确保三人走的是"推进敌方指挥所"分支
blueTeam.forEach(function (e, i) { resetMember(e, bx + i, by); applyWeapon(e, specOf(e).weapon); });
resetMember(r0, 60, 60); resetMember(r1, 61, 60);
world.spatialDirty = true;
const pushes = blueTeam.map(function (e) {
  const d = fallbackDecide(world, e, { spec: specOf(e), board: boardReal });
  return d.action === 'attack_move' && d.target && d.target.类型 === 'position' ? d.target.x + ',' + d.target.y : d.action;
});
eq('协同: 三人推进点扇形分散', new Set(pushes).size, 3);

// 4) 战术位不抢占：队友已经走向山顶，另一个人必须换一处
// 挪到山包与沙袋阵地都能覆盖到的草地（角落离沙袋超过黑板的 30 格上限）
blueTeam.forEach(function (e, i) { resetMember(e, 20 + i, 20); });
world.spatialDirty = true;
const own = buildSquadBoard(world, b0);
ok('协同: 黑板给出空闲山顶与沙袋', !!own.highGround && !!own.cover);
eq('协同: 山顶格确实是山顶', world.map.terrain[own.highGround.y][own.highGround.x], HILL_TOP);
eq('协同: 沙袋格确实是沙袋', world.map.terrain[own.cover.y][own.cover.x], SANDBAG);
b1.path = [{ x: own.highGround.x, y: own.highGround.y }];
const rival = buildSquadBoard(world, b0).highGround;
ok('协同: 同一座山顶不会派给两个人', !rival || !(rival.x === own.highGround.x && rival.y === own.highGround.y));
b1.path = [];

// 5) cover / highground 落到引擎：真的排出通往沙袋/山顶的路
const qCover = quickCommandDecision('cover', b0, { board: boardReal, gameState: world });
eq('快捷: 找掩体给出 cover 动作', qCover.action, 'cover');
ok('快捷: 找掩体台词报出目标格', /（\d+,\d+）/.test(qCover.say), qCover.say);
ok('快捷: 找掩体不需要目标字段', qCover.target === null);
am._applyDecision(am.agents.get(b0.memberKey), b0, world, 100, qCover);
eq('掩体: cover 把成员派往真实沙袋格', world.map.terrain[b0.attackMoveTarget.y][b0.attackMoveTarget.x], SANDBAG);
ok('掩体: cover 确实排出了可行走的路径', b0.path.length > 0);
const qHill = quickCommandDecision('highground', b1, { board: boardReal, gameState: world });
eq('快捷: 占高地给出 highground 动作', qHill.action, 'highground');
am._applyDecision(am.agents.get(b1.memberKey), b1, world, 100, qHill);
eq('高地: highground 把成员派往真实山顶格', world.map.terrain[b1.attackMoveTarget.y][b1.attackMoveTarget.x], HILL_TOP);
// 已经把山顶占了，就不该再给第二个人同一座山
b1.x = b1.attackMoveTarget.x; b1.y = b1.attackMoveTarget.y;
ok('协同: 站进沙袋/山顶后脚下地形被认出', onSandbag(world.map, { x: own.cover.x, y: own.cover.y }) && onSummit(world.map, b1));
const b2Hill = buildSquadBoard(world, b2).highGround;
ok('协同: 已被队友站住的山顶不再分配给别人',
  !b2Hill || !(b2Hill.x === b1.x && b2Hill.y === b1.y), JSON.stringify(b2Hill));

// 6) 自保反射优先躲进沙袋，而不是任意一个安全格
const zeroDanger = new Float32Array(MAP_WIDTH * MAP_HEIGHT);
const bagTile = own.cover;
const nearBag = { x: bagTile.x, y: bagTile.y + 2, team: TEAM_PLAYER };
const dodged = am._findSafeTile(world, nearBag, zeroDanger);
eq('掩体: 自保反射优先选沙袋格', world.map.terrain[dodged.y][dodged.x], SANDBAG);

// 7) 快照把协同喂给模型
b0.attackTarget = r0; b1.attackTarget = r0;
r0.x = 24; r0.y = 20; r0.hp = r0.maxHp; r0.dead = false;
world.spatialDirty = true;
const squadSnap = JSON.parse(buildSnapshot(world, b2, {
  spec: specOf(b2), board: boardReal, events: [], allyMsgs: [], enemyMsgs: [], lastCommand: null, currentAction: null,
}));
ok('协同: 快照出现集火提示', /人正在打「红1号」/.test(squadSnap['协同'].集火 || ''), squadSnap['协同'].集火);
ok('协同: 队友条目带上在打谁', (squadSnap['队友'] || []).some(function (a) { return a['正在打'] === r0.memberName; }));
ok('协同: 分工栏写明角色与站位纪律', (squadSnap['协同'].分工 || '').indexOf(ROLE_NAMES[specOf(b2).role]) === 0);
ok('协同: 系统提示要求配合', buildSystemPrompt(MEMBERS[0]).indexOf('【协同】') >= 0);
const briefEmpty = squadBrief({ role: 'recon', mates: [], focus: null, wounded: null, highGround: null, cover: null });
eq('协同: 无态势时只留分工栏', Object.keys(briefEmpty).length, 1);
eq('协同: 战术格按地图只扫一次', reliefTiles(world.map) === reliefTiles(world.map), true);

// ==================== 15. 撤退与自保反射：思考与行动一致 ====================
resetMember(b0, 20, 20);
const retreatD = parseDecision('{"台词":"打不过，撤！","动作":"retreat"}');
eq('撤退: retreat 动作可解析', retreatD.ok, true);
am._applyDecision(am.agents.get(b0.memberKey), b0, world, 200, retreatD.decision);
ok('撤退: 进入脱离状态（fleeTo 指向指挥所）', !!b0.fleeTo, JSON.stringify(b0.fleeTo));
eq('撤退: 不再挂守卫位（守卫会原地开火恋战）', b0.guardPos, null);
eq('撤退: 清空攻击目标', b0.attackTarget, null);
ok('撤退: 真的排出了撤退路径', b0.path && b0.path.length > 0);

// 新指令覆盖脱离状态：大脑改口进攻时，成员必须停撤参战
resetMember(r0, 30, 20); r0.hp = r0.maxHp; r0.dead = false;
am._applyDecision(am.agents.get(b0.memberKey), b0, world, 200, { action: 'attack', target: { 类型: 'unit', id: r0.id }, say: '', intent: '' });
eq('撤退: 新攻击指令解除脱离状态', b0.fleeTo, null);
ok('撤退: 新指令重新锁定目标', !!b0.attackTarget);

// 自保反射也走同一条"纯脱离"通路，而不是挂着目标边走边还手
resetMember(b0, 20, 20);
b0.hp = Math.floor(b0.maxHp * 0.3);
b0.lastDamagedTimer = 10;
const dangerGrid = new Float32Array(MAP_WIDTH * MAP_HEIGHT);
dangerGrid[20 * MAP_WIDTH + 20] = 0.9;
world.danger = [null, null];
world.danger[TEAM_PLAYER] = dangerGrid;
const reflexAgent = am.agents.get(b0.memberKey);
reflexAgent.lastReflexFrame = -99999;
const withdrew = am._reflexWithdraw(reflexAgent, b0, world, 300);
ok('反射: 自保反射触发', withdrew);
ok('反射: 反射同样进入脱离状态', !!b0.fleeTo, JSON.stringify(b0.fleeTo));
eq('反射: 清空攻击/守卫目标', b0.attackTarget === null && b0.guardPos === null, true);
b0.fleeTo = null;

// ==================== 16. 视野 / 报点 / 标记 / 回血 ====================
// 视野半径：按角色/载具/空军分级
eq('视野: 侦察手看得更远', sightRangeOf({ memberKey: 'blue_3' }), 12);
eq('视野: 突击手默认视野', sightRangeOf({ memberKey: 'blue_1' }), 10);
eq('视野: 空军视野最远', sightRangeOf({ isAirUnit: true }), 14);
eq('视野: 乘驾载具视野提升', sightRangeOf({ mountType: 'tank' }), 12);

// 视线：只挡岩石与建筑，不挡水面（能看穿河）
let vmap16 = buildOpenMap();
ok('视线: 开阔草地可看', hasVisionLOS(vmap16, 2, 2, 10, 2));
vmap16.terrain[2][6] = ROCK;
ok('视线: 岩石挡视线', hasVisionLOS(vmap16, 2, 2, 10, 2) === false);
vmap16.terrain[2][6] = WATER;
ok('视线: 水面不挡视线', hasVisionLOS(vmap16, 2, 2, 10, 2));
vmap16.terrain[2][6] = GRASS;
vmap16.occupancy[2][6] = { isBuilding: true, dead: false };
ok('视线: 建筑挡视线', hasVisionLOS(vmap16, 2, 2, 10, 2) === false);

// canSee：距离 + 视线
vmap16 = buildOpenMap();
const vm16 = { x: 2, y: 2, isBuilding: false, size: 1 };
const ve16 = { x: 10, y: 2, dead: false, isBuilding: false, size: 1, team: TEAM_ENEMY };
ok('视野: 视野内开阔目标可见', canSee({ map: vmap16 }, vm16, ve16));
ok('视野: 超距目标不可见', canSee({ map: vmap16 }, vm16, { x: 20, y: 2, dead: false, isBuilding: false, size: 1, team: TEAM_ENEMY }) === false);
vmap16.occupancy[2][6] = { isBuilding: true, dead: false };
ok('视野: 被楼挡住不可见', canSee({ map: vmap16 }, vm16, ve16) === false);
ok('视野: 视野内建筑无需视线即可知', canSee({ map: vmap16 }, vm16, { x: 6, y: 2, dead: false, isBuilding: true, size: 1, team: TEAM_ENEMY }));

// 快照：视野 / 报点 / 标记 三种来源
resetMember(b0, flat.x, flat.y);              // 蓝1号
resetMember(r0, flat.x + 5, flat.y);          // 红1号 5 格外（开阔，可见）
resetMember(r1, 60, 60);                      // 红2号 挪远（不可见）
world.spatialDirty = true;
world.squadIntel[TEAM_PLAYER] = {};
world.squadIntel[TEAM_ENEMY] = {};
const snapCtx16 = {
  spec: specOf(b0), board: boardReal, events: [], allyMsgs: [], enemyMsgs: [],
  lastCommand: null, currentAction: null, godTargetId: 0,
};
const snapVis16 = JSON.parse(buildSnapshot(world, b0, snapCtx16));
ok('快照: 视野内敌人进入可选目标（来源=视野）', snapVis16['可选目标'].some((t) => t.id === r0.id && t['来源'] === '视野'), JSON.stringify(snapVis16['可选目标']));

world.squadIntel[TEAM_PLAYER][r1.id] = { x: r1.x, y: r1.y, atFrame: 1 };
const snapRep16 = JSON.parse(buildSnapshot(world, b0, snapCtx16));
ok('快照: 队友报点敌人以「报点」出现', snapRep16['可选目标'].some((t) => t.id === r1.id && t['来源'] === '报点'), JSON.stringify(snapRep16['可选目标']));

world.squadIntel[TEAM_PLAYER] = {};
const snapMark16 = JSON.parse(buildSnapshot(world, b0, Object.assign({}, snapCtx16, { godTargetId: r1.id })));
ok('快照: 上帝标记置顶为「标记」', snapMark16['可选目标'][0].id === r1.id && snapMark16['可选目标'][0]['来源'] === '标记', JSON.stringify(snapMark16['可选目标']));

// 右键标记：全队立即锁定
blueTeam.forEach((e, i) => resetMember(e, flat.x + i, flat.y));
const nMark16 = am.markEnemy(world, r0);
eq('标记: 己方三名成员受命', nMark16, 3);
ok('标记: 成员攻击目标立即就位', blueTeam.every((e) => e.attackTarget === r0));
eq('标记: godTargetId 挂上供快照使用', am.agents.get('blue_1').godTargetId, r0.id);

// 右键标记：带作用域只命令选中的成员（用另一目标 r1，避免与上面全员 godTargetId 混淆）
blueTeam.forEach((e, i) => resetMember(e, flat.x + i, flat.y));
const scopedMember16 = blueTeam[1];
const nMarkScope16 = am.markEnemy(world, r1, [scopedMember16]);
eq('标记: 作用域只命中选中成员', nMarkScope16, 1);
ok('标记: 仅被选中成员锁定目标', scopedMember16.attackTarget === r1 && blueTeam[0].attackTarget !== r1 && blueTeam[2].attackTarget !== r1);
const scopedKey16 = scopedMember16.memberKey;
const otherKeys16 = blueTeam.map((e) => e.memberKey).filter((k) => k !== scopedKey16);
ok('标记: 仅选中成员挂 godTargetId',
  am.agents.get(scopedKey16).godTargetId === r1.id && otherKeys16.every((k) => am.agents.get(k).godTargetId !== r1.id));

const hr16 = world.entities.find((e) => e.aiIgnore && !e.dead);
if (hr16) eq('标记: 不标记中立高楼', am.markEnemy(world, hr16), 0);

// 回血：脱战 + 基地附近 → 回血中；挨打/回满则否
const hq16 = findHQ(world, TEAM_PLAYER);
resetMember(b0, 5, 52);   // 基地西侧、距指挥所中心约 4 格（且离停机坪 >8，避免触发"上车"分支）
b0.hp = Math.floor(b0.maxHp * 0.3);
b0.lastDamagedTimer = 0;
ok('回血: 基地附近残血脱战=回血中', isRecovering(world, b0));
b0.lastDamagedTimer = 120;
ok('回血: 挨打中不算回血', isRecovering(world, b0) === false);
b0.lastDamagedTimer = 0;
b0.hp = Math.ceil(b0.maxHp * RECOVER_HP_RATIO);
ok('回血: 回满七成即视为可再战', isRecovering(world, b0) === false);

// 兜底：回血驻守 + 己方指挥所挨打回防
b0.hp = Math.floor(b0.maxHp * 0.3);
const dRecover16 = fallbackDecide(world, b0, { spec: specOf(b0), board: boardReal });
eq('兜底: 回血中驻守不反推', dRecover16.action, 'hold');
resetMember(b0, flat.x, flat.y);
b0.hp = b0.maxHp;
hq16.lastDamagedTimer = 120;
world.spatialDirty = true;
const dDefend16 = fallbackDecide(world, b0, { spec: specOf(b0), board: boardReal });
eq('兜底: 己方指挥所挨打回防', dDefend16.action, 'guard');
hq16.lastDamagedTimer = 0;

// ==================== 17. 上帝命令本地解析（零 token、当帧执行） ====================
const pCtx = { spec: specOf(b0), board: boardReal, frameCount: 1 };
const pRetreat = parseGodCommand(world, b0, '撤退！', pCtx);
ok('命令解析: 撤退口令命中', pRetreat.matched && pRetreat.decision.action === 'retreat', JSON.stringify(pRetreat));
eq('命令解析: 命令决策带 fromCommand 标记', pRetreat.decision.fromCommand, true);
eq('命令解析: 回防→guard', parseGodCommand(world, b0, '回防守家', pCtx).decision.action, 'guard');
eq('命令解析: 集合→move', parseGodCommand(world, b0, '全员集合', pCtx).decision.action, 'move');
const pAttack = parseGodCommand(world, b0, '全体进攻', pCtx);
eq('命令解析: 总攻指向敌方指挥所', pAttack.decision.action === 'attack_move' && pAttack.decision.target.id === boardReal.enemyHq.id, true);
eq('命令解析: 指名攻击敌方成员', parseGodCommand(world, b0, '打红1号', pCtx).decision.target.id, r0.id);
const pAck = parseGodCommand(world, b0, '蓝2号 撤退', pCtx);
eq('命令解析: 点名他人时只应声', pAck.matched && pAck.ackOnly, true);
const pSup = parseGodCommand(world, b0, '掩护蓝2号', pCtx);
ok('命令解析: 掩护队友→去支援', pSup.decision.action === 'move' && pSup.decision.intent.indexOf('蓝2号') >= 0, JSON.stringify(pSup));
eq('命令解析: 停火→hold', parseGodCommand(world, b0, '全部停火', pCtx).decision.action, 'hold');
eq('命令解析: 找掩体→cover', parseGodCommand(world, b0, '找掩体', pCtx).decision.action, 'cover');
eq('命令解析: 模糊口令交还 LLM', parseGodCommand(world, b0, '绕后偷袭他们的补给线', pCtx).matched, false);

// 命令当帧执行：解析出的撤退决策直接落到实体（不再等冷却/LLM 往返）
resetMember(b0, flat.x, flat.y);
am._applyDecision(am.agents.get(b0.memberKey), b0, world, 200, pRetreat.decision);
ok('命令执行: 撤退命令当帧进入脱离状态', !!b0.fleeTo, JSON.stringify(b0.fleeTo));
eq('命令执行: 赶路类命令挂 noAutoAcquire（防恋战）', b0.noAutoAcquire, true);
// 攻击类命令不受 noAutoAcquire 约束（就是要打）
am._applyDecision(am.agents.get(b0.memberKey), b0, world, 200, pAttack.decision);
eq('命令执行: 进攻命令解除赶路标记并锁定敌方指挥所', b0.noAutoAcquire === false && !!b0.attackTarget, true);

// ==================== 18. 命令点名：只有被点名的成员执行 ====================
// 补一辆敌方载具，保证"打敌方载具"命令有明确目标
world.entities.push({ id: 9101, name: '主战坦克', memberName: '主战坦克', team: TEAM_ENEMY, isBuilding: false, type2: 'vehicle', mountType: 'tank', x: 30, y: 12, dead: false });
const vehicleIds = world.entities.filter(function (e) {
  return !e.dead && e.team === TEAM_ENEMY && (e.type2 === 'vehicle' || e.mountType === 'tank' || e.mountType === 'apc');
}).map(function (e) { return e.id; });
eq('点名: 简写"2号"→他人只应声', parseGodCommand(world, b0, '2号 去攻击敌方载具', pCtx).ackOnly, true);
eq('点名: 中文数字"二号 撤退"→他人只应声', parseGodCommand(world, b0, '二号 撤退', pCtx).ackOnly, true);
const pSelf = parseGodCommand(world, b1, '2号 去攻击敌方载具', Object.assign({}, pCtx, { spec: specOf(b1) }));
ok('点名: 被点名者执行攻击载具命令', pSelf.matched && !pSelf.ackOnly && pSelf.decision.action === 'attack_move', JSON.stringify(pSelf));
ok('点名: 攻击目标锁定敌方载具', vehicleIds.indexOf(pSelf.decision.target.id) >= 0, JSON.stringify(pSelf.decision.target));
eq('点名: 拆载具用火箭筒', pSelf.decision.weapon, 'rocket');
const pEnemyName = parseGodCommand(world, b0, '红2号 撤退', pCtx);
ok('点名: "红2号"不算点蓝队队友', pEnemyName.matched && !pEnemyName.ackOnly && pEnemyName.decision.action === 'retreat', JSON.stringify(pEnemyName));
eq('点名: 无点名"全员进攻"→全员执行', parseGodCommand(world, b0, '全员进攻', pCtx).decision.action, 'attack_move');

// AgentManager 层：命令分发后只有被点名者行动，其余只应声
am.init({ config: DEFAULT_CONFIG, memberSystem: fakeMemberSystem, commandBus: bus, notify: function () {}, onChat: function () {} });
bus.sendCommand({ team: TEAM_PLAYER, type: 'text', text: '2号 去攻击敌方载具' });
blueTeam.forEach(function (e, i) { resetMember(e, flat.x + i, flat.y); e.noAutoAcquire = false; e.fleeTo = null; });
const ag1 = am.agents.get(b0.memberKey), ag2 = am.agents.get(b1.memberKey), ag3 = am.agents.get(b2.memberKey);
const okAll = am._tryExecuteCommandLocal(ag1, b0, world, 300, null) &&
             am._tryExecuteCommandLocal(ag2, b1, world, 300, null) &&
             am._tryExecuteCommandLocal(ag3, b2, world, 300, null);
ok('点名: 三人各自消费命令', okAll, '');
ok('点名: 蓝1/3号只应声不行动', !b0.attackTarget && !b0.attackMoveTarget && !b0.fleeTo && !b2.attackTarget && !b2.attackMoveTarget, '');
ok('点名: 蓝2号立即锁定敌方载具', vehicleIds.indexOf(ag2.currentOrderTargetId) >= 0 || (b1.attackTarget && vehicleIds.indexOf(b1.attackTarget.id) >= 0),
  JSON.stringify({ order: ag2.currentOrderTargetId, at: b1.attackTarget && b1.attackTarget.id }));
eq('点名: 蓝2号命令行动进行中（供完成后续接）', ag2.commandActive, true);

// ==================== 汇总 ====================
console.log('\n通过 ' + passed + ' 项' + (failures.length ? '，失败 ' + failures.length + ' 项：' : '，全部通过 ✅'));
failures.forEach((f) => console.log('  ✗ ' + f));
process.exit(failures.length ? 1 : 0);
