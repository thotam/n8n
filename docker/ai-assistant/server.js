/**
 * Mock server tương thích n8n AI Assistant SDK
 * Proxy request tới OpenRouter (OpenAI-compatible API)
 *
 * Endpoints:
 *   POST /auth/token              → trả accessToken giả
 *   POST /v1/ask-ai               → gọi OpenRouter, trả { code }
 *   POST /v1/chat                 → streaming chat
 *   POST /v1/chat/apply-suggestion → stub
 */

import express from 'express';

const app = express();
app.use(express.json({ limit: '2mb' }));

// ─── Cấu hình từ biến môi trường ───────────────────────────────────────────
const PORT           = process.env.PORT           || 3456;
const OPENROUTER_URL = process.env.OPENROUTER_URL || 'https://open.thanhtam.top';
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';
const MODEL          = process.env.AI_MODEL       || 'openai/gpt-4o-mini';

// ─── Logger có timestamp + màu ANSI ────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  red:    '\x1b[31m',
  blue:   '\x1b[34m',
  bold:   '\x1b[1m',
};

function ts() {
  return `${C.dim}${new Date().toISOString()}${C.reset}`;
}

const log = {
  info:  (tag, msg, extra = '') =>
    console.log(`${ts()} ${C.green}[${tag}]${C.reset} ${msg} ${C.dim}${extra}${C.reset}`),
  warn:  (tag, msg) =>
    console.warn(`${ts()} ${C.yellow}[${tag}]${C.reset} ${msg}`),
  error: (tag, msg) =>
    console.error(`${ts()} ${C.red}[${tag}]${C.reset} ${msg}`),
  req:   (method, path, extra = '') =>
    console.log(`${ts()} ${C.bold}${C.blue}→ ${method} ${path}${C.reset} ${C.dim}${extra}${C.reset}`),
  res:   (path, ms, status = 200) => {
    const color = status >= 500 ? C.red : status >= 400 ? C.yellow : C.green;
    console.log(`${ts()} ${color}← ${path} ${status}${C.reset} ${C.dim}(${ms}ms)${C.reset}`);
  },
};

// ─── Middleware: log mọi request đến ──────────────────────────────────────
app.use((req, _res, next) => {
  req._startTime = Date.now();
  log.req(req.method, req.path, req.method === 'POST'
    ? `body=${JSON.stringify(req.body)?.substring(0, 120)}...`
    : '');
  next();
});

if (!OPENROUTER_KEY) {
  log.warn('config', 'OPENROUTER_KEY chưa được set — mọi request sẽ thất bại!');
}

// ─── Helper: gọi OpenRouter ────────────────────────────────────────────────
// Chuẩn hóa base URL: bỏ /v1 ở cuối nếu có (tránh double /v1)
const OPENROUTER_BASE = OPENROUTER_URL.replace(/\/v1\/?$/, '');

async function callOpenRouter(messages, stream = false) {
  const t0 = Date.now();
  log.info('openrouter', `Gọi model=${MODEL} stream=${stream} msgs=${messages.length}`);

  const res = await fetch(`${OPENROUTER_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'HTTP-Referer':  'https://n8n.cpc1hn.com.vn',
      'X-Title':       'n8n AI Assistant',
    },
    body: JSON.stringify({ model: MODEL, messages, stream }),
  });

  if (!res.ok) {
    const err = await res.text();
    log.error('openrouter', `HTTP ${res.status} sau ${Date.now() - t0}ms: ${err.substring(0, 200)}`);
    throw new Error(`OpenRouter lỗi ${res.status}: ${err}`);
  }

  log.info('openrouter', `Phản hồi HTTP ${res.status}`, `(${Date.now() - t0}ms)`);
  return res;
}

// ─── Helper: trích xuất fields từ schema n8n ──────────────────────────────
function extractFields(schema) {
  if (!schema) return 'Không có';
  const items = Array.isArray(schema.value) ? schema.value : [];
  if (!items.length) return 'Không có field nào';

  return items.map(f => {
    let sampleVal = f.value;
    if (f.type === 'number' && f.value !== '' && f.value !== undefined) {
      const num = Number(f.value);
      if (!isNaN(num)) sampleVal = num;
    }
    const sample = sampleVal !== '' && sampleVal !== undefined
      ? ` = ${JSON.stringify(sampleVal)}`
      : ' (chưa có giá trị mẫu)';
    return `  - ${f.key} (${f.type})${sample}  →  $json["${f.key}"]`;
  }).join('\n');
}

// ─── Helper: build system prompt cho ask-ai ────────────────────────────────
function buildAskAiMessages(question, context, forNode) {
  const inputNodeName = context?.inputSchema?.nodeName ?? 'Unknown';
  const inputFields   = extractFields(context?.inputSchema?.schema);

  const contextNodes  = context?.schema ?? [];
  const contextSchemaStr = contextNodes.length
    ? contextNodes.map(s => `Node "${s.nodeName}":\n${extractFields(s.schema)}`).join('\n\n')
    : 'Không có node nào khác';

  const isJsNode    = forNode === 'code' || forNode === 'transform';
  const syntaxGuide = isJsNode
    ? `Cú pháp n8n Code node (forNode: ${forNode}):
- "Run Once for Each Item": dùng \`$json["field"]\`, return \`[{ json: { ... } }]\`
- "Run Once for All Items": dùng \`$input.all()\`, return array of \`{ json: {} }\`
- KHÔNG dùng \`require()\` hay \`import\`
- Ví dụ: const combined = $json["id"] + " - " + $json["label"]; return [{ json: { combined } }];`
    : `Cú pháp n8n Expression (forNode: ${forNode}):
- Dùng \`{{ $json["field"] }}\` để truy cập field
- Kết hợp: \`{{ $json["field1"] + " " + $json["field2"] }}\``;

  const systemPrompt =
    `Bạn là AI assistant chuyên viết code cho n8n workflow automation.\n` +
    `Luôn trả về code JavaScript thuần — KHÔNG giải thích, KHÔNG markdown, KHÔNG \`\`\`.\n\n` +
    syntaxGuide;

  const userPrompt =
    `Node đang viết code: ${forNode}\n\n` +
    `Input đến từ node: "${inputNodeName}"\n` +
    `Fields có sẵn:\n${inputFields}\n\n` +
    `Context workflow (các node khác):\n${contextSchemaStr}\n\n` +
    `Yêu cầu: ${question}`;

  // Log prompt để debug
  log.info('prompt', `forNode=${forNode} inputNode="${inputNodeName}" contextNodes=${contextNodes.length}`);
  log.info('prompt', `question="${question?.substring(0, 100)}"`);

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userPrompt },
  ];
}

// ─── 1. /auth/token ─────────────────────────────────────────────────────────
app.post('/auth/token', (req, res) => {
  const token = `local-proxy-token-${Date.now()}`;
  log.info('auth', 'Cấp access token cho n8n instance', token.substring(0, 30));
  log.res('/auth/token', Date.now() - req._startTime);
  res.json({ accessToken: token, tokenType: 'Bearer' });
});

// ─── 2. /v1/ask-ai ──────────────────────────────────────────────────────────
app.post('/v1/ask-ai', async (req, res) => {
  const { question, context, forNode } = req.body;
  const inputFields = context?.inputSchema?.schema?.value?.length ?? 0;
  const ctxNodes    = context?.schema?.length ?? 0;

  log.info('ask-ai', `forNode=${C.cyan}${forNode}${C.reset}`, `| fields=${inputFields} ctxNodes=${ctxNodes}`);
  log.info('ask-ai', `question: "${question?.substring(0, 120)}"`);

  try {
    const messages = buildAskAiMessages(question, context, forNode);
    const response = await callOpenRouter(messages, false);
    const data     = await response.json();

    const code    = data?.choices?.[0]?.message?.content ?? '';
    const usage   = data?.usage;
    const usageStr = usage
      ? `prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`
      : '';

    log.info('ask-ai', `✓ Trả về ${code.length} ký tự code`, usageStr);
    if (code.length < 10) {
      log.warn('ask-ai', `Code quá ngắn (${code.length} ký tự), có thể AI trả sai format`);
    }

    log.res('/v1/ask-ai', Date.now() - req._startTime);
    res.json({ code });
  } catch (err) {
    log.error('ask-ai', `Lỗi: ${err.message}`);
    log.res('/v1/ask-ai', Date.now() - req._startTime, 500);
    res.status(500).json({ message: err.message });
  }
});

// ─── 3. /v1/chat (streaming) ────────────────────────────────────────────────
app.post('/v1/chat', async (req, res) => {
  log.info('chat', 'Nhận yêu cầu streaming chat');

  try {
    const { payload } = req.body;
    const messages = [
      { role: 'system', content: 'Bạn là AI assistant hỗ trợ xây dựng workflow n8n. Trả lời ngắn gọn, chính xác.' },
      { role: 'user',   content: typeof payload === 'string' ? payload : JSON.stringify(payload) },
    ];

    const upstream = await callOpenRouter(messages, true);

    res.setHeader('Content-Type', 'application/json-lines');
    res.setHeader('Transfer-Encoding', 'chunked');

    const reader  = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';
    let chunkCount = 0;
    let totalChars = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (json === '[DONE]') continue;

        try {
          const chunk = JSON.parse(json);
          const delta = chunk.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            chunkCount++;
            totalChars += delta.length;
            res.write(JSON.stringify({ messages: [{ role: 'assistant', type: 'message', content: delta }] }) + '\n');
          }
        } catch { /* bỏ qua chunk parse lỗi */ }
      }
    }

    log.info('chat', `✓ Stream hoàn tất`, `chunks=${chunkCount} chars=${totalChars}`);
    log.res('/v1/chat', Date.now() - req._startTime);
    res.end();
  } catch (err) {
    log.error('chat', `Lỗi: ${err.message}`);
    log.res('/v1/chat', Date.now() - req._startTime, 500);
    if (!res.headersSent) res.status(500).json({ message: err.message });
    else res.end();
  }
});

// ─── 4. /v1/chat/apply-suggestion ───────────────────────────────────────────
app.post('/v1/chat/apply-suggestion', (req, res) => {
  log.info('apply-suggestion', 'stub response (không cần xử lý thật)');
  log.res('/v1/chat/apply-suggestion', Date.now() - req._startTime);
  res.json({ sessionId: req.body?.sessionId ?? 'local', parameters: {} });
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', model: MODEL, uptime: process.uptime().toFixed(1) + 's' });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n${C.bold}${C.green}═══════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold} n8n AI Assistant Proxy${C.reset}`);
  console.log(`${C.green}═══════════════════════════════════════════${C.reset}`);
  console.log(`  URL    : http://0.0.0.0:${PORT}`);
  console.log(`  Router : ${OPENROUTER_BASE}/v1/chat/completions`);
  console.log(`  Model  : ${C.cyan}${MODEL}${C.reset}`);
  console.log(`  Key    : ${OPENROUTER_KEY ? C.green + '✓ Đã set' : C.red + '✗ Chưa set'}${C.reset}`);
  console.log(`${C.green}═══════════════════════════════════════════${C.reset}\n`);
});
