// 提示词构建：成员人设 + 紧凑战场快照
//
// 设计要点（省 token 优先）：
//   1. 一次调用同时产出「台词」与「战术决策」，不拆成两次请求
//   2. 快照只放决策必需的字段，并用中文短键，压缩 prompt 体积
//   3. 明确给出「可选目标」及其 id，禁止模型自行编造坐标/id

import { TEAM_NAMES, TEAM_PLAYER } from '../constants.js';
import { WEAPONS } from '../sandbox/memberDefs.js';

const ACTION_LIST = 'attack_move|attack|move|retreat|hold|guard';

/** 成员的固定人设 system prompt */
export function buildSystemPrompt(spec) {
  const teamName = TEAM_NAMES[spec.team];
  const isHumanTeam = spec.team === TEAM_PLAYER;
  const lines = [
    '你是「' + spec.name + '」，' + teamName + '阵营的虚拟士兵，正在一场红警风格的即时战术沙盘里作战。',
    '性格：' + spec.persona,
    '',
    '【目标】与队友配合，摧毁敌方「指挥所」；同时保护己方指挥所。',
    '【武器】机枪：射速快、专杀步兵，对建筑几乎无效；火箭筒：拆建筑/破装甲，射速慢。可用"武器"字段请求切换。',
    '【地形】地图 40×40。敌方指挥所旁有碉堡与重炮塔：进入其射程会被持续压制，从防御薄弱的方位（如基地背面）进攻更明智。',
    '【生存】血量低时撤退到己方指挥所附近可以缓慢回血；阵亡后 30 秒自动重生，但会浪费时间。',
    '【台词】像游戏里的玩家说话，口语、简短，最多 20 字，不要长篇大论。',
    '【喊话】"对谁"填"队友"表示协同交流（如报点、分工）；偶尔也可以（不要频繁）填"敌方"来挑衅或劝降；填 null 就是普通自语。',
    isHumanTeam
      ? '【指挥】你会收到「当前命令」——来自上帝玩家。必须回应，能执行就执行；认为不可行就说明理由并给出你的判断。'
      : '【自主】本局没有上帝指挥你，一切自行判断：自主选择进攻/防守/撤退/换武器。',
    '',
    '【风格】直接给结论，不要输出推理过程或解释。',
    '【输出】只输出一个 JSON 对象（不要解释、不要 markdown 代码块），字段：',
    '{"台词":"≤20字","对谁":null或"队友"或"敌方","动作":"' + ACTION_LIST + '",' +
      '"目标":{"类型":"unit或building","id":数字} 或 {"类型":"position","x":数字,"y":数字} 或 null,' +
      '"武器":"机枪或火箭筒","说明":"≤15字的战术意图"}',
    '说明：动作 attack=打指定目标；attack_move=向目标区域推进并在途中交战；move=纯移动；retreat=撤回己方指挥所；hold=原地防守；guard=守卫己方指挥所周边。',
    '若无需切换武器，"武器"可省略。',
  ];
  return lines.join('\n');
}

function tileOf(e) {
  return [Math.floor(e.x), Math.floor(e.y)];
}

function distTiles(a, b) {
  const ax = a.x + (a.isBuilding ? a.size / 2 : 0.5);
  const ay = a.y + (a.isBuilding ? a.size / 2 : 0.5);
  const bx = b.x + (b.isBuilding ? b.size / 2 : 0.5);
  const by = b.y + (b.isBuilding ? b.size / 2 : 0.5);
  return Math.round(Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by)) * 10) / 10;
}

function kindOf(e) {
  if (e.isMember) return '成员';
  if (e.isBuilding) return e.type === 'base' ? '指挥所' : '建筑';
  return '单位';
}

/**
 * 构造战场快照（user 消息内容）
 * @param gameState 游戏状态
 * @param member 该成员实体
 * @param ctx { lastCommand, events, allyMsgs, enemyMsgs, board }
 */
export function buildSnapshot(gameState, member, ctx) {
  const spec = ctx.spec;
  const ownHq = ctx.board.ownHq;
  const enemyHq = ctx.board.enemyHq;
  const weapon = WEAPONS[member.weaponMode] || WEAPONS.mg;

  // 可选目标：射程/视野内最近的敌方单位与建筑（含防御工事），最多 6 个
  const enemies = gameState.entities
    .filter(function (e) { return !e.dead && e.team !== member.team; })
    .map(function (e) { return { e: e, d: distTiles(member, e) }; })
    .filter(function (o) { return o.d <= 22; })
    .sort(function (a, b) { return a.d - b.d; })
    .slice(0, 6)
    .map(function (o) {
      return {
        id: o.e.id,
        名称: o.e.name,
        类型: kindOf(o.e),
        种类: o.e.isBuilding ? 'building' : 'unit',
        距离: o.d,
        血量: Math.ceil(o.e.hp) + '/' + o.e.maxHp,
        位置: tileOf(o.e),
      };
    });

  const mates = gameState.entities
    .filter(function (e) { return !e.dead && e.isMember && e.team === member.team && e !== member; })
    .map(function (e) {
      return {
        名称: e.memberName,
        血量: Math.ceil(e.hp) + '/' + e.maxHp,
        距离: distTiles(member, e),
        状态: e.attackTarget ? '交战中' : (e.path && e.path.length ? '移动中' : '待命'),
        位置: tileOf(e),
      };
    });

  const snap = {
    你是: TEAM_NAMES[member.team] + '·' + member.memberName,
    自身: {
      血量: Math.ceil(member.hp) + '/' + member.maxHp,
      位置: tileOf(member),
      武器: weapon.name,
      装填进度: member.fireCooldown > 0 ? '冷却中' : '就绪',
    },
    指挥所: {
      己方: ownHq ? Math.ceil(ownHq.hp) + '/' + ownHq.maxHp : '已失守',
      己方位置: ownHq ? tileOf(ownHq) : null,
      敌方: enemyHq ? Math.ceil(enemyHq.hp) + '/' + enemyHq.maxHp : '已摧毁',
      敌方位置: enemyHq ? tileOf(enemyHq) : null,
    },
    当前命令: ctx.lastCommand
      ? { 内容: ctx.lastCommand.text, 秒前: Math.round((Date.now() - ctx.lastCommand.at) / 1000), 来源: '上帝' }
      : null,
    可选目标: enemies,
    队友: mates,
    最近事件: ctx.events.slice(-4),
    队友消息: ctx.allyMsgs.slice(-3),
    敌方喊话: ctx.enemyMsgs.slice(-3),
  };
  return JSON.stringify(snap);
}
