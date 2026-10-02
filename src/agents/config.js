// 沙盘配置：API 端点、模型、预算与频率控制
//
// 由 config.html 写入 localStorage，游戏运行时读取。浏览器直连模式下 Key 只存在本机，
// 代理模式下 Key 经本机 serve.mjs 转发（不经第三方）。

export const CONFIG_KEY = 'vsandbox.config.v1';

export const DEFAULT_CONFIG = {
  // ---- 接口 ----
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  // 默认用 Flash 版（推理模型，便宜）：务必配合 effort=low 与 max_tokens>=1500
  model: 'deepseek-flash',
  temperature: 0.8,
  maxTokens: 1500,
  // 推理强度（deepseek-flash 这类推理模型支持 low/high/max；非推理模型可留 none）
  effort: 'low',
  // 通过本机 serve.mjs 转发（推荐，避开 CORS）；关闭则浏览器直连
  useProxy: true,
  // 部分兼容端点不支持 response_format=json_object，可关闭（提示词仍要求纯 JSON）
  jsonMode: true,

  // ---- 成员开关与可选独立 Key（默认共用一条 Key）----
  agentEnabled: { blue_1: true, blue_2: true, red_1: true, red_2: true },
  memberApiKeys: { blue_1: '', blue_2: '', red_1: '', red_2: '' },
  memberModels: { blue_1: '', blue_2: '', red_1: '', red_2: '' },

  // ---- 成本与频率控制 ----
  budget: {
    decisionCooldownSec: 6,   // 同一成员两次决策的最小间隔
    chatCooldownSec: 30,      // 喊话（对队友/敌方）的最小间隔
    idleIntervalSec: 12,      // 无战事时的自主决策节拍
    maxCallsPerMinute: 30,    // 全局每分钟调用上限
    maxTokensPerGame: 80000,  // 全局每局 token 上限（超出后降级为脚本 AI）
  },
};

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!override || typeof override !== 'object') return out;
  Object.keys(override).forEach(function (k) {
    const bv = base ? base[k] : undefined;
    const ov = override[k];
    if (ov && typeof ov === 'object' && !Array.isArray(ov) && bv && typeof bv === 'object') {
      out[k] = deepMerge(bv, ov);
    } else if (ov !== undefined) {
      out[k] = ov;
    }
  });
  return out;
}

export function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return deepMerge(DEFAULT_CONFIG, {});
    return deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch (e) {
    console.warn('[config] 读取配置失败，使用默认值', e);
    return deepMerge(DEFAULT_CONFIG, {});
  }
}

export function saveConfig(cfg) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    return true;
  } catch (e) {
    console.warn('[config] 保存配置失败', e);
    return false;
  }
}

/** 该成员是否具备调用条件（开关 + Key） */
export function isAgentEnabled(cfg, key) {
  if (!cfg.agentEnabled || cfg.agentEnabled[key] === false) return false;
  return true;
}

/** 取成员实际使用的 Key / 模型（支持独立覆盖） */
export function resolveMemberAuth(cfg, key) {
  const overrideKey = (cfg.memberApiKeys && cfg.memberApiKeys[key]) || '';
  const overrideModel = (cfg.memberModels && cfg.memberModels[key]) || '';
  return {
    apiKey: (overrideKey || cfg.apiKey || '').trim(),
    model: (overrideModel || cfg.model || '').trim(),
  };
}

/** 是否已配置到可以真正调用 LLM */
export function isLLMReady(cfg) {
  return !!((cfg.apiKey || '').trim() && (cfg.model || '').trim() && (cfg.baseUrl || '').trim());
}
