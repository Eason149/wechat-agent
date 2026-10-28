import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSpeakNow, inQuietHours } from '../src/proactive.mjs';
import { merge, DEFAULTS } from '../src/config.mjs';

const base = (over = {}) => merge(DEFAULTS, {
  behavior: { proactive: { enabled: true, idleMinutes: 30, minIntervalMinutes: 10, maxPerDay: 3, chance: 1, quietHours: [], ...over } },
});

const now = new Date('2026-10-27T15:00:00').getTime();
const mk = (over = {}) => {
  const { cfg: cfgOver, ...rest } = over;
  return {
    cfg: base(cfgOver),
    chat: { lastReplyAt: 0 },
    now,
    lastInboundAt: now - 60 * 60_000,
    todayCount: 0,
    rng: () => 0,
    ...rest,
  };
};

test('关掉时永远不说话', () => {
  const r = shouldSpeakNow(mk({ cfg: { enabled: false } }));
  assert.equal(r.speak, false);
  assert.equal(r.reason, 'disabled');
});

test('刚有人说话时不插嘴', () => {
  const r = shouldSpeakNow(mk({ lastInboundAt: now - 60_000 }));
  assert.equal(r.reason, 'not-idle-yet');
});

test('安静够久 + 概率命中 → 说话', () => {
  const r = shouldSpeakNow(mk());
  assert.equal(r.speak, true);
});

test('概率没命中 → 沉默', () => {
  const r = shouldSpeakNow(mk({ rng: () => 0.99, cfg: { chance: 0.35 } }));
  assert.equal(r.reason, 'chance');
});

test('刚说过话要等间隔', () => {
  const r = shouldSpeakNow(mk({ chat: { lastReplyAt: now - 60_000 } }));
  assert.equal(r.reason, 'spoke-recently');
});

test('每日上限', () => {
  const r = shouldSpeakNow(mk({ todayCount: 3 }));
  assert.equal(r.reason, 'daily-cap');
});

test('深夜闭嘴', () => {
  const r = shouldSpeakNow(mk({ cfg: { quietHours: [[23, 8]] }, now: new Date('2026-10-27T23:30:00').getTime() }));
  assert.equal(r.reason, 'quiet-hours');
});

test('跨午夜的安静时段', () => {
  assert.equal(inQuietHours([[23, 8]], new Date('2026-10-27T02:00:00')), true);
  assert.equal(inQuietHours([[23, 8]], new Date('2026-10-27T09:00:00')), false);
  assert.equal(inQuietHours([[1, 6]], new Date('2026-10-27T03:00:00')), true);
  assert.equal(inQuietHours([], new Date('2026-10-27T03:00:00')), false);
});
