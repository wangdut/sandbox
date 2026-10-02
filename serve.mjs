import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 8788;
const MAX_BODY = 1024 * 1024; // 1MB 足够容纳一次 LLM 请求

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(body);
}

/** 拼接 chat/completions 端点：兼容 base 形如 .../v1，或已带 /chat/completions */
function completionsUrl(baseUrl) {
  const base = String(baseUrl).trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  return base + '/chat/completions';
}

/**
 * 允许的目标：https 任意主机；http 仅限本机
 * （供 tools/mock-llm.mjs 这类本地调试端点使用，避免把明文 Key 发到 http 公网地址）
 */
function targetProblem(url) {
  let u;
  try { u = new URL(url); } catch (e) { return '目标地址不是合法 URL'; }
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:') {
    const h = u.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return null;
    return 'http 目标仅允许本机地址（公网请使用 https）';
  }
  return '仅支持 http/https 目标';
}

async function handleLLM(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    json(res, 400, { ok: false, error: '请求体不是合法 JSON: ' + e.message });
    return;
  }

  const { baseUrl, apiKey, model, messages, temperature, maxTokens, jsonMode, effort } = payload || {};
  if (!baseUrl || !model || !Array.isArray(messages)) {
    json(res, 400, { ok: false, error: '缺少 baseUrl / model / messages' });
    return;
  }
  const url = completionsUrl(baseUrl);
  const bad = targetProblem(url);
  if (bad) { json(res, 400, { ok: false, error: bad }); return; }

  const body = {
    model,
    messages,
    temperature: typeof temperature === 'number' ? temperature : 0.8,
    max_tokens: maxTokens || 1500,
    stream: false,
  };
  // 推理模型的推理强度：low 显著省 token（deepseek-flash 支持 low/high/max）
  if (effort) body.effort = effort;
  if (jsonMode) body.response_format = { type: 'json_object' };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

  const started = Date.now();
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const text = await upstream.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!upstream.ok) {
      const msg = (data && data.error && (data.error.message || data.error)) || text.slice(0, 500);
      json(res, 200, { ok: false, status: upstream.status, error: String(msg) });
      return;
    }
    json(res, 200, { ok: true, status: upstream.status, data, latencyMs: Date.now() - started });
  } catch (e) {
    const reason = e && e.name === 'TimeoutError' ? '上游请求超时（60s）' : String((e && e.message) || e);
    json(res, 200, { ok: false, status: 0, error: reason });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // LLM 转发代理：浏览器 → 本机 → 兼容 OpenAI 的 /chat/completions 端点
    if (url.pathname === '/api/llm') {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '仅支持 POST' }); return; }
      await handleLLM(req, res);
      return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    } else {
      res.writeHead(500).end('Internal Error');
    }
  }
});

server.listen(PORT, () => {
  console.log(`虚拟沙盘服务器已启动: http://localhost:${PORT}`);
});
