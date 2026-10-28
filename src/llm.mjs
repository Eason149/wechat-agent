import { resolveApiKey } from './config.mjs';

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class LlmError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * 调用 OpenAI 兼容的 /chat/completions。
 * 兼容 DeepSeek 官方、Ollama（/v1）、以及任何兼容网关。
 */
export async function chatCompletion({ cfg, messages, signal, logger, maxRetries = 2 }) {
  const apiKey = resolveApiKey(cfg);
  const url = cfg.agent.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: cfg.agent.model,
    messages,
    temperature: cfg.agent.temperature,
    max_tokens: cfg.agent.maxTokens,
    stream: false,
  };

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const timeout = AbortSignal.timeout(cfg.agent.timeoutMs ?? 45000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: combined,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const retryable = RETRYABLE_STATUS.has(res.status);
        const err = new LlmError(`模型接口 ${res.status}: ${truncate(text, 300)}`, {
          status: res.status,
          retryable,
        });
        if (!retryable || attempt === maxRetries) throw err;
        lastErr = err;
        await sleep(backoff(attempt, res.headers.get('retry-after')));
        continue;
      }

      const data = await res.json();
      const content = extractContent(data);
      if (!content) throw new LlmError('模型返回了空内容');
      return {
        text: content,
        usage: data.usage,
        model: data.model,
        raw: data,
      };
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        lastErr = new LlmError('模型请求超时', { retryable: true });
        if (attempt === maxRetries) break;
        await sleep(backoff(attempt));
        continue;
      }
      if (err instanceof LlmError) {
        if (!err.retryable) throw err;
        lastErr = err;
        continue;
      }
      lastErr = err;
      logger?.warn(`模型请求异常（第 ${attempt + 1} 次）`, err.message);
      if (attempt === maxRetries) break;
      await sleep(backoff(attempt));
    }
  }
  throw lastErr || new LlmError('模型调用失败');
}

function extractContent(data) {
  const choice = data?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? '';
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('').trim();
  }
  return String(content || '').trim();
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function backoff(attempt, retryAfter) {
  if (retryAfter && !Number.isNaN(Number(retryAfter))) return Math.min(Number(retryAfter) * 1000, 15000);
  return Math.min(800 * 2 ** attempt, 8000);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
