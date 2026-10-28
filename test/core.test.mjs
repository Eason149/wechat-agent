import test from 'node:test';
import assert from 'node:assert/strict';
import { decideReply } from '../src/policy.mjs';
import { splitReply, sanitizeReply, approxTokens, buildMessages } from '../src/prompt.mjs';
import { chatFileName } from '../src/store.mjs';
import { merge, DEFAULTS } from '../src/config.mjs';

const cfg = merge(DEFAULTS, {
  agent: { name: '小深' },
  behavior: {
    trigger: { mentions: true, keywords: ['小深'], whitelistGroups: [], whitelistReplyProbability: 0 },
    limits: {
      perGroupCooldownMs: 0,
      maxRepliesPerMinute: 3,
      maxRepliesPerHour: 10,
      staleMessageMs: 60000,
    },
    style: { splitMessages: true, maxCharsPerMessage: 20 },
  },
});

const baseEvent = {
  id: 'm1',
  chatId: 'g1',
  chatName: '测试群',
  senderId: 'u1',
  senderName: '张三',
  text: '今天几号',
  isMentioned: true,
  isSelf: false,
  type: 'text',
  ts: Date.now(),
};

const chat = { id: 'g1', name: '测试群', lastReplyAt: 0, replyTimestamps: [] };

test('被 @ 时回复', () => {
  const d = decideReply({ event: baseEvent, chat, cfg });
  assert.equal(d.action, 'reply');
  assert.equal(d.reason, 'mention');
});

test('没 @ 也没关键词时不回复', () => {
  const d = decideReply({ event: { ...baseEvent, isMentioned: false, text: '今天下雨吗' }, chat, cfg });
  assert.equal(d.action, 'ignore');
  assert.equal(d.reason, 'no-trigger');
});

test('关键词可以唤醒', () => {
  const d = decideReply({ event: { ...baseEvent, isMentioned: false, text: '小深在吗' }, chat, cfg });
  assert.equal(d.action, 'reply');
  assert.match(d.reason, /^keyword/);
});

test('自己发的消息不处理', () => {
  const d = decideReply({ event: { ...baseEvent, isSelf: true }, chat, cfg });
  assert.equal(d.reason, 'self');
});

test('过期消息不处理', () => {
  const d = decideReply({ event: { ...baseEvent, ts: Date.now() - 10 * 60_000 }, chat, cfg });
  assert.equal(d.reason, 'stale');
});

test('冷却期内不回复', () => {
  const now = Date.now();
  const d = decideReply({
    event: { ...baseEvent, ts: now },
    chat: { ...chat, lastReplyAt: now - 1000 },
    cfg: merge(cfg, { behavior: { limits: { perGroupCooldownMs: 10000 } } }),
    now,
  });
  assert.equal(d.action, 'ignore');
  assert.match(d.reason, /^cooldown/);
});

test('每分钟上限生效', () => {
  const now = Date.now();
  const d = decideReply({
    event: { ...baseEvent, ts: now },
    chat: { ...chat, replyTimestamps: [now - 1000, now - 2000, now - 3000] },
    cfg,
    now,
  });
  assert.equal(d.reason, 'rate-limit-minute');
});

test('白名单群按概率决定', () => {
  const c = merge(cfg, {
    behavior: { trigger: { whitelistGroups: ['测试'], whitelistReplyProbability: 0.5 } },
  });
  const evt = { ...baseEvent, isMentioned: false, text: '随便聊聊' };
  assert.equal(decideReply({ event: evt, chat, cfg: c, rng: () => 0.1 }).action, 'reply');
  assert.equal(decideReply({ event: evt, chat, cfg: c, rng: () => 0.9 }).action, 'ignore');
});

test('忽略指定发言人', () => {
  const c = merge(cfg, { behavior: { trigger: { ignoreSenders: ['广告号'] } } });
  const d = decideReply({ event: { ...baseEvent, senderName: '广告号小助手' }, chat, cfg: c });
  assert.equal(d.reason, 'ignored-sender');
});

test('清洗模型输出里的前缀与围栏', () => {
  assert.equal(sanitizeReply('小深：今天周三', cfg), '今天周三');
  assert.equal(sanitizeReply('```\n今天周三\n```', cfg), '今天周三');
  assert.equal(sanitizeReply('“今天周三”', cfg), '今天周三');
  assert.equal(sanitizeReply('[[SILENT]]', cfg), '');
});

test('长回复按句子切分且不超长', () => {
  const long = '第一句话在这里。第二句话也不短！第三句话继续补充？第四句话收个尾。';
  const parts = splitReply(long, cfg);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 20, `片段过长：${p}`);
  assert.equal(parts.join(''), long);
});

test('上下文按预算裁剪且最后一条是当前消息', async () => {
  const history = Array.from({ length: 30 }, (_, i) => ({
    role: 'user',
    senderName: `用户${i}`,
    text: '这是一条比较长的历史消息内容，用来测试裁剪。'.repeat(3),
    ts: Date.now() - (30 - i) * 1000,
  }));
  const msgs = await buildMessages({
    cfg,
    chat: { name: '测试群' },
    event: { ...baseEvent, text: '现在这个' },
    history,
  });
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs.at(-1).content.endsWith('现在这个'));
  assert.ok(msgs.length <= history.length + 2);
  assert.ok(approxTokens(msgs.map((m) => m.content).join('')) < 8000);
});

test('群 id 映射到安全文件名', () => {
  const a = chatFileName('123@chatroom');
  const b = chatFileName('../../etc/passwd');
  assert.match(a, /\.json$/);
  assert.ok(!b.includes('/'));
  assert.notEqual(chatFileName('g1'), chatFileName('g2'));
});
