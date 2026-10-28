import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ dir, level = 'info', echo = true } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  let logPath = null;
  let ready = null;

  if (dir) {
    ready = mkdir(dir, { recursive: true }).then(() => {
      const day = new Date().toISOString().slice(0, 10);
      logPath = path.join(dir, `agent-${day}.log`);
    });
  }

  function write(lvl, msg, extra) {
    if ((LEVELS[lvl] ?? 20) < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}${
      extra === undefined ? '' : ' ' + safeJson(extra)
    }`;
    if (echo) {
      const fn = lvl === 'error' || lvl === 'warn' ? console.error : console.log;
      fn(line);
    }
    if (ready) {
      ready
        .then(() => appendFile(logPath, line + '\n'))
        .catch(() => {});
    }
  }

  return {
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
    level,
  };
}

function safeJson(v) {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 800 ? s.slice(0, 800) + '…' : s;
  } catch {
    return String(v);
  }
}

/** 屏蔽敏感字段后打印对象 */
export function redact(obj, keys = ['token', 'apiKey', 'secret', 'password']) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = keys.some((x) => k.toLowerCase().includes(x.toLowerCase()))
      ? '***'
      : v && typeof v === 'object'
        ? redact(v, keys)
        : v;
  }
  return out;
}
