import { createServer } from 'node:http';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pickBackend } from '../bridge.mjs';
import { resolveApiKey, merge } from '../config.mjs';
import { CHANNELS, createAdapter } from '../adapters/index.mjs';
import { chatCompletion } from '../llm.mjs';
import { sanitizeReply, resetPersonaCache } from '../prompt.mjs';
import { chatFileName } from '../store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 控制台允许改的键（白名单，避免从前端改到 storage/路径之类的东西） */
const PATCHABLE = new Set([
  'agent.name',
  'agent.tone',
  'agent.toneExtra',
  'agent.backend',
  'agent.maxTokens',
  'agent.temperature',
  'behavior.proactive.enabled',
  'behavior.proactive.idleMinutes',
  'behavior.proactive.minIntervalMinutes',
  'behavior.proactive.maxIntervalMinutes',
  'behavior.proactive.maxPerDay',
  'behavior.proactive.perHour',
  'behavior.proactive.chance',
  'behavior.memory.enabled',
  'behavior.memory.maxContextMessages',
  'behavior.memory.contextTtlMinutes',
  'behavior.trigger.mentions',
  'behavior.trigger.keywords',
  'behavior.trigger.whitelistGroups',
  'behavior.trigger.whitelistReplyProbability',
  'behavior.trigger.ignoreSenders',
  'behavior.limits.perGroupCooldownMs',
  'behavior.limits.maxRepliesPerMinute',
  'behavior.limits.maxRepliesPerHour',
  'behavior.limits.staleMessageMs',
  'behavior.style.maxCharsPerMessage',
  'behavior.style.disclosure',
]);

export async function startPanel({ cfg, bridge, store, logger, port = cfg.panel?.port ?? 7788, host = '127.0.0.1' }) {
  const token = randomBytes(16).toString('hex');
  const startedAt = Date.now();
  const uiPath = path.join(HERE, 'ui.html');
  const fallbackHtml = '<h1>ui.html 缺失</h1>';

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = decodeURIComponent(url.pathname);
      const given = url.searchParams.get('t') || req.headers['x-panel-token'] || '';
      if (!safeEqual(given, token)) return send(res, 401, '需要控制台令牌：请用启动时打印的地址打开', 'text/plain; charset=utf-8');

      if (pathname === '/' || pathname === '/index.html') {
        const html = await readFile(uiPath, 'utf8').catch(() => fallbackHtml);
        return send(res, 200, html, 'text/html; charset=utf-8');
      }
      if (!pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

      const body = req.method === 'POST' ? await readJson(req) : {};

      switch (`${req.method} ${pathname}`) {
        case 'GET /api/state':
          return send(res, 200, await state());

        case 'POST /api/pause':
          await bridge.pause();
          return send(res, 200, await state());

        case 'POST /api/resume':
          await bridge.resume();
          return send(res, 200, await state());

        case 'POST /api/config':
          return send(res, 200, await applyPatch(body.patch || {}));

        case 'GET /api/provider':
          return send(res, 200, providerInfo());

        case 'POST /api/provider':
          return send(res, 200, await saveProvider(body || {}));

        case 'GET /api/channels':
          return send(res, 200, { current: cfg.channel.type, channels: CHANNELS });

        case 'POST /api/channel':
          return send(res, 200, await switchChannel(String(body.type || '')));

        case 'POST /api/test': {
          const text = String(body.text || '').trim();
          if (!text) return send(res, 400, { error: '内容为空' });
          const out = await testReply(text);
          return send(res, 200, out);
        }

        case 'POST /api/proactive/now': {
          const chats = [...bridge.activeChats.values()];
          const target = body.chatId ? bridge.activeChats.get(body.chatId) : chats[0];
          if (!target) return send(res, 400, { ok: false, error: '还没有任何会话，先在群里发一句话让它读到' });
          try {
            const dry = url.searchParams.get('dry') === '1';
            const out = await bridge.speakNow(target.id, { dry });
            return send(res, 200, { ok: true, chat: target.name, text: out.text || '（它选择不说）' });
          } catch (err) {
            return send(res, 500, { ok: false, error: err.message });
          }
        }

        case 'GET /api/chats':
          return send(res, 200, { chats: await listChats() });

        case 'GET /api/persona':
          return send(res, 200, { text: await readFile(cfg.agent.personaFile, 'utf8').catch(() => ''), path: cfg.agent.personaFile });

        case 'POST /api/persona': {
          const text = String(body.text ?? '');
          if (!text.trim()) return send(res, 400, { error: '人设不能为空' });
          await writeFile(cfg.agent.personaFile, text, 'utf8');
          resetPersonaCache();
          logger.info('控制台更新了人设');
          return send(res, 200, { ok: true, chars: text.length });
        }

        case 'GET /api/logs': {
          const n = Math.min(Number(url.searchParams.get('n')) || 80, 500);
          return send(res, 200, { lines: await tailLog(n) });
        }

        case 'POST /api/shutdown': {
          send(res, 200, { ok: true, bye: true });
          setTimeout(async () => {
            logger.info('控制台请求停止，正在退出');
            await bridge.stop().catch(() => {});
            server.close();
            process.exit(0);
          }, 200);
          return;
        }
      }

      const chatMatch = pathname.match(/^\/api\/chats\/([\w.\-\u4e00-\u9fa5]+)(\/clear)?$/);
      if (chatMatch) {
        const file = chatMatch[1];
        if (!/^[\w.\-\u4e00-\u9fa5]+\.json$/.test(file)) return send(res, 400, { error: '非法文件名' });
        if (req.method === 'GET' && !chatMatch[2]) {
          const raw = await readFile(path.join(cfg.storage.dir, file), 'utf8').catch(() => null);
          if (!raw) return send(res, 404, { error: '没有这个会话' });
          const data = JSON.parse(raw);
          return send(res, 200, { name: data.name, messages: (data.messages || []).slice(-50), stats: data.stats });
        }
        if (req.method === 'POST' && chatMatch[2]) {
          const data = JSON.parse(await readFile(path.join(cfg.storage.dir, file), 'utf8'));
          data.messages = [];
          data.replyTimestamps = [];
          data.lastReplyAt = 0;
          data.stats = { inbound: 0, replies: 0, errors: 0 };
          await writeFile(path.join(cfg.storage.dir, file), JSON.stringify(data, null, 2), 'utf8');
          logger.info(`控制台清空了会话 ${file}`);
          return send(res, 200, { ok: true });
        }
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      logger?.error('控制台异常', err.stack || err.message);
      if (!res.headersSent) send(res, 500, { error: err.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;
  const url = `http://${host}:${actualPort}/?t=${token}`;
  logger?.info(`控制台：${url}`);

  if (cfg.panel?.openBrowser !== false) {
    const { spawn } = await import('node:child_process');
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  }

  return {
    url,
    port: actualPort,
    close: () => new Promise((r) => server.close(r)),
  };

  // ---------------------------------------------------------------- helpers

  async function state() {
    return {
      paused: Boolean(bridge.paused),
      running: Boolean(bridge.running),
      channel: cfg.channel.type,
      channelStatus: bridge.adapter?.status || null,
      backend: cfg.agent.backend,
      model: cfg.agent.model,
      name: cfg.agent.name,
      tone: cfg.agent.tone,
      toneExtra: cfg.agent.toneExtra,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      needsKey: !resolveApiKey(cfg),
      provider: providerInfo(),
      metrics: bridge.metrics,
      config: {
        memory: cfg.behavior.memory,
        proactive: cfg.behavior.proactive,
        trigger: cfg.behavior.trigger,
        limits: cfg.behavior.limits,
        style: cfg.behavior.style,
      },
      chats: (await listChats()).length,
    };
  }

  function providerInfo() {
    const key = resolveApiKey(cfg);
    return {
      baseUrl: cfg.agent.baseUrl,
      model: cfg.agent.model,
      env: cfg.agent.apiKeyEnv,
      keyPresent: Boolean(key),
      keyMask: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '',
    };
  }

  /** 保存前先真调一次，避免"填错了还以为配好了" */
  async function saveProvider({ baseUrl, model, apiKey }) {
    const next = {
      baseUrl: String(baseUrl || cfg.agent.baseUrl).trim().replace(/\/+$/, ''),
      model: String(model || cfg.agent.model).trim(),
      apiKey: String(apiKey || '').trim(),
    };
    if (!/^https?:\/\//.test(next.baseUrl)) return { ok: false, error: 'Base URL 要以 http:// 或 https:// 开头' };

    const probeCfg = merge(cfg, { agent: { baseUrl: next.baseUrl, model: next.model, maxTokens: 16, temperature: 0 } });
    const probeKey = next.apiKey || resolveApiKey(cfg);
    try {
      const res = await chatCompletion({
        cfg: { ...probeCfg, agent: { ...probeCfg.agent, apiKey: probeKey, apiKeyEnv: 'PANEL_PROBE' } },
        messages: [
          { role: 'system', content: '只回复两个字：在线' },
          { role: 'user', content: 'ping' },
        ],
        maxRetries: 0,
      });
      const applied = { baseUrl: next.baseUrl, model: next.model, keyMask: '' };
      cfg.agent.baseUrl = next.baseUrl;
      cfg.agent.model = next.model;
      if (next.apiKey) {
        await writeSecret(cfg.agent.apiKeyEnv, next.apiKey);
        process.env[cfg.agent.apiKeyEnv] = next.apiKey;
      }
      await persist(['agent.baseUrl', 'agent.model']);
      applied.reply = (res.text || '').slice(0, 30);
      logger.info('控制台更新了模型 API', { baseUrl: next.baseUrl, model: next.model });
      return { ok: true, ...applied, provider: providerInfo(), state: await state() };
    } catch (err) {
      return { ok: false, error: err.message, tried: { baseUrl: next.baseUrl, model: next.model } };
    }
  }

  async function switchChannel(type) {
    if (!CHANNELS[type]) return { ok: false, error: `未知通道：${type}` };
    const before = cfg.channel.type;
    if (type === before) return { ok: true, unchanged: true, state: await state() };
    const prevCfgType = before;
    cfg.channel.type = type;
    try {
      const adapter = await createAdapter(cfg, logger);
      await bridge.restartAdapter(adapter);
      await persist(['channel.type']);
      return { ok: true, channel: type, state: await state() };
    } catch (err) {
      cfg.channel.type = prevCfgType;
      return { ok: false, error: err.message, channel: prevCfgType };
    }
  }

  /** 把密钥写进 secrets.env（600），不写进 config.json */
  async function writeSecret(envName, value) {
    const file = path.join(cfg.rootDir, 'secrets.env');
    let lines = [];
    try {
      lines = (await readFile(file, 'utf8')).split('\n');
    } catch {
      lines = [];
    }
    const filtered = lines.filter((l) => !l.trim().startsWith(`${envName}=`));
    filtered.push(`${envName}=${value}`);
    const text = filtered.filter((l, i, a) => !(l === '' && i === a.length - 1)).join('\n') + '\n';
    await writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
  }

  async function applyPatch(patch) {
    const applied = [];
    const rejected = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!PATCHABLE.has(key)) {
        rejected.push(key);
        continue;
      }
      setDeep(cfg, key, value);
      applied.push(key);
    }
    if (applied.length) {
      await persist(applied);
      logger.info('控制台改了配置', { applied });
    }
    return { ok: rejected.length === 0, applied, rejected, state: await state() };
  }

  async function persist(keys) {
    const current = JSON.parse(await readFile(cfg.configPath, 'utf8').catch(() => '{}'));
    for (const key of keys) setDeep(current, key, getDeep(cfg, key));
    await writeFile(cfg.configPath, JSON.stringify(current, null, 2) + '\n', 'utf8');
  }

  async function testReply(text) {
    const event = {
      id: `panel-${Date.now()}`,
      chatId: 'panel-test',
      chatName: '控制台试聊',
      senderId: 'panel',
      senderName: '你',
      text,
      isMentioned: true,
      isSelf: false,
      type: 'text',
      ts: Date.now(),
    };
    const backendName = pickBackend(cfg, event);
    const backend = bridge.backends[backendName] || bridge.backends.api;
    const started = Date.now();
    try {
      const res = await backend.respond({ cfg, chat: { id: 'panel-test', name: '控制台试聊' }, event, history: [], signal: undefined });
      return { ok: true, backend: backendName, ms: Date.now() - started, raw: res.text, reply: sanitizeReply(res.text, cfg) };
    } catch (err) {
      return { ok: false, backend: backendName, ms: Date.now() - started, error: err.message };
    }
  }

  async function listChats() {
    const files = await readdir(cfg.storage.dir).catch(() => []);
    const out = [];
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      try {
        const full = path.join(cfg.storage.dir, f);
        const [raw, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
        const d = JSON.parse(raw);
        out.push({
          file: f,
          name: d.name || f,
          messages: (d.messages || []).length,
          inbound: d.stats?.inbound || 0,
          replies: d.stats?.replies || 0,
          updatedAt: st.mtimeMs,
        });
      } catch {
        /* 跳过坏文件 */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function tailLog(n) {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(cfg.storage.dir, `agent-${day}.log`);
    const raw = await readFile(file, 'utf8').catch(() => '');
    return raw.trimEnd().split('\n').slice(-n);
  }
}

function setDeep(obj, keyPath, value) {
  const keys = keyPath.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys.at(-1)] = value;
}

function getDeep(obj, keyPath) {
  return keyPath.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function send(res, code, payload, type = 'application/json; charset=utf-8') {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 512 * 1024) throw new Error('请求体过大');
  }
  if (!raw) return {};
  return JSON.parse(raw);
}
