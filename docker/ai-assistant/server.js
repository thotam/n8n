/**
 * Mock server tương thích n8n AI Assistant SDK
 * Proxy request tới OpenRouter (OpenAI-compatible API)
 *
 * Endpoints cần thiết:
 *   POST /auth/token        → trả accessToken giả (n8n local đã patch isLicensed)
 *   POST /v1/ask-ai         → gọi OpenRouter, trả { code }
 *   POST /v1/chat           → streaming chat (nếu cần)
 *   POST /v1/chat/apply-suggestion → stub response
 */

import express from 'express';

const app = express();
app.use(express.json({ limit: '2mb' }));

// ─── Cấu hình từ biến môi trường ───────────────────────────────────────────
const PORT            = process.env.PORT            || 3456;
const OPENROUTER_URL  = process.env.OPENROUTER_URL  || 'https://open.thanhtam.top';
const OPENROUTER_KEY  = process.env.OPENROUTER_KEY  || '';
const MODEL           = process.env.AI_MODEL        || 'openai/gpt-4o-mini';

if (!OPENROUTER_KEY) {
  console.warn('[warn] OPENROUTER_KEY chưa được set!');
}

// ─── Helper: gọi OpenRouter ────────────────────────────────────────────────
async function callOpenRouter(messages, stream = false) {
  const res = await fetch(`${OPENROUTER_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'HTTP-Referer': 'https://n8n.cpc1hn.com.vn',
      'X-Title': 'n8n AI Assistant',
    },
    body: JSON.stringify({ model: MODEL, messages, stream }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter lỗi ${res.status}: ${err}`);
  }

  return res;
}

// ─── Helper: build system prompt cho ask-ai ────────────────────────────────
function buildAskAiMessages(question, context, forNode) {
  const inputSchemaStr = context?.inputSchema
    ? JSON.stringify(context.inputSchema.schema, null, 2)
    : 'Không có schema';

  const contextSchemaStr = context?.schema?.length
    ? context.schema.map(s => `Node "${s.nodeName}":\n${JSON.stringify(s.schema, null, 2)}`).join('\n\n')
    : 'Không có';

  const systemPrompt = `Bạn là AI assistant chuyên viết code cho n8n workflow automation.
Ngôn ngữ: JavaScript (n8n Code node, chạy trên Node.js).

Quy tắc bắt buộc:
- Chỉ trả về code JavaScript thuần, KHÔNG giải thích, KHÔNG markdown, KHÔNG \`\`\`
- Code phải dùng biến \`$input\`, \`$json\`, \`$node\` theo cú pháp n8n
- Return luôn là array of objects: \`return [{ json: { ... } }]\`
- Không dùng \`require()\` hay \`import\``;

  const userPrompt = `Node loại: ${forNode}

Input schema:
${inputSchemaStr}

Context từ các node trước:
${contextSchemaStr}

Yêu cầu: ${question}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userPrompt },
  ];
}

// ─── 1. /auth/token ─────────────────────────────────────────────────────────
// SDK gọi endpoint này trước, cần trả accessToken hợp lệ (bất kỳ string nào)
app.post('/auth/token', (req, res) => {
  console.log('[auth/token] Cấp token cho instance');
  res.json({
    accessToken: `local-proxy-token-${Date.now()}`,
    tokenType: 'Bearer',
  });
});

// ─── 2. /v1/ask-ai ──────────────────────────────────────────────────────────
// Endpoint chính: người dùng nhấn "Ask AI" trong Code node
app.post('/v1/ask-ai', async (req, res) => {
  const { question, context, forNode } = req.body;
  console.log(`[ask-ai] forNode=${forNode} | question="${question?.substring(0, 80)}"`);

  try {
    const messages = buildAskAiMessages(question, context, forNode);
    const response = await callOpenRouter(messages, false);
    const data = await response.json();

    const code = data?.choices?.[0]?.message?.content ?? '';
    console.log(`[ask-ai] Trả về ${code.length} ký tự code`);
    res.json({ code });
  } catch (err) {
    console.error('[ask-ai] Lỗi:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─── 3. /v1/chat (streaming) ────────────────────────────────────────────────
// Dùng cho AI Chat panel (nếu có), trả về JSON-lines stream
app.post('/v1/chat', async (req, res) => {
  console.log('[chat] Nhận yêu cầu chat');
  try {
    const { payload } = req.body;
    const messages = [
      { role: 'system', content: 'Bạn là AI assistant hỗ trợ xây dựng workflow n8n. Trả lời ngắn gọn, chính xác.' },
      { role: 'user',   content: typeof payload === 'string' ? payload : JSON.stringify(payload) },
    ];

    const upstream = await callOpenRouter(messages, true);

    res.setHeader('Content-Type', 'application/json-lines');
    res.setHeader('Transfer-Encoding', 'chunked');

    // Pipe stream từ OpenRouter → client
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // phần chưa hoàn chỉnh

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (json === '[DONE]') continue;

        try {
          const chunk = JSON.parse(json);
          const delta = chunk.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            res.write(JSON.stringify({ messages: [{ role: 'assistant', type: 'message', content: delta }] }) + '\n');
          }
        } catch { /* bỏ qua chunk lỗi */ }
      }
    }

    res.end();
  } catch (err) {
    console.error('[chat] Lỗi:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ message: err.message });
    } else {
      res.end();
    }
  }
});

// ─── 4. /v1/chat/apply-suggestion ───────────────────────────────────────────
// Stub — n8n gọi khi user chấp nhận gợi ý từ chat
app.post('/v1/chat/apply-suggestion', (req, res) => {
  console.log('[apply-suggestion] stub response');
  res.json({ sessionId: req.body?.sessionId ?? 'local', parameters: {} });
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', model: MODEL }));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[ai-assistant-proxy] Đang chạy tại http://0.0.0.0:${PORT}`);
  console.log(`  OpenRouter URL : ${OPENROUTER_URL}`);
  console.log(`  Model          : ${MODEL}`);
});
