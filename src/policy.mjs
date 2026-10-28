/**
 * 触发策略：判断一条群消息该不该回。
 * 纯函数，方便测试；所有拒绝都带 reason，方便在日志里解释"为什么没说话"。
 */
export function decideReply({ event, chat, cfg, now = Date.now(), rng = Math.random }) {
  const t = cfg.behavior.trigger;
  const l = cfg.behavior.limits;
  const ignore = (reason) => ({ action: 'ignore', reason });

  if (event.isSelf) return ignore('self');
  if (event.type && event.type !== 'text') return ignore(`non-text:${event.type}`);
  const text = (event.text || '').trim();
  if (!text) return ignore('empty');
  if (text.length < (t.minTextLength ?? 1)) return ignore('too-short');

  const staleMs = l.staleMessageMs ?? 60000;
  if (event.ts && now - event.ts > staleMs) return ignore('stale');

  const sender = `${event.senderName || ''} ${event.senderId || ''}`.toLowerCase();
  if ((t.ignoreSenders || []).some((s) => sender.includes(String(s).toLowerCase()))) {
    return ignore('ignored-sender');
  }

  const whitelisted = (t.whitelistGroups || []).some((g) => matchGroup(g, event, chat));
  const mentioned = Boolean(event.isMentioned) && t.mentions !== false;
  const keywordHit = (t.keywords || []).find((k) => k && text.toLowerCase().includes(String(k).toLowerCase()));

  if (!whitelisted && !mentioned && !keywordHit) return ignore('no-trigger');

  // 限流：先冷却，再按分钟/小时窗口
  const cooldown = l.perGroupCooldownMs ?? 0;
  const lastReplyAt = chat?.lastReplyAt || 0;
  if (cooldown > 0 && now - lastReplyAt < cooldown) {
    return ignore(`cooldown:${Math.ceil((cooldown - (now - lastReplyAt)) / 1000)}s`);
  }
  const stamps = (chat?.replyTimestamps || []).filter((ts) => now - ts < 3600_000);
  const lastMinute = stamps.filter((ts) => now - ts < 60_000).length;
  if (lastMinute >= (l.maxRepliesPerMinute ?? Infinity)) return ignore('rate-limit-minute');
  if (stamps.length >= (l.maxRepliesPerHour ?? Infinity)) return ignore('rate-limit-hour');

  // 白名单群里按概率接话，避免刷屏
  if (!mentioned && !keywordHit && whitelisted) {
    if (rng() > (t.whitelistReplyProbability ?? 0)) return ignore('probability');
  }

  return {
    action: 'reply',
    reason: mentioned ? 'mention' : keywordHit ? `keyword:${keywordHit}` : 'whitelist',
  };
}

function matchGroup(pattern, event, chat) {
  const p = String(pattern).toLowerCase();
  return [event.chatId, event.chatName, chat?.name].filter(Boolean).some((v) => String(v).toLowerCase().includes(p));
}

/**
 * 只允许 @机器人 时把消息交给模型；这里再判断一次"是否直接针对我"，
 * 用于把"群里随便提到某个词"和"指名要我回答"区分开。
 */
export function isDirectedAtBot(event, cfg) {
  if (event.isMentioned) return true;
  if (event.isReplyToBot) return true;
  const name = cfg.agent?.name;
  return Boolean(name && (event.text || '').includes(`@${name}`));
}
