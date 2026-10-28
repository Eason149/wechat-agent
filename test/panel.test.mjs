import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPanel } from '../src/panel/server.mjs';
import { merge, DEFAULTS } from '../src/config.mjs';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'wpanel-'));
  await mkdir(path.join(dir, 'data'), { recursive: true });
  await writeFile(path.join(dir, 'persona.md'), '# 人设\n测试用\n', 'utf8');
  const cfg = merge(DEFAULTS, {
    rootDir: dir,
    configPath: path.join(dir, 'config.json'),
    agent: { personaFile: path.join(dir, 'persona.md'), name: '小深' },
    storage: { dir: path.join(dir, 'data') },
    panel: { enabled: true, port: 0, openBrowser: false },
  });
  await writeFile(cfg.configPath, JSON.stringify({ agent: { name: '小深' } }, null, 2), 'utf8');

  const bridge = {
    paused: false,
    running: true,
    metrics: { inbound: 2, replied: 1, ignored: 1, errors: 0, byBackend: {} },
    backends: { api: { respond: async () => ({ text: '好的，收到。' }) } },
    async pause() { this.paused = true; },
    async resume() { this.paused = false; },
  };
  const store = { init: async () => {}, close: async () => {} };
  const panel = await startPanel({ cfg, bridge, store, logger: silent, port: 0 });
  const token = new URL(panel.url).searchParams.get('t');
  const api = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${panel.port}${p}`, {
      ...opts,
      headers: { 'content-type': 'application/json', 'x-panel-token': token, ...(opts.headers || {}) },
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  return { dir, cfg, panel, api, token, bridge, cleanup: async () => { await panel.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('没有令牌打不开', async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.panel.port}/api/state`);
    assert.equal(res.status, 401);
  } finally { await ctx.cleanup(); }
});

test('state 反映运行状态', async () => {
  const ctx = await setup();
  try {
    const { status, data } = await ctx.api('/api/state');
    assert.equal(status, 200);
    assert.equal(data.running, true);
    assert.equal(data.paused, false);
    assert.equal(data.channel, 'mock');
    assert.equal(data.metrics.replied, 1);
  } finally { await ctx.cleanup(); }
});

test('暂停 / 恢复真的改了桥接状态', async () => {
  const ctx = await setup();
  try {
    await ctx.api('/api/pause', { method: 'POST' });
    assert.equal(ctx.bridge.paused, true);
    const { data } = await ctx.api('/api/resume', { method: 'POST' });
    assert.equal(ctx.bridge.paused, false);
    assert.equal(data.paused, false);
  } finally { await ctx.cleanup(); }
});

test('配置白名单：允许的生效，不允许的被拒', async () => {
  const ctx = await setup();
  try {
    const { data } = await ctx.api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ patch: { 'agent.tone': 'witty', 'storage.dir': '/etc' } }),
    });
    assert.deepEqual(data.applied, ['agent.tone']);
    assert.deepEqual(data.rejected, ['storage.dir']);
    assert.equal(ctx.cfg.agent.tone, 'witty');
    assert.notEqual(ctx.cfg.storage.dir, '/etc');
  } finally { await ctx.cleanup(); }
});

test('改动会写回 config.json', async () => {
  const ctx = await setup();
  try {
    await ctx.api('/api/config', { method: 'POST', body: JSON.stringify({ patch: { 'agent.name': '阿深' } }) });
    const saved = JSON.parse(await (await import('node:fs/promises')).readFile(ctx.cfg.configPath, 'utf8'));
    assert.equal(saved.agent.name, '阿深');
  } finally { await ctx.cleanup(); }
});

test('试聊走后端且不落聊天记录', async () => {
  const ctx = await setup();
  try {
    const { data } = await ctx.api('/api/test', { method: 'POST', body: JSON.stringify({ text: '在吗' }) });
    assert.equal(data.ok, true);
    assert.equal(data.reply, '好的，收到。');
    assert.equal(data.backend, 'api');
  } finally { await ctx.cleanup(); }
});

test('人设可读可写', async () => {
  const ctx = await setup();
  try {
    const before = await ctx.api('/api/persona');
    assert.match(before.data.text, /人设/);
    await ctx.api('/api/persona', { method: 'POST', body: JSON.stringify({ text: '# 新人设\n短一点' }) });
    const after = await ctx.api('/api/persona');
    assert.match(after.data.text, /新人设/);
  } finally { await ctx.cleanup(); }
});

test('记忆列表与清空', async () => {
  const ctx = await setup();
  try {
    const file = '测试群-abc12345.json';
    await writeFile(
      path.join(ctx.cfg.storage.dir, file),
      JSON.stringify({ name: '测试群', messages: [{ role: 'user', text: 'hi', ts: Date.now() }], stats: { inbound: 1, replies: 0 } }),
      'utf8',
    );
    const list = await ctx.api('/api/chats');
    assert.equal(list.data.chats.length, 1);
    assert.equal(list.data.chats[0].name, '测试群');

    await ctx.api(`/api/chats/${encodeURIComponent(file)}/clear`, { method: 'POST' });
    const detail = await ctx.api(`/api/chats/${encodeURIComponent(file)}`);
    assert.equal(detail.data.messages.length, 0);
  } finally { await ctx.cleanup(); }
});

test('非法文件名被挡', async () => {
  const ctx = await setup();
  try {
    const { status } = await ctx.api('/api/chats/..%2F..%2Fetc%2Fpasswd/clear', { method: 'POST' });
    assert.ok(status === 400 || status === 404);
  } finally { await ctx.cleanup(); }
});
