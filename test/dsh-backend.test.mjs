import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createsDshBackend } from '../src/backends/dsh.mjs';
import { merge, DEFAULTS } from '../src/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function cfg(command) {
  return merge(DEFAULTS, {
    agent: {
      backend: 'dsh',
      dsh: { command, timeoutMs: 8000 },
    },
  });
}

test('dsh 后端：解析 NDJSON 并记住 session', async () => {
  const backend = createsDshBackend({
    cfg: cfg([process.execPath, path.join(here, 'fixtures/fake-dsh.mjs')]),
  });
  const chat = { id: 'g1', name: '测试群' };
  const event = { chatName: '测试群', senderName: '张三', text: '你好', isMentioned: true };

  const first = await backend.respond({ cfg: cfg([]), chat, event, history: [] });
  assert.equal(first.text, '第一句回复');
  assert.equal(first.sessionPatch.dshSessionId, 'session-fake-0001');

  Object.assign(chat, first.sessionPatch);
  const second = await backend.respond({ cfg: cfg([]), chat, event, history: [] });
  assert.match(second.text, /续接会话/);
});

test('dsh 后端：超时会杀掉进程', async () => {
  const slow = path.join(here, 'fixtures/fake-dsh-slow.mjs');
  const backend = createsDshBackend({ cfg: cfg([process.execPath, slow]) });
  await assert.rejects(
    () => backend.respond({ cfg: cfg([]), chat: { id: 'g' }, event: { text: 'x' }, history: [] }),
    /超时/,
  );
});

test('dsh 后端：probe 能拿到版本', async () => {
  const backend = createsDshBackend({
    cfg: cfg([process.execPath, path.join(here, 'fixtures/fake-dsh.mjs')]),
  });
  const res = await backend.probe();
  assert.equal(res.ok, true);
  assert.match(res.version, /0\.2\.1/);
});
