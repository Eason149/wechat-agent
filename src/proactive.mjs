/**
 * 主动发言：群里安静太久时，偶尔自己冒一句。
 * 纯函数决定"现在该不该说"，方便测试；真正生成和发送在 bridge 里。
 */
export function shouldSpeakNow({ cfg, chat, now = Date.now(), lastInboundAt = 0, todayCount = 0, rng = Math.random }) {
  const p = cfg.behavior.proactive || {};
  const ignore = (reason) => ({ speak: false, reason });

  if (!p.enabled) return ignore('disabled');
  if (!chat) return ignore('no-chat');

  const idleMs = (p.idleMinutes ?? 45) * 60_000;
  if (!lastInboundAt) return ignore('no-activity-baseline');
  if (now - lastInboundAt < idleMs) return ignore('not-idle-yet');

  // 间隔上下浮动 60%–140%，免得每次都在整分钟上说话
  const baseGap = (p.minIntervalMinutes ?? 4) * 60_000;
  const minGap = baseGap * (0.6 + rng() * 0.8);
  if (chat.lastReplyAt && now - chat.lastReplyAt < minGap) return ignore('spoke-recently');

  if (todayCount >= (p.maxPerDay ?? 6)) return ignore('daily-cap');

  if (inQuietHours(p.quietHours, new Date(now))) return ignore('quiet-hours');

  // 每分钟命中概率：目标 10 句/小时 → 每分钟约 16.7%
  const perHour = p.perHour ?? 0;
  const perMinute = perHour > 0 ? Math.min(1, perHour / 60) : (p.chance ?? 0.35);
  if (rng() > perMinute) return ignore('chance');

  return { speak: true, reason: 'idle' };
}

/** quietHours: [[23, 8]] 表示 23 点到次日 8 点闭嘴 */
export function inQuietHours(ranges, date) {
  if (!ranges || !ranges.length) return false;
  const h = date.getHours();
  for (const [from, to] of ranges) {
    if (from <= to ? h >= from && h < to : h >= from || h < to) return true;
  }
  return false;
}

/** 从人群里挑一个"最近说得最多的人"当话题引子，比纯随机更像人 */
export function pickTopicSeed(history, rng = Math.random) {
  const recent = (history || []).slice(-8).filter((m) => m.role === 'user' && m.text);
  if (!recent.length) return null;
  return recent[Math.floor(rng() * recent.length)];
}
