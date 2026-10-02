// 零 API 成本的断言脚本：覆盖 token 成本控制与协议解析这些"错了很贵"的纯逻辑
//
// 运行：npm test    （或 node tools/test-agents.mjs）
// 不依赖浏览器、不调用任何 LLM。

import { canDeliverShout, AgentManager } from '../src/agents/AgentManager.js';
import { parseDecision } from '../src/agents/parser.js';
import { CommandBus } from '../src/core/commandBus.js';
import { MEMBERS, WEAPONS, applyWeapon } from '../src/sandbox/memberDefs.js';
import { fallbackDecide, quickCommandDecision } from '../src/agents/FallbackAI.js';
import { buildSystemPrompt, buildSnapshot } from '../src/agents/prompts.js';
import { DEFAULT_CONFIG, resolveMemberAuth, isAgentEnabled, migrateConfig } from '../src/agents/config.js';
import { DEFENSE_DEFS, UNIT_DEFS } from '../src/definitions.js';
import { GameMap } from '../src/GameMap.js';
import { FPS, TEAM_PLAYER, TEAM_ENEMY, GRASS, MAP_WIDTH, MAP_HEIGHT } from '../src/constants.js';

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
ok('解析: move 需位置目标', !parseDecision('{"台词":"x","动作":"move","目标":{"类型":"unit","id":2}}').ok);
ok('解析: 空内容给出可读错误', /max_tokens|未返回内容/.test(parseDecision('').error));

const longSay = parseDecision('{"台词":"' + '字'.repeat(40) + '","对谁":"敌人","动作":"hold","目标":null}');
ok('解析: 台词截断到 20 字', longSay.ok && longSay.decision.say.length === 20);
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
eq('成员: 名册共 4 人', MEMBERS.length, 4);
eq('成员: 每方 2 人', MEMBERS.filter((m) => m.team === TEAM_PLAYER).length + '/' + MEMBERS.filter((m) => m.team === TEAM_ENEMY).length, '2/2');
const fakeUnit = { weaponMode: 'mg', damage: 14, range: 4.5, fireRate: 20, damageType: 'bullet', antiArmor: false, splashRadius: 0 };
applyWeapon(fakeUnit, 'rocket');
eq('武器: 切火箭筒改伤害', fakeUnit.damage, WEAPONS.rocket.damage);
eq('武器: 切火箭筒改伤害类型', fakeUnit.damageType, 'rocket');
ok('武器: 火箭筒具备反装甲', fakeUnit.antiArmor === true);

// ==================== 5. 兜底 AI（无 Key 时也要能打） ====================
function makeGameState(opts) {
  const enemyHq = { id: 9, name: '指挥所', team: TEAM_ENEMY, isBuilding: true, size: 3, x: 32, y: 7, hp: 1800, maxHp: 1800, dead: false, getCenterX: () => 1072, getCenterY: () => 272 };
  const ownHq = { id: 1, name: '指挥所', team: TEAM_PLAYER, isBuilding: true, size: 3, x: 5, y: 30, hp: 1800, maxHp: 1800, dead: false, getCenterX: () => 208, getCenterY: () => 1008 };
  const enemy = { id: 20, name: '烈焰', team: TEAM_ENEMY, isMember: true, type2: 'infantry', x: 10, y: 34, hp: 300, maxHp: 380, dead: false, getCenterX: () => 336, getCenterY: () => 1104 };
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

// ==================== 6. 提示词与快照契约 ====================
const sys = buildSystemPrompt(MEMBERS[0]);
ok('提示词: 含人设姓名', sys.includes(MEMBERS[0].name));
ok('提示词: 含 JSON 字段说明', sys.includes('台词') && sys.includes('attack_move'));
ok('提示词: 明确要求纯 JSON', sys.includes('只输出一个 JSON'));
ok('提示词: 人类阵营提及上帝命令', buildSystemPrompt(MEMBERS[0]).includes('上帝'));
ok('提示词: 电脑阵营为自主模式', buildSystemPrompt(MEMBERS[2]).includes('自主'));
const snap = buildSnapshot(makeGameState({ withEnemyInRange: true }), { ...memberLow, hp: 380, maxHp: 380, weaponMode: 'mg', fireCooldown: 0, memberName: '雷霆', type2: 'infantry', x: 5, y: 34, getCenterX: () => 176, getCenterY: () => 1104 }, {
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

am._handleChat(blue1, fakeMemberEntity, gs, 1000, { say: '雷霆掩护我', to: '队友' });
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
eq('数值: 成员移速已降到 1.2（原 2.0 的 60%）', UNIT_DEFS.member.speed, 1.2);
ok('数值: 成员血量上调', UNIT_DEFS.member.hp >= 420);
ok('数值: 碉堡射速下调（更慢的压制节奏）', DEFENSE_DEFS.pillbox.fireRate >= 40);

// ==================== 汇总 ====================
console.log('\n通过 ' + passed + ' 项' + (failures.length ? '，失败 ' + failures.length + ' 项：' : '，全部通过 ✅'));
failures.forEach((f) => console.log('  ✗ ' + f));
process.exit(failures.length ? 1 : 0);
