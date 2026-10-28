import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { ChatStore } from '../src/store.mjs';
import { merge, DEFAULTS } from '../src/config.mjs';

function makeCfg(dir) {
  return merge(DEFAULTS, {
    rootDir: dir,
    agent: { name: '小深', personaFile: path.join(dir, 'persona.md'), maxTokens: 100 },
    behavior: {
      trigger: { mentions: true, keywords: [], whitelistGroups: [] },
      limits: { perGroupCooldownMs: 0, maxRepliesPerMinute: 100, staleMessageMs: 60000 },
      dedupe: { enabled: true },
      style: { splitMessages: false, typingDelayMs: [0, 0], disclosure: '' },
    },
    storage: { dir: path.join(dir, 'data') },
  });
}

function fakeAdapter() {
  const sent = [];
  let onEvent;
  return {
    name: 'fake',
    sent,
    async start(h) {
      onEvent = h;
    },
    async send({ chatName, text }) {
      sent.push({ chatName, text });
    },
    async stop() {},
    emit: (e) => onEvent(e),
  };
}

const evt = (over = {}) => ({
  id: 'e1',
  chatId: 'g1',
  chatName: '测试群',
  senderId: 'u1',
  senderName: '张三',
  text: '现在几点',
  isMentioned: true,
  isSelf: false,
  type: 'text',
  ts: Date.now(),
  ...over,
});

test('端到端：@ 后调用模型并发送', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wagent-'));
  try {
    const cfg = makeCfg(dir);
    const store = new ChatStore(cfg.storage.dir);
    const adapter = fakeAdapter();
    const calls = [];
    const bridge = new Bridge({
      cfg,
      store,
      adapter,
      llm: async ({ messages }) => {
        calls.push(messages);
        return { text: '小深：下午三点。', usage: { total_tokens: 10 } };
      },
    });
    await bridge.start();
    await bridge.enqueue(evt());
    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0].text, '下午三点。');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].at(-1).content.includes('张三'));
    assert.ok(calls[0][0].content.length > 50, 'system prompt 应包含人设');

    const state = await store.load({ id: 'g1' });
    assert.ok(state.messages.some((m) => m.role === 'user'));
    assert.equal(state.stats.replies, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('端到端：重复 event.id 只处理一次', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wagent-'));
  try {
    const cfg = makeCfg(dir);
    const store = new ChatStore(cfg.storage.dir);
    const adapter = fakeAdapter();
    let n = 0;
    const bridge = new Bridge({ cfg, store, adapter, llm: async () => (n++, { text: '收到' }) });
    await bridge.start();
    await bridge.enqueue(evt({ id: 'same' }));
    await bridge.enqueue(evt({ id: 'same' }));
    assert.equal(adapter.sent.length, 1);
    assert.equal(n, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('端到端：模型沉默时不发送', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wagent-'));
  try {
    const cfg = makeCfg(dir);
    const store = new ChatStore(cfg.storage.dir);
    const adapter = fakeAdapter();
    const bridge = new Bridge({ cfg, store, adapter, llm: async () => ({ text: '[[SILENT]]' }) });
    await bridge.start();
    await bridge.enqueue(evt());
    assert.equal(adapter.sent.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('端到端：模型报错时不影响后续消息', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wagent-'));
  try {
    const cfg = makeCfg(dir);
    const store = new ChatStore(cfg.storage.dir);
    const adapter = fakeAdapter();
    let first = true;
    const bridge = new Bridge({
      cfg,
      store,
      adapter,
      llm: async () => {
        if (first) {
          first = false;
          throw new Error('boom');
        }
        return { text: '好了' };
      },
    });
    await bridge.start();
    await bridge.enqueue(evt({ id: 'a' }));
    await bridge.enqueue(evt({ id: 'b' }));
    assert.equal(adapter.sent.length, 1);
    assert.equal(bridge.metrics.errors, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
