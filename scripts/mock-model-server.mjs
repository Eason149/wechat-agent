#!/usr/bin/env node
/**
 * 本地假模型服务（OpenAI 兼容），用来在没有 API key 的情况下验证整条链路。
 *   node scripts/mock-model-server.mjs 8099
 *   WECHAT_AGENT_BASE_URL=http://127.0.0.1:8099 DEEPSEEK_API_KEY=x node src/cli.mjs chat
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] || 8099);

const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  let messages = [];
  try {
    messages = JSON.parse(body).messages || [];
  } catch {}
  const last = messages.at(-1)?.content || '';
  const userText = String(last).replace(/^[^：:]{1,12}[：:]/, '');

  const reply = userText.includes('几点')
    ? '这会儿大概下午三点。要查准确时间我可以帮你看。'
    : userText.includes('你是谁') || userText.includes('机器人')
      ? '我是群里的小深，一个 AI 助手。'
      : `收到：${userText.slice(0, 30)}`;

  const payload = {
    id: 'mock-' + Date.now(),
    object: 'chat.completion',
    model: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock model server on http://127.0.0.1:${port}`);
});
