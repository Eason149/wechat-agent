import { readFile } from 'node:fs/promises';

const DEFAULT_PERSONA = `你是 AI 助手。请准确、简洁地回答问题。缺少信息时如实说明，不要编造事实。尊重用户隐私，不输出凭证或个人资料。只输出回复正文。无需回复时输出 [[SILENT]]。`;

export const TONES = {
  neutral: '',
  concise: '说话尽量短，能一句说清就一句，不解释过程，不铺垫。',
  witty: '语气轻松，可以抖个机灵、自嘲一句，但别油腻、别玩梗过度。',
  warm: '语气温和有耐心，像靠得住的朋友，先接住对方的情绪再回答。',
  formal: '用词正式、克制，不卖萌、不用网络用语，适合工作群。',
};

export function toneInstruction(cfg) {
  const preset = TONES[cfg.agent.tone] || '';
  const extra = (cfg.agent.toneExtra || '').trim();
  const bits = [preset, extra].filter(Boolean);
  return bits.length ? `# 语气\n${bits.join('\n')}` : '';
}

let personaCache = null;

export async function loadPersona(cfg) {
  if (personaCache) return personaCache;
  try {
    const text = await readFile(cfg.agent.personaFile, 'utf8');
    personaCache = text.trim() || DEFAULT_PERSONA;
  } catch {
    personaCache = DEFAULT_PERSONA;
  }
  return personaCache;
}

export function resetPersonaCache() {
  personaCache = null;
}

/** 粗略 token 估算：中文约 1 字 ≈ 1 token，英文 4 字符 ≈ 1 token */
export function approxTokens(text) {
  let cjk = 0;
  for (const ch of text) if (/[\u4e00-\u9fff]/.test(ch)) cjk++;
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

const SENDER_LABEL_CAP = 12;

/**
 * 组装发给模型的 messages。
 * 群聊历史把每条说成「昵称：内容」，让模型知道谁在说话。
 */
export async function buildMessages({ cfg, chat, event, history, now = new Date() }) {
  const persona = await loadPersona(cfg);
  const rules = [
    `当前群：${event.chatName || chat?.name || '未知群'}`,
    `当前时间：${formatNow(now)}`,
    `你的名字：${cfg.agent.name}`,
    '你看到的是这个群最近的消息，格式为「昵称：内容」。',
    '只输出你要发到群里的内容本身；不要复述别人的话，不要加前缀。',
    '如果这条消息不需要你说话，只输出 [[SILENT]]。',
  ].join('\n');

  const tone = toneInstruction(cfg);
  const system = [persona, tone, `# 运行环境\n${rules}`].filter(Boolean).join('\n\n---\n');

  const budget = 6000;
  const picked = [];
  let used = approxTokens(system) + 400;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const line = m.role === 'assistant' ? m.text : `${label(m.senderName)}：${m.text}`;
    const cost = approxTokens(line) + 4;
    if (used + cost > budget) break;
    used += cost;
    picked.unshift({ role: m.role === 'assistant' ? 'assistant' : 'user', content: line });
  }

  // 保证最后一条是当前消息
  const current = { role: 'user', content: `${label(event.senderName)}：${(event.text || '').trim()}` };
  if (picked.length && picked.at(-1).content === current.content) picked.pop();

  return [{ role: 'system', content: system }, ...picked, current];
}

function label(name) {
  const n = (name || '群友').trim();
  return n.length > SENDER_LABEL_CAP ? n.slice(0, SENDER_LABEL_CAP) : n;
}

function formatNow(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const week = '日一二三四五六'[d.getDay()];
  const tz = process.env.TZ || '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 周${week} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}${tz ? ` (${tz})` : ''}`;
}

/** 清洗模型输出：去掉常见前缀、包裹引号、代码围栏 */
export function sanitizeReply(text, cfg) {
  if (!text) return '';
  let out = text.trim();
  if (out.includes('[[SILENT]]')) return '';
  out = out.replace(/^```[\w-]*\n?/, '').replace(/\n?```$/, '');
  const prefix = new RegExp(`^(${escapeRe(cfg.agent.name)}|助手|回复)\\s*[:：]\\s*`, 'i');
  out = out.replace(prefix, '');
  out = out.replace(/^["“「'](.+)["”」']$/s, '$1');
  return out.trim();
}

/** 长回复按句子切成几条，模拟真人在群里分段发 */
export function splitReply(text, cfg) {
  const style = cfg.behavior.style;
  const max = style.maxCharsPerMessage || 160;
  if (!style.splitMessages || text.length <= max) return [text];

  const parts = text
    .split(/(?<=[。！？!?~～\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  let buf = '';
  for (const p of parts) {
    if (buf && (buf + p).length > max) {
      out.push(buf);
      buf = p;
    } else {
      buf += p;
    }
    while (buf.length > max) {
      out.push(buf.slice(0, max));
      buf = buf.slice(max);
    }
  }
  if (buf) out.push(buf);
  return out.slice(0, 4);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
