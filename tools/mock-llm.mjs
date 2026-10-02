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
//   · 血量低于 40%          → retreat（撤回指挥所）
//   · 射程内有目标（≤6格）  → attack 最近目标
//   · 有目标在 12 格内      → attack_move 该目标
//   · 否则                  → attack_move 敌方指挥所（火箭筒）
//   台词会带上触发的命令/战况；夜枭会尝试对敌方喊话，雷霆会尝试呼叫队友配合。

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

  if (nearest && nearest['距离'] <= 6) {
    return {
      台词: '接敌，开火！',
      对谁: null,
      动作: 'attack',
      目标: { 类型: kindOf(nearest), id: nearest.id },
      武器: kindOf(nearest) === 'building' ? '火箭筒' : '机枪',
      说明: '歼灭近处目标',
    };
  }

  if (nearest && nearest['距离'] <= 12) {
    return {
      台词: '发现敌人，压上去！',
      对谁: null,
      动作: 'attack_move',
      目标: { 类型: kindOf(nearest), id: nearest.id },
      武器: kindOf(nearest) === 'building' ? '火箭筒' : '机枪',
      说明: '接近交战',
    };
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

  // 空闲：尝试社交（覆盖阵营内协作与跨阵营喊话两条链路）
  let to = null;
  let line = null;
  if (name === '夜枭' && !heard) {
    to = '敌方';
    line = '蓝方，投降吧，你们守不住的。';
  } else if (name === '雷霆' && allies.length > 0) {
    to = '队友';
    line = '寒鸦，我从正面压，你绕后面！';
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
