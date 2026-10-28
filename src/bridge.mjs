import { chatCompletion, sleep } from './llm.mjs';
import { decideReply } from './policy.mjs';
import { sanitizeReply, splitReply } from './prompt.mjs';
import { createApiBackend } from './backends/api.mjs';
import { shouldSpeakNow } from './proactive.mjs';
import { createsDshBackend } from './backends/dsh.mjs';

/**
 * 把「通道事件」变成「模型/agent 调用」再变成「群消息」。
 * 通道只负责收发；backend 负责生成文本（直连模型，或交给 DSH agent）。
 */
export class Bridge {
  constructor({ cfg, store, adapter, logger, llm, backends }) {
    this.cfg = cfg;
    this.store = store;
    this.adapter = adapter;
    this.logger = logger;
    this.backends = backends || { api: createApiBackend({ llm: llm || chatCompletion }) };
    this.queues = new Map();
    this.running = false;
    this.paused = false;
    this.abort = new AbortController();
    this.metrics = { inbound: 0, replied: 0, ignored: 0, errors: 0, byBackend: {} };
    this.activeChats = new Map();
    this.proactiveTimer = null;
  }

  async start() {
    this.running = true;
    await this.store.init();
    await this.adapter.start((event) => this.enqueue(event));
    await this.restoreChats();
    this.startProactiveLoop();
    this.logger?.info(
      `已启动，通道=${this.adapter.name}，后端=${Object.keys(this.backends).join('/')}，模型=${this.cfg.agent.model}`,
    );
  }

  async stop() {
    this.running = false;
    if (this.proactiveTimer) clearInterval(this.proactiveTimer);
    this.abort.abort();
    await this.adapter.stop?.();
    await this.store.close();
    this.logger?.info('已停止', this.metrics);
  }

  /** 运行中切换通道：先停旧的，再起新的，保持暂停状态 */
  async restartAdapter(adapter) {
    const previous = this.adapter;
    try {
      await previous.stop?.();
    } catch (err) {
      this.logger?.warn('旧通道停止失败', err.message);
    }
    this.adapter = adapter;
    await adapter.start((event) => this.enqueue(event));
    if (this.paused) await adapter.pause?.();
    this.logger?.info(`通道已切换为 ${adapter.name}`);
    return adapter.name;
  }

  /** 同一个群串行处理，避免两条消息同时触发、互相看不到对方 */
  enqueue(event) {
    const key = event.chatId || 'unknown';
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev
      .then(() => this.handle(event))
      .catch((err) => this.logger?.error('处理消息异常', err.stack || err.message))
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    this.queues.set(key, next);
    return next;
  }

  /** 暂停：不再处理任何消息，同时让通道停止轮询（别偷偷截屏/切窗口） */
  async pause() {
    if (this.paused) return { ok: true, paused: true };
    this.paused = true;
    await this.adapter.pause?.();
    this.logger?.info('已暂停');
    return { ok: true, paused: true };
  }

  async resume() {
    if (!this.paused) return { ok: true, paused: false };
    this.paused = false;
    await this.adapter.resume?.();
    this.logger?.info('已恢复');
    return { ok: true, paused: false };
  }

  async handle(event) {
    if (!this.running) return;
    if (this.paused) {
      this.metrics.ignored += 1;
      return;
    }
    const cfg = this.cfg;
    this.metrics.inbound += 1;

    const chat = { id: event.chatId, name: event.chatName };
    if (cfg.behavior.dedupe?.enabled && event.id && this.store.seen(chat, event.id)) {
      this.logger?.debug('重复消息，跳过', { id: event.id });
      return;
    }
    if (cfg.behavior.dedupe?.enabled && event.id) await this.store.markSeen(chat, event.id);

    const state = await this.store.load(chat);
    this.activeChats.set(chat.id, { id: chat.id, name: chat.name });
    await this.store.append(chat, {
      role: 'user',
      senderId: event.senderId,
      senderName: event.senderName,
      text: event.text,
      ts: event.ts || Date.now(),
    });

    const decision = decideReply({ event, chat: state, cfg });
    if (decision.action !== 'reply') {
      this.metrics.ignored += 1;
      this.logger?.debug(`不回：${decision.reason}`, { chat: chat.name, text: clip(event.text, 60) });
      return;
    }

    this.logger?.info(`回消息（${decision.reason}）`, { chat: chat.name, from: event.senderName, text: clip(event.text, 80) });

    const mem = cfg.behavior.memory || {};
    const history = mem.enabled === false
      ? []
      : this.store.recentContext(state, {
          limit: mem.maxContextMessages || cfg.behavior.limits.maxContextMessages,
          ttlMinutes: mem.contextTtlMinutes || cfg.behavior.limits.contextTtlMinutes,
        });

    const backendName = pickBackend(cfg, event);
    const backend = this.backends[backendName] || this.backends.api;

    let reply;
    try {
      const res = await backend.respond({
        cfg,
        chat: state,
        event,
        history,
        signal: this.abort.signal,
      });
      reply = sanitizeReply(res.text, cfg);
      this.metrics.byBackend[backendName] = (this.metrics.byBackend[backendName] || 0) + 1;
      if (res.sessionPatch && Object.keys(res.sessionPatch).length) {
        Object.assign(state, res.sessionPatch);
        await this.store.flush(chat);
      }
      this.logger?.debug('生成完成', { backend: backendName, chars: (res.text || '').length, meta: res.meta });
    } catch (err) {
      this.metrics.errors += 1;
      this.logger?.error(`生成失败（${backendName}），本条不回`, err.message);
      return;
    }

    if (!reply) {
      this.metrics.ignored += 1;
      this.logger?.debug('模型选择沉默');
      await this.store.append(chat, { role: 'assistant', text: '[[SILENT]]', ts: Date.now() }).catch(() => {});
      return;
    }

    const chunks = splitReply(reply, cfg);
    for (let i = 0; i < chunks.length; i++) {
      let text = chunks[i];
      if (i === 0 && cfg.behavior.style.disclosure) text += cfg.behavior.style.disclosure;
      await this.delay();
      try {
        await this.adapter.send({ chatId: chat.id, chatName: chat.name, text });
      } catch (err) {
        this.metrics.errors += 1;
        this.logger?.error('发送失败', err.message);
        return;
      }
      await this.store.append(chat, { role: 'assistant', text, ts: Date.now() });
    }
    await this.store.noteReply(chat);
    this.metrics.replied += 1;
  }

  async restoreChats() {
    try {
      for (const st of await this.store.allStates()) {
        if (st?.id) this.activeChats.set(st.id, { id: st.id, name: st.name || st.id });
      }
    } catch (err) {
      this.logger?.warn('恢复历史会话失败', err.message);
    }
  }

  startProactiveLoop() {
    const p = this.cfg.behavior.proactive || {};
    if (!p.enabled) return;
    this.proactiveTimer = setInterval(() => this.maybeSpeak().catch((err) => this.logger?.error('主动发言出错', err.message)), 60_000);
    this.proactiveTimer.unref?.();
    const rate = p.perHour ? `约 ${p.perHour} 句/小时` : `${Math.round((p.chance ?? 0.35) * 100)}%/分钟`;
    this.logger?.info(`主动发言已开启：安静 ${p.idleMinutes} 分钟后可能开口，${rate}，每天最多 ${p.maxPerDay} 句`);
  }

  /** 供控制台"现在说一句"使用，返回 { text } */
  async speakNow(chatId, { dry = false } = {}) {
    const chat = this.activeChats.get(chatId);
    if (!chat) throw new Error('没有这个会话');
    return this.composeProactive(chat, { force: true, dry });
  }

  async maybeSpeak() {
    if (!this.running || this.paused) return;
    const p = this.cfg.behavior.proactive || {};
    if (!p.enabled) return;
    for (const chat of this.activeChats.values()) {
      const state = await this.store.load(chat);
      const lastInboundAt = lastUserTs(state);
      const todayCount = (state.proactiveTimestamps || []).filter((t) => sameDay(t, Date.now())).length;
      const verdict = shouldSpeakNow({ cfg: this.cfg, chat: state, lastInboundAt, todayCount });
      if (!verdict.speak) continue;
      this.logger?.info(`主动发言（${verdict.reason}）`, { chat: chat.name });
      await this.composeProactive(chat, { force: false });
    }
  }

  async composeProactive(chat, { force, dry = false }) {
    const state = await this.store.load(chat);
    const history = this.cfg.behavior.memory?.enabled === false
      ? []
      : this.store.recentContext(state, {
          limit: this.cfg.behavior.memory?.maxContextMessages || 24,
          ttlMinutes: this.cfg.behavior.memory?.contextTtlMinutes || 180,
        });

    const quietMinutes = Math.round((Date.now() - (lastUserTs(state) || Date.now())) / 60000);
    const hint = [
      `（系统提示：群里已经安静了约 ${quietMinutes} 分钟，没有人叫你。）`,
      '像群里的真人一样，随口接一句：可以吐槽、可以接梗、可以问个小问题、也可以只说半句。',
      '不要问"有人在吗"，不要重复自己说过的内容，不要总结，不要客套，不要每次都问问题。',
      '长度随机一点：有时一两个词，有时一句话。',
      '绝对不要挑衅、骂人、挑事、站队、评价群友的长相或人品；拿不准就沉默。',
      this.cfg.behavior.proactive?.promptHint || '',
      '如果没什么可说的，只输出 [[SILENT]]。',
    ].filter(Boolean).join('');

    const event = {
      id: `proactive-${Date.now()}`,
      chatId: chat.id,
      chatName: chat.name,
      senderId: 'system',
      senderName: '系统',
      text: hint,
      isMentioned: true,
      isSelf: false,
      type: 'text',
      ts: Date.now(),
    };

    const backendName = pickBackend(this.cfg, event);
    const backend = this.backends[backendName] || this.backends.api;
    const res = await backend.respond({ cfg: this.cfg, chat: state, event, history, signal: this.abort.signal });
    const reply = sanitizeReply(res.text, this.cfg);
    if (reply && UNSAFE.test(reply)) {
      this.logger?.warn('主动发言被拦下（语气过冲）', { text: reply.slice(0, 40) });
      return { text: '', blocked: true };
    }
    if (!reply) {
      this.logger?.info('主动发言：模型选择沉默');
      return { text: '' };
    }

    if (dry) return { text: reply, dry: true };

    const chunks = splitReply(reply, this.cfg);
    for (let i = 0; i < chunks.length; i++) {
      let text = chunks[i];
      if (i === 0 && this.cfg.behavior.style.disclosure) text += this.cfg.behavior.style.disclosure;
      if (!force) {
        // 第一次"想一下"更久，后续几条之间像真人那样停顿
        await sleep(i === 0 ? 1200 + Math.random() * 3200 : 900 + Math.random() * 1800);
      }
      await this.adapter.send({ chatId: chat.id, chatName: chat.name, text });
      await this.store.append(chat, { role: 'assistant', text, ts: Date.now() });
    }
    await this.store.noteReply(chat);
    if (!force) await this.store.noteProactive(chat);
    this.metrics.replied += 1;
    return { text: reply };
  }

  async delay() {
    const [min, max] = this.cfg.behavior.style.typingDelayMs || [0, 0];
    if (!max) return;
    const ms = min + Math.random() * Math.max(0, max - min);
    await sleep(ms);
  }
}

/** api：快；dsh：能干活但慢。auto 只把"被点名"的消息交给 agent。 */
export function pickBackend(cfg, event) {
  const mode = cfg.agent.backend || 'api';
  if (mode === 'dsh') return 'dsh';
  if (mode === 'auto') return event.isMentioned ? 'dsh' : 'api';
  return 'api';
}

// 主动开口没人审核，宁可不发也别在群里挑事
const UNSAFE = /(单挑|揍你|打死|弄死|滚|傻[逼比]|智障|脑残|去死|你妈|操你|傻叉|废物)/;

function lastUserTs(state) {
  const msgs = state?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') return msgs[i].ts;
  }
  return 0;
}

function sameDay(ts, now) {
  const a = new Date(ts);
  const b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
}
