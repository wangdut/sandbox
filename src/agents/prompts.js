// 提示词构建：成员人设 + 紧凑战场快照
//
// 设计要点（省 token 优先）：
//   1. 一次调用同时产出「台词」与「战术决策」，不拆成两次请求
//   2. 快照只放决策必需的字段，并用中文短键，压缩 prompt 体积
//   3. 明确给出「可选目标」及其 id，禁止模型自行编造坐标/id

import { TEAM_NAMES, TEAM_PLAYER } from '../constants.js';
import { WEAPONS } from '../sandbox/memberDefs.js';
import { UNIT_DEFS } from '../definitions.js';

const ACTION_LIST = 'attack_move|attack|move|retreat|hold|guard|board|dismount';

/** 成员的固定人设 system prompt
 * @param spec 成员名册条目
 * @param humanTeam 上帝玩家操控的队伍（决定该成员是"听指挥"还是"自主"）
 */
export function buildSystemPrompt(spec, humanTeam) {
  const teamName = TEAM_NAMES[spec.team];
  const isHumanTeam = spec.team === humanTeam;
  const lines = [
    '你是「' + spec.name + '」，' + teamName + '阵营的虚拟士兵，正在一场红警风格的即时战术沙盘里作战。',
    '性格：' + spec.persona,
    '',
    '【目标】与队友配合，摧毁敌方「指挥所」；同时保护己方指挥所。',
    '【武器】机枪：射速快、专杀步兵，对建筑几乎无效；火箭筒：拆建筑/破装甲，射速慢。可用"武器"字段请求切换。',
    '【地形】地图 64×64。敌方指挥所旁有碉堡与重炮塔：进入其射程会被持续压制，从防御薄弱的方位（如基地背面）进攻更明智。系统寻路已会自动绕开防御射程。',
    '【生存】血量低于一半就应脱离战斗、撤回己方指挥所回血；别和碉堡/炮塔硬刚，它们火力强、拆得慢——用火箭筒远程点掉或干脆绕开。',
    '【目标选择】优先摧毁敌方「指挥所」或击杀敌方成员；攻击"防御工事"收益低，除非它正好挡在必经之路。',
    '【载具】己方指挥所旁停放着载具（主战坦克/装甲车/炮艇机/轰炸机），见"可用载具"列表（都是空闲的）。想上车：把"动作"设为 board、"目标"指向该载具 id，你会走过去乘驾，获得更强装甲与火力（对建筑伤害大增）；想下车：动作 dismount（无需目标）。乘驾中无法切换步兵武器；载具快被打爆时（血量低于四分之一）应 dismount 弃车保命。',
    '【台词】像游戏里的玩家说话，口语、简短，最多 20 字，不要长篇大论。',
    '【喊话】"对谁"填"队友"表示协同交流（如报点、分工），只有本方队友能看到；偶尔也可以（不要频繁）填"敌方"来挑衅或劝降，这条是全场公开的；填 null 就是普通自语。',
    '【言行一致】台词必须与"动作"一致：说绕后就给 attack_move/move 并指向目标，说要撤就给 retreat。绝不出现"嘴上说要绕后，动作却是原地不动"。',
    '【执行反馈】"当前动作"字段是你上一条命令的执行情况：若"受阻"为真，说明上次的行动没走通，请换一条路线或换目标，不要重复同样的指令。',
    isHumanTeam
      ? '【指挥】你会收到「当前命令」——来自上帝玩家。必须回应，能执行就执行；认为不可行就说明理由并给出你的判断。'
      : '【自主】本局没有上帝指挥你，一切自行判断：自主选择进攻/防守/撤退/换武器。',
    '',
    '【风格】直接给结论，不要输出推理过程或解释。',
    '【输出】只输出一个 JSON 对象（不要解释、不要 markdown 代码块），字段：',
    '{"台词":"≤20字","对谁":null或"队友"或"敌方","动作":"' + ACTION_LIST + '",' +
      '"目标":{"类型":"unit或building","id":数字} 或 {"类型":"position","x":数字,"y":数字} 或 null,' +
      '"武器":"机枪或火箭筒","说明":"≤15字的战术意图"}',
    '说明：动作 attack=打指定目标；attack_move=向目标区域推进并在途中交战；move=纯移动；retreat=撤回己方指挥所；hold=原地防守；guard=守卫己方指挥所周边；board=走向并乘驾"可用载具"里指定 id 的空载具；dismount=离开当前载具恢复步兵。',
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
  if (e.isBuilding) {
    if (e.type === 'base') return '指挥所';
    if (e.category === 'defenses') return '防御工事';
    return '建筑';
  }
  if (e.mountType) return '载具';
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

  // 己方可乘驾载具（停放中），供成员自主选择上车
  const mounts = gameState.entities
    .filter(function (e) { return !e.dead && e.isMount && e.team === member.team; })
    .map(function (e) {
      return { id: e.id, 名称: e.name, 距离: distTiles(member, e), 位置: tileOf(e) };
    });

  const snap = {
    你是: TEAM_NAMES[member.team] + '·' + member.memberName,
    自身: {
      血量: Math.ceil(member.hp) + '/' + member.maxHp,
      位置: tileOf(member),
      武器: member.mountType
        ? '载具·' + ((UNIT_DEFS[member.mountType] && UNIT_DEFS[member.mountType].name) || member.mountType)
        : weapon.name,
      载具: member.mountType || null,
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
    当前动作: ctx.currentAction || null,
    可选目标: enemies,
    可用载具: mounts,
    队友: mates,
    最近事件: ctx.events.slice(-4),
    队友消息: ctx.allyMsgs.slice(-3),
    敌方喊话: ctx.enemyMsgs.slice(-3),
  };
  return JSON.stringify(snap);
}
