// 决策解析：把模型输出规整成可信的决策对象
//
// 模型可能返回代码块围栏、前后缀解释、字段缺失或中文武器名，
// 这里统一清洗；解析失败返回 { ok:false }，由 AgentManager 降级到脚本 AI。

import { WEAPONS } from '../sandbox/memberDefs.js';

export const ACTIONS = ['attack_move', 'attack', 'move', 'retreat', 'hold', 'guard', 'board', 'dismount'];
const MOVE_ACTIONS = ['attack_move', 'move', 'retreat'];

const WEAPON_ALIAS = {
  '机枪': 'mg', '机关枪': 'mg', 'mg': 'mg', 'machinegun': 'mg',
  '火箭筒': 'rocket', '火箭': 'rocket', 'rocket': 'rocket', '反坦克': 'rocket',
};

/** 从可能带围栏/前后缀的文本中抽出第一个平衡的 JSON 对象 */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  // 去掉 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

function clampText(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.replace(/[\r\n]+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
}

function normalizeTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw['类型'] || raw.type || '').toLowerCase();
  if ((type === 'unit' || type === 'building' || type === 'entity') && raw.id != null) {
    const id = Number(raw.id);
    if (Number.isFinite(id)) return { 类型: type === 'building' ? 'building' : 'unit', id: id };
    return null;
  }
  if (type === 'position' || type === 'pos' || raw.x != null) {
    const x = Number(raw.x), y = Number(raw.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { 类型: 'position', x: x, y: y };
  }
  return null;
}

/**
 * 解析一次 LLM 输出
 * @returns {{ok:boolean, decision?:object, error?:string, raw?:string}}
 */
export function parseDecision(text) {
  const obj = extractJson(text);
  if (!obj) {
    const empty = !text || !String(text).trim();
    return {
      ok: false,
      error: empty
        ? '模型未返回内容（推理模型请把 max_tokens 提到 600 以上，或把 effort 调成 low）'
        : '未找到合法 JSON',
      raw: text,
    };
  }

  const action = String(obj['动作'] || obj.action || '').trim();
  if (ACTIONS.indexOf(action) < 0) {
    return { ok: false, error: '动作非法: ' + action, raw: text };
  }

  const say = clampText(obj['台词'] || obj.say, 40);
  if (!say) return { ok: false, error: '缺少台词', raw: text };

  let to = obj['对谁'];
  if (to !== '队友' && to !== '敌方') to = null;

  let weaponKey = null;
  const wRaw = obj['武器'];
  if (typeof wRaw === 'string' && wRaw.trim()) {
    const key = WEAPON_ALIAS[wRaw.trim().toLowerCase()] || WEAPON_ALIAS[wRaw.trim()];
    if (key && WEAPONS[key]) weaponKey = key;
  }

  const target = normalizeTarget(obj['目标']);
  // 需要目标的动作绝不能没有目标，否则会变成「站着不动」
  if ((action === 'attack' || action === 'attack_move') && !target) {
    return { ok: false, error: action + ' 缺少有效目标', raw: text };
  }
  // move 允许位置或实体 id（模型常用 move 走向载具/单位去乘驾或接近）
  if (action === 'move' && !target) {
    return { ok: false, error: 'move 缺少目标', raw: text };
  }
  // board 必须指向载具 id（执行侧再校验是否为本方空车）；dismount 无需目标
  if (action === 'board' && !(target && target.类型 === 'unit' && target.id != null)) {
    return { ok: false, error: 'board 缺少载具目标 id', raw: text };
  }

  return {
    ok: true,
    decision: {
      say: say,
      to: to,
      action: action,
      target: target,
      weapon: weaponKey,
      intent: clampText(obj['说明'] || obj.intent, 24),
      isMove: MOVE_ACTIONS.indexOf(action) >= 0,
    },
  };
}
