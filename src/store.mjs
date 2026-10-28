import { mkdir, readFile, rename, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MAX_STORED_MESSAGES = 80;

export function chatFileName(chatId) {
  const safe = String(chatId).replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40);
  const hash = createHash('sha1').update(String(chatId)).digest('hex').slice(0, 8);
  return `${safe || 'chat'}-${hash}.json`;
}

/**
 * 每个群一个 JSON 文件，内存缓存 + 原子写。
 * 不做数据库：群数量少、写入频率低，够用且便于排查。
 */
export class ChatStore {
  constructor(dir, logger) {
    this.dir = dir;
    this.logger = logger;
    this.cache = new Map();
    this.pending = new Map();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
  }

  async listChats() {
    const files = await readdir(this.dir).catch(() => []);
    return files.filter((f) => f.endsWith('.json'));
  }

  async load(chat) {
    const id = chat.id;
    if (this.cache.has(id)) {
      const cached = this.cache.get(id);
      // 允许外部更新群名
      if (chat.name && chat.name !== cached.name) cached.name = chat.name;
      return cached;
    }
    const file = path.join(this.dir, chatFileName(id));
    let data = null;
    try {
      data = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') this.logger?.warn(`读取会话失败 ${file}`, err.message);
    }
    const state = {
      id,
      name: chat.name || data?.name || id,
      createdAt: data?.createdAt || Date.now(),
      updatedAt: data?.updatedAt || Date.now(),
      messages: Array.isArray(data?.messages) ? data.messages : [],
      replyTimestamps: Array.isArray(data?.replyTimestamps) ? data.replyTimestamps : [],
      proactiveTimestamps: Array.isArray(data?.proactiveTimestamps) ? data.proactiveTimestamps : [],
      seenIds: Array.isArray(data?.seenIds) ? data.seenIds : [],
      lastReplyAt: data?.lastReplyAt || 0,
      stats: data?.stats || { inbound: 0, replies: 0, errors: 0 },
    };
    this.cache.set(id, state);
    return state;
  }

  async append(chat, message) {
    const state = await this.load(chat);
    state.messages.push(message);
    state.updatedAt = Date.now();
    if (message.role === 'assistant') {
      state.lastReplyAt = message.ts;
    } else {
      state.stats.inbound += 1;
    }
    if (state.messages.length > MAX_STORED_MESSAGES) {
      state.messages.splice(0, state.messages.length - MAX_STORED_MESSAGES);
    }
    await this.flush(chat);
    return state;
  }

  /** 记账：回复次数与限流窗口 */
  async noteReply(chat, ts = Date.now()) {
    const state = await this.load(chat);
    state.lastReplyAt = ts;
    state.replyTimestamps.push(ts);
    state.replyTimestamps = state.replyTimestamps.filter((t) => ts - t < 3600_000);
    state.stats.replies += 1;
    state.updatedAt = ts;
    await this.flush(chat);
  }

  async noteProactive(chat, ts = Date.now()) {
    const state = await this.load(chat);
    state.proactiveTimestamps = [...(state.proactiveTimestamps || []), ts].filter((t) => ts - t < 86400_000);
    state.lastReplyAt = ts;
    state.updatedAt = ts;
    await this.flush(chat);
  }

  /** 读出磁盘上所有会话（启动时恢复，主动发言要遍历群） */
  async allStates() {
    const files = await this.listChats();
    const out = [];
    for (const f of files) {
      try {
        const data = JSON.parse(await readFile(path.join(this.dir, f), 'utf8'));
        out.push(data);
      } catch {
        /* 坏文件跳过 */
      }
    }
    return out;
  }

  seen(chat, key) {
    const state = this.cache.get(chat.id);
    if (!state) return false;
    return state.seenIds.includes(key);
  }

  async markSeen(chat, key) {
    const state = await this.load(chat);
    if (!state.seenIds.includes(key)) {
      state.seenIds.push(key);
      if (state.seenIds.length > 500) state.seenIds.splice(0, state.seenIds.length - 500);
      await this.flush(chat);
    }
  }

  /** 合并 300ms 内的写入，避免频繁落盘 */
  async flush(chat) {
    const id = chat.id;
    const state = this.cache.get(id);
    if (!state) return;
    if (this.pending.has(id)) return this.pending.get(id);
    const p = (async () => {
      await new Promise((r) => setTimeout(r, 150));
      const file = path.join(this.dir, chatFileName(id));
      const tmp = `${file}.tmp-${process.pid}`;
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
      await rename(tmp, file);
    })()
      .catch((err) => this.logger?.warn(`写入会话失败 ${id}`, err.message))
      .finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  async close() {
    await Promise.allSettled([...this.pending.values()]);
  }

  /** 供 prompt 使用：最近 n 条，且过滤过期会话 */
  recentContext(state, { limit, ttlMinutes }, now = Date.now()) {
    if (!state) return [];
    const ttlMs = (ttlMinutes ?? 180) * 60_000;
    return state.messages.filter((m) => now - m.ts <= ttlMs).slice(-limit);
  }
}
