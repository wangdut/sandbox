// 提示词构建：成员人设 + 紧凑战场快照
//
// 设计要点（省 token 优先）：
//   1. 一次调用同时产出「台词」与「战术决策」，不拆成两次请求
//   2. 快照只放决策必需的字段，并用中文短键，压缩 prompt 体积
//   3. 明确给出「可选目标」及其 id，禁止模型自行编造坐标/id

import { TEAM_NAMES, TEAM_PLAYER } from '../constants.js';
import { WEAPONS } from '../sandbox/memberDefs.js';
import { HG_RANGE_BONUS, HG_DAMAGE_MULT, isRecovering } from '../sandbox/memberSystem.js';
import { UNIT_DEFS } from '../definitions.js';
import { isAIAutoTargetable } from './targeting.js';
import { reliefTiles, onSandbag, buildSquadBoard, squadBrief } from './squadBoard.js';
import { canSee } from './vision.js';

const ACTION_LIST = 'attack_move|attack|move|retreat|hold|guard|board|dismount|cover|highground';

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
    '【高地与掩体】地图上有山包和沙袋阵地。山顶是步兵专属战术位：站上去射程与伤害都有加成，适合伏击与观察报点；沙袋阵地能实实在在降低你受到的伤害，挨打时躲进去比硬站开阔地活得久。想占位直接把"动作"设为 highground（上最近空闲山顶）或 cover（进最近空闲沙袋阵地），系统会自己选格，不必你报坐标。车辆和飞行器都上不了山包与沙袋，乘载具时要主动让开这些地形给队友。',
    '【协同】你们三个人是一个班，快照里的「队友」写着每名队友的位置、血量、在打谁，「协同」写着谁在集火、谁在求援、哪些战术位还空着以及你的分工。必须照着配合：①「集火」出现时优先补它的火力，别各打各的；②「求援」出现时向那名队友靠拢形成交叉火力，而不是自己冲锋；③「空闲山顶」「空闲沙袋」是队友没占的位置，抢已被占的格子等于添乱；④按「分工」栏各就各位——侦察手上山顶观察报点，突击手与重装兵进沙袋正面压制，爆破手在掩体后远程点装甲与建筑；⑤三人不要扎堆在同一片格子上，一发炮弹就能把全班送走。',
    '【生存】血量低于一半就应脱离战斗、撤回己方指挥所回血；别和碉堡/炮塔硬刚，它们火力强、拆得慢——用火箭筒远程点掉或干脆绕开。',
    '【视野】你只能看到快照"可选目标"里来源为"视野"的敌人；来源为"报点"的是队友刚发现的远处目标，可据此决定支援、推进或回撤；来源为"标记"的是上帝为你确认的目标，必须优先攻击，不得以"不在视野"为由拒绝。',
    '【回血】脱离战斗约 3 秒后开始自动回血，回到己方指挥所附近回血更快；血量低就撤回指挥所，回满（或到七成）再重新投入战斗。',
    '【目标选择】优先摧毁敌方「指挥所」或击杀敌方成员；攻击"防御工事"收益低，除非它正好挡在必经之路。',
    '【楼房】地图上的中立「高楼大厦」是障碍物兼掩体：它不可通行，会截断双方的子弹与炮弹。看到"掩体"列表里的楼，要贴着它、绕到它背向来敌的一侧来躲火力；绝不要主动攻击它——拆楼既浪费火力又暴露位置，只有指挥官明确下令时才动手。',
    '【载具】己方指挥所旁停放着载具（主战坦克/装甲车/炮艇机/轰炸机），见"可用载具"列表（都是空闲的）。想上车：把"动作"设为 board、"目标"指向该载具 id，你会走过去乘驾，获得更强装甲与火力（对建筑伤害大增）；想下车：动作 dismount（无需目标）。乘驾中无法切换步兵武器；载具快被打爆时（血量低于四分之一）应 dismount 弃车保命。',
    '【台词】像游戏里的玩家说话，口语、自然，最多 40 字。不必刻意压短：可以把报点、分工、意图说清楚（例如"敌坦克从桥头过来了，我先卡住沙袋，等我绕侧"）。',
    '【喊话】"对谁"填"队友"表示协同交流（如报点、分工），只有本方队友能看到；偶尔也可以（不要频繁）填"敌方"来挑衅或劝降，这条是全场公开的；填 null 就是普通自语。',
    '【言行一致】台词必须与"动作"一致：说绕后就给 attack_move/move 并指向目标，说要撤就给 retreat。绝不出现"嘴上说要绕后，动作却是原地不动"。',
    '【执行反馈】"当前动作"字段是你上一条命令的执行情况：若"受阻"为真，说明上次的行动没走通，请换一条路线或换目标，不要重复同样的指令。',
    isHumanTeam
      ? '【指挥】你会收到「当前命令」——来自上帝玩家。必须回应，能执行就执行；认为不可行就说明理由并给出你的判断。命令若点名某个编号（如"蓝2号 撤退"），只有被点名的成员执行，其他成员只需回一句"收到"、不要越权抢着做；没点名才是给全班的。'
      : '【自主】本局没有上帝指挥你，一切自行判断：自主选择进攻/防守/撤退/换武器。',
    '',
    '【风格】直接给结论，不要输出推理过程或解释。',
    '【输出】只输出一个 JSON 对象（不要解释、不要 markdown 代码块），字段：',
    '{"台词":"≤40字","对谁":null或"队友"或"敌方","动作":"' + ACTION_LIST + '",' +
      '"目标":{"类型":"unit或building","id":数字} 或 {"类型":"position","x":数字,"y":数字} 或 null,' +
      '"武器":"机枪或火箭筒","说明":"≤24字的战术意图"}',
    '说明：动作 attack=打指定目标；attack_move=向目标区域推进并在途中交战；move=纯移动；retreat=撤回己方指挥所；hold=原地防守；guard=守卫己方指挥所周边；board=走向并乘驾"可用载具"里指定 id 的空载具；dismount=离开当前载具恢复步兵；cover=进入最近的空闲沙袋阵地并继续交战；highground=登上最近的空闲山顶观察位。cover 与 highground 不需要"目标"字段，系统会自己挑格。',
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

const TERRAIN_NAMES = ['草地', '水域', '矿石', '岩石', '混凝土', '沙地', '树林', '山包坡地', '山顶', '沙袋阵地'];

function nearestRelief(from, list) {
  let best = null, bd = Infinity;
  for (let i = 0; i < list.length; i++) {
    const dx = list[i].x + 0.5 - (from.x + 0.5), dy = list[i].y + 0.5 - (from.y + 0.5);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bd) { bd = d; best = list[i]; }
  }
  if (!best || bd > 30) return null;
  return { 位置: [best.x, best.y], 距离: Math.round(bd * 10) / 10 };
}

/** 脚下地形与可用战术位（山顶观察/伏击位、沙袋阵地） */
function terrainInfo(gameState, member) {
  const map = gameState.map;
  if (!map) return null;
  const tx = Math.floor(member.x), ty = Math.floor(member.y);
  const rel = reliefTiles(map);
  return {
    脚下: TERRAIN_NAMES[map.terrain[ty] && map.terrain[ty][tx]] || '草地',
    高地状态: member.onHighGround
      ? '已站上山顶：射程+' + HG_RANGE_BONUS + '、伤害+' + Math.round((HG_DAMAGE_MULT - 1) * 100) + '%，适合伏击与观察'
      : null,
    最近山顶: nearestRelief(member, rel.summits),
    最近沙袋: nearestRelief(member, rel.posts),
  };
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

  // 可选目标：只列「看得到」或「被报点/上帝标记」的敌人，最多 ~8 个。
  // 视野 = 距离 ≤ 视野半径 + 视线可达（高楼会挡住视线）；中立高楼走 isAIAutoTargetable 剔除。
  function findById(id) {
    for (let i = 0; i < gameState.entities.length; i++) if (gameState.entities[i].id === id) return gameState.entities[i];
    return null;
  }
  function targetEntry(e, source) {
    return {
      id: e.id,
      名称: e.name,
      类型: kindOf(e),
      种类: e.isBuilding ? 'building' : 'unit',
      距离: distTiles(member, e),
      血量: Math.ceil(e.hp) + '/' + e.maxHp,
      位置: tileOf(e),
      来源: source,
    };
  }
  const enemies = [];
  const seenIds = {};
  // 1) 上帝标记：无论是否可见都置顶——上帝已替你确认该目标存在，必须优先打
  const marked = ctx.godTargetId != null ? findById(ctx.godTargetId) : null;
  if (marked && !marked.dead && !marked.aiIgnore && marked.team !== member.team) {
    enemies.push(targetEntry(marked, '标记'));
    seenIds[marked.id] = true;
  }
  // 2) 自己视野内的敌人（近者优先）
  gameState.entities
    .filter(function (e) { return isAIAutoTargetable(e, member.team) && canSee(gameState, member, e); })
    .sort(function (a, b) { return distTiles(member, a) - distTiles(member, b); })
    .forEach(function (e) {
      if (enemies.length >= 6) return;
      if (seenIds[e.id]) return;
      enemies.push(targetEntry(e, '视野'));
      seenIds[e.id] = true;
    });
  // 3) 队友报点：squadIntel 里队友最近看见、自己当前看不到的远处敌人
  const intel = gameState.squadIntel ? gameState.squadIntel[member.team] : null;
  if (intel) {
    for (const id in intel) {
      if (enemies.length >= 8) break;
      const e = findById(Number(id));
      if (!e || e.dead || seenIds[e.id]) continue;
      if (!isAIAutoTargetable(e, member.team)) continue;
      enemies.push(targetEntry(e, '报点'));
      seenIds[e.id] = true;
    }
  }

  const squad = buildSquadBoard(gameState, member);
  const mates = squad.mates.map(function (e) {
    let 状态 = e.attackTarget ? '交战中' : (e.path && e.path.length ? '移动中' : '待命');
    if (e.onHighGround) 状态 = '占山顶' + (e.attackTarget ? '并开火' : '');
    else if (onSandbag(gameState.map, e)) 状态 = '进沙袋' + (e.attackTarget ? '并开火' : '');
    return {
      名称: e.memberName,
      血量: Math.ceil(e.hp) + '/' + e.maxHp,
      距离: distTiles(member, e),
      状态: 状态,
      位置: tileOf(e),
      正在打: e.attackTarget && !e.attackTarget.dead ? e.attackTarget.memberName || e.attackTarget.name : null,
    };
  });

  // 己方可乘驾载具（停放中），供成员自主选择上车
  const mounts = gameState.entities
    .filter(function (e) { return !e.dead && e.isMount && e.team === member.team; })
    .map(function (e) {
      return { id: e.id, 名称: e.name, 距离: distTiles(member, e), 位置: tileOf(e) };
    });

  // 邻近障碍/掩体：中立高楼会截断双方直射弹道，可贴着它走位躲火力；它不是猎物
  const covers = gameState.entities
    .filter(function (e) { return !e.dead && e.aiIgnore; })
    .map(function (e) { return { e: e, d: distTiles(member, e) }; })
    .filter(function (o) { return o.d <= 16; })
    .sort(function (a, b) { return a.d - b.d; })
    .slice(0, 3)
    .map(function (o) {
      return { 名称: o.e.name, 距离: o.d, 位置: tileOf(o.e), 定位: '障碍/挡弹掩体，非攻击目标（除非指挥官下令拆）' };
    });

  const snap = {
    你是: TEAM_NAMES[member.team] + '·' + member.memberName,
    自身: {
      状态: isRecovering(gameState, member) ? '回血中'
        : (member.attackTarget ? '交战中' : (member.path && member.path.length ? '移动中' : '待命')),
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
    掩体: covers,
    地形: terrainInfo(gameState, member),
    队友: mates,
    协同: squadBrief(squad),
    最近事件: ctx.events.slice(-4),
    队友消息: ctx.allyMsgs.slice(-3),
    敌方喊话: ctx.enemyMsgs.slice(-3),
  };
  return JSON.stringify(snap);
}
