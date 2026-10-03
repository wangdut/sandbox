// 本地 mock LLM 端点（开发/测试用，不属于游戏运行时）
//
// 作用：在没有真实 API Key 的情况下，端到端验证「快照 → 提示词 → 解析 → 执行 → 喊话」
// 整条链路。它按 OpenAI /chat/completions 协议应答，返回合法的成员决策 JSON。
//
// 用法：
//   node tools/mock-llm.mjs            # 监听 8899
//   然后在 config.html 里把 API 地址填成 http://localhost:8899/v1 ，模型名随意（如 mock）
//   Key 随意填一个非空值（如 test）
//
// 决策规则（确定性，便于断言）：
//   · 乘驾中且载具血量<25% → dismount（弃车保命）
//   · 血量低于 40%          → retreat（撤回指挥所）
//   · ≥2 名队友锁定同一目标 → attack 该目标（集火，优先于自己另找目标）
//   · 射程内有目标（≤6格）  → attack 最近目标
//   · 有目标在 12 格内      → attack_move 该目标
//   · 步兵且 10 格内有空车、12 格内无敌人 → board 该载具
//   · 协同栏出现「求援」    → attack_move 靠向残血队友（支援）
//   · 空闲且按分工          → 侦察手 highground、其余 cover（战术位由引擎挑格）
//   · 否则                  → attack_move 敌方指挥所（火箭筒）
//   台词会带上触发的命令/战况；红2号会尝试对敌方喊话，蓝1号会呼叫队友配合（长台词验证 40 字显示）。

import http from 'node:http';

const PORT = process.env.MOCK_PORT || 8899;

function parseSnapshot(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    try { return JSON.parse(messages[i].content); } catch (e) { /* 继续找 */ }
  }
  return null;
}

function num(v) {
  const n = Number(String(v).split('/')[0]);
  return Number.isFinite(n) ? n : 0;
}

function decide(snap) {
  const name = (snap['你是'] || '').split('·')[1] || '成员';
  const self = snap['自身'] || {};
  const hpNow = num(self['血量']);
  const hpMax = num((self['血量'] || '').split('/')[1]) || hpNow || 1;
  const targets = snap['可选目标'] || [];
  const cmd = snap['当前命令'];
  const allies = snap['队友'] || [];
  const heard = (snap['敌方喊话'] || []).length > 0;

  const kindOf = (t) => (String(t['类型'] || '').indexOf('建筑') >= 0 || String(t['类型'] || '').indexOf('指挥所') >= 0) ? 'building' : 'unit';
  const nearest = targets.slice().sort((a, b) => a['距离'] - b['距离'])[0] || null;
  const mounts = snap['可用载具'] || [];
  const mounted = !!self['载具'];
  const hpRatio = hpMax > 0 ? hpNow / hpMax : 1;
  const brief = snap['协同'] || {};
  const terrain = snap['地形'] || {};
  const role = String(brief['分工'] || '').split('：')[0];   // 突击手/爆破手/侦察手/重装兵

  // 集火：把队友「正在打」的统计成票数，再回到可选目标里取 id（模型只会说名字，id 必须来自目标表）
  function focusTarget() {
    const votes = {};
    const cur = snap['当前动作'] || {};
    if (cur['目标'] && (cur['动作'] === 'attack' || cur['动作'] === 'attack_move')) votes[cur['目标']] = 1;
    allies.forEach(function (a) { const n = a['正在打']; if (n) votes[n] = (votes[n] || 0) + 1; });
    let name = null, best = 0;
    Object.keys(votes).forEach(function (k) { if (votes[k] > best) { best = votes[k]; name = k; } });
    if (!name || best < 2) return null;
    return targets.filter(function (t) { return t['名称'] === name; })[0] || null;
  }
  const focus = focusTarget();
  const strike = focus && focus['距离'] <= 12 ? focus : nearest;

  function allyRatio(a) {
    const cur = num(a['血量']);
    const max = num(String(a['血量'] || '').split('/')[1]) || cur || 1;
    return max > 0 ? cur / max : 1;
  }

  // 载具快被打爆 → 弃车保命（触发弹射/下车链路）
  if (mounted && hpRatio < 0.25) {
    return {
      台词: '载具要炸了，弃车！',
      对谁: null,
      动作: 'dismount',
      目标: null,
      武器: '机枪',
      说明: '弃车保命',
    };
  }

  // 步兵、近处有空车、附近没敌人、血量健康 → 上车
  if (!mounted && hpRatio >= 0.6 && !(nearest && nearest['距离'] <= 12)) {
    const free = mounts.slice().sort((a, b) => a['距离'] - b['距离'])[0] || null;
    if (free && free['距离'] <= 10) {
      return {
        台词: '我上' + (free['名称'] || '载具') + '！',
        对谁: null,
        动作: 'board',
        目标: { 类型: 'unit', id: free.id },
        说明: '乘驾载具再战',
      };
    }
  }

  // 血量过低 → 撤退
  if (hpMax > 0 && hpNow / hpMax < 0.4) {
    return {
      台词: '撑不住了，我先撤回防！',
      对谁: null,
      动作: 'retreat',
      目标: { 类型: 'position', x: (snap['指挥所'] || {})['己方位置'] ? snap['指挥所']['己方位置'][0] : 6, y: (snap['指挥所'] || {})['己方位置'] ? snap['指挥所']['己方位置'][1] : 32 },
      武器: '机枪',
      说明: '低血撤退',
    };
  }

  const enemyHqPos = (snap['指挥所'] || {})['敌方位置'] || [33, 8];

  // 已占住战术位且近处有敌人：就地守着打伏击（和脚本兜底同一规则，防止反复上下山）
  const onSpot = terrain['脚下'] === '山顶' || terrain['脚下'] === '沙袋阵地';
  if (onSpot && targets.some(function (t) { return t['距离'] <= 14; })) {
    return {
      台词: terrain['脚下'] === '山顶'
        ? '我在山顶观察位盯着，来敌我全看见了，队友放心压上。'
        : '沙袋阵地卡住了，他的直射伤不到我，你们从两侧绕。',
      对谁: '队友',
      动作: 'hold',
      目标: null,
      武器: '机枪',
      说明: '驻守战术位',
    };
  }

  if (strike && strike['距离'] <= 6) {
    return {
      台词: strike === focus ? '我看到' + strike['名称'] + '了，集火它，我补炮！' : '接敌，开火！',
      对谁: strike === focus ? '队友' : null,
      动作: 'attack',
      目标: { 类型: kindOf(strike), id: strike.id },
      武器: kindOf(strike) === 'building' ? '火箭筒' : '机枪',
      说明: strike === focus ? '配合队友集火' : '歼灭近处目标',
    };
  }

  if (strike && strike['距离'] <= 12) {
    return {
      台词: strike === focus ? '队友在打' + strike['名称'] + '，我压上去一起收拾它！' : '发现敌人，压上去！',
      对谁: strike === focus ? '队友' : null,
      动作: 'attack_move',
      目标: { 类型: kindOf(strike), id: strike.id },
      武器: kindOf(strike) === 'building' ? '火箭筒' : '机枪',
      说明: strike === focus ? '集火并接近' : '接近交战',
    };
  }

  // 支援：协同栏点名了残血交火的队友，先靠过去组交叉火力，别自己往前冲
  if (brief['求援']) {
    const weak = allies.filter(function (a) { return a['位置'] && allyRatio(a) < 0.55; })
      .sort(function (a, b) { return a['距离'] - b['距离']; })[0] || null;
    if (weak) {
      return {
        台词: weak['名称'] + ' 顶住，我往你那边靠，交叉火力别扎堆！',
        对谁: '队友',
        动作: 'attack_move',
        目标: { 类型: 'position', x: weak['位置'][0], y: weak['位置'][1] },
        武器: '机枪',
        说明: '支援队友',
      };
    }
  }

  // 由上帝命令驱动的推进（回应命令的同时给出战术）
  if (cmd) {
    const toEnemy = cmd['内容'] && (cmd['内容'].indexOf('进攻') >= 0 || cmd['内容'].indexOf('总攻') >= 0);
    return {
      台词: '收到！' + (toEnemy ? '我从中路推进。' : '按你的意思办。'),
      对谁: null,
      动作: 'attack_move',
      目标: { 类型: 'building', id: findHqId(snap) },
      武器: '火箭筒',
      说明: toEnemy ? '执行进攻命令' : '执行命令',
    };
  }

  // 空闲时按分工抢战术位：cover / highground 不带目标，引擎自己挑没被队友占的格
  if (!mounted && terrain['最近沙袋']) {
    if (role === '侦察手' && terrain['最近山顶'] && terrain['脚下'] !== '山顶') {
      return {
        台词: '我去山顶占观察位，那边视野好，先给你们报点再开火。',
        对谁: '队友',
        动作: 'highground',
        目标: null,
        武器: '机枪',
        说明: '占高地观察报点',
      };
    }
    if (role !== '侦察手' && terrain['脚下'] !== '沙袋阵地') {
      return {
        台词: '我进最近的沙袋阵地架枪，正面替你们吃直射火力。',
        对谁: '队友',
        动作: 'cover',
        目标: null,
        武器: '机枪',
        说明: '进沙袋建火力点',
      };
    }
  }

  // 空闲：尝试社交（覆盖阵营内协作与跨阵营喊话两条链路）
  let to = null;
  let line = null;
  if (name === '红2号' && !heard) {
    to = '敌方';
    line = '蓝方，投降吧，你们守不住的。';
  } else if (name === '蓝1号' && allies.length > 0) {
    to = '队友';
    line = '蓝2号，我从正面压，你绕后面！';
  }

  return {
    台词: line || '向敌方指挥所推进。',
    对谁: to,
    动作: 'attack_move',
    目标: { 类型: 'building', id: findHqId(snap) },
    武器: '火箭筒',
    说明: '自主进攻',
  };
}

/** 快照里的敌方指挥所 id：从可选目标里找，找不到就退回第一个建筑 */
function findHqId(snap) {
  const targets = snap['可选目标'] || [];
  const hq = targets.find((t) => String(t['类型'] || '').indexOf('指挥所') >= 0);
  if (hq) return hq.id;
  const b = targets.find((t) => String(t['类型'] || '').indexOf('建筑') >= 0);
  return b ? b.id : 0;
}

const server = http.createServer((req, res) => {
  if (!/\/chat\/completions$/.test(req.url.split('?')[0])) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock 只实现了 /chat/completions' } }));
    return;
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch (e) { /* 忽略 */ }
    const snap = parseSnapshot(body.messages || []);
    const decision = snap ? decide(snap) : { 台词: '...', 对谁: null, 动作: 'hold', 目标: null, 说明: '无快照' };
    const content = JSON.stringify(decision);
    const promptChars = raw.length;
    const latency = 300 + Math.floor(Math.random() * 500);
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock-' + Date.now(),
        object: 'chat.completion',
        model: body.model || 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: Math.ceil(promptChars / 3),
          completion_tokens: Math.ceil(content.length / 3),
          total_tokens: Math.ceil((promptChars + content.length) / 3),
        },
      }));
    }, latency);
  });
});

server.listen(PORT, () => {
  console.log(`mock LLM 端点已启动: http://localhost:${PORT}/v1  （把它填进 config.html 的 API 地址）`);
});
