// LLM 客户端：统一走两条路径之一
//   1. 本机代理（默认）：POST /api/llm，由 serve.mjs 转发，避开浏览器 CORS 限制
//   2. 浏览器直连：POST {baseUrl}/chat/completions（需该端点允许跨域）
//
// 推理模型（如 deepseek-flash）偶尔会把 max_tokens 全花在推理上、正文为空，
// 这里对其做一次「提高额度重试」，显著降低这类偶发失败。

function buildPayload(cfg, auth, messages, maxTokens) {
  return {
    baseUrl: cfg.baseUrl,
    apiKey: auth.apiKey,
    model: auth.model,
    messages: messages,
    temperature: cfg.temperature,
    maxTokens: maxTokens,
    jsonMode: cfg.jsonMode,
    effort: cfg.effort && cfg.effort !== 'none' ? cfg.effort : undefined,
  };
}

async function viaProxy(cfg, auth, messages, maxTokens) {
  const started = Date.now();
  const resp = await fetch('/api/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPayload(cfg, auth, messages, maxTokens)),
  });
  if (!resp.ok) throw new Error('本机代理 HTTP ' + resp.status);
  const json = await resp.json();
  if (!json.ok) throw new Error(json.error || '本机代理返回失败');
  const choice = json.data && json.data.choices && json.data.choices[0];
  if (!choice) throw new Error('回包缺少 choices');
  return {
    text: (choice.message && choice.message.content) || '',
    finishReason: choice.finish_reason || '',
    reasoningContent: (choice.message && choice.message.reasoning_content) || '',
    usage: json.data.usage || null,
    latencyMs: json.latencyMs || (Date.now() - started),
  };
}

async function viaDirect(cfg, auth, messages, maxTokens) {
  const started = Date.now();
  const url = String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (auth.apiKey) headers['Authorization'] = 'Bearer ' + auth.apiKey;
  const body = {
    model: auth.model,
    messages: messages,
    temperature: cfg.temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (cfg.effort && cfg.effort !== 'none') body.effort = cfg.effort;
  if (cfg.jsonMode) body.response_format = { type: 'json_object' };

  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error('直连失败（可能是 CORS 或网络问题）：' + e.message + '；建议开启"经本机转发"');
  }
  const json = await resp.json().catch(function () { return null; });
  if (!resp.ok) {
    const msg = (json && json.error && (json.error.message || JSON.stringify(json.error))) || ('HTTP ' + resp.status);
    throw new Error(msg);
  }
  const choice = json && json.choices && json.choices[0];
  if (!choice) throw new Error('回包缺少 choices');
  return {
    text: (choice.message && choice.message.content) || '',
    finishReason: choice.finish_reason || '',
    reasoningContent: (choice.message && choice.message.reasoning_content) || '',
    usage: json.usage || null,
    latencyMs: Date.now() - started,
  };
}

/**
 * @param cfg 完整配置（loadConfig() 的结果）
 * @param auth { apiKey, model } 该成员实际使用的凭据（支持独立 Key/模型）
 * @param messages [{role, content}]
 * @returns {{text, finishReason, usage, latencyMs, retriedEmpty?:boolean}}
 * @throws Error 调用失败时抛出，message 为可读原因
 */
export async function chatOnce(cfg, auth, messages) {
  const request = cfg.useProxy ? viaProxy : viaDirect;
  let res = await request(cfg, auth, messages, cfg.maxTokens);

  if (!res.text || !res.text.trim()) {
    // 正文为空：多半是推理吃满了额度（finish_reason=length），提高额度重试一次
    const retryTokens = Math.min(4000, Math.max(1500, (cfg.maxTokens || 600) * 2));
    console.warn('[llm] 正文为空（finish_reason=' + res.finishReason + '），以 max_tokens=' + retryTokens + ' 重试一次');
    const retry = await request(cfg, auth, messages, retryTokens);
    retry.retriedEmpty = true;
    if (res.usage && retry.usage) {
      // 两次调用的 token 都要计入成本
      retry.usage = {
        prompt_tokens: (res.usage.prompt_tokens || 0) + (retry.usage.prompt_tokens || 0),
        completion_tokens: (res.usage.completion_tokens || 0) + (retry.usage.completion_tokens || 0),
        total_tokens: (res.usage.total_tokens || 0) + (retry.usage.total_tokens || 0),
      };
    }
    res = retry;
  }
  return res;
}
