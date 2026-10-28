import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseTranscript, diffNew, messageKey } from './macos/transcript.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * macOS 本机自动化通道：把微信当成一个黑盒 GUI。
 *
 * 读：截图 → Vision OCR → 还原成气泡（或 Cmd+A/Cmd+C 复制聊天记录）
 * 发：点输入框 → 剪贴板粘贴 → 回车
 *
 * 需要系统权限（辅助功能 + 屏幕录制）。不碰协议、不读数据库、不注入。
 * 代价：微信窗口必须开着，且只能盯当前打开的那个群。
 */
export function createMacosAdapter({ cfg, logger }) {
  const m = cfg.channel.macos || {};
  const python = m.python || path.join(PROJECT_ROOT, '.tools/venv/bin/python');
  const helper = m.helper || path.join(PROJECT_ROOT, 'scripts/mac/wechat_helper.py');
  const pollMs = m.pollMs ?? 3000;
  const readMode = m.readMode || 'ocr';
  const room = m.room || '';
  const dryRun = Boolean(m.dryRun);
  const autoRaise = Boolean(m.autoRaise);
  const sendKey = m.sendKey || 'enter';

  let timer = null;
  let handler = null;
  let paused = false;
  let prev = [];
  let stopped = false;
  let lastReason = '未检查';
  let lastWarnAt = 0;
  let sendQueue = Promise.resolve();

  async function callHelper(args, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, [helper, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, WX_ALLOW_RAISE: autoRaise ? '1' : '0' },
      });
      let out = '';
      let err = '';
      const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', (b) => (out += b));
      child.stderr.on('data', (b) => (err += b));
      child.on('close', (code) => {
        clearTimeout(t);
        if (code !== 0) return reject(new Error(`helper 退出码 ${code}：${(err || out).slice(-400)}`));
        try {
          resolve(JSON.parse(out.trim()));
        } catch {
          reject(new Error(`helper 输出不是 JSON：${out.slice(0, 200)}`));
        }
      });
      child.on('error', (e) => {
        clearTimeout(t);
        reject(new Error(`无法运行 helper：${e.message}`));
      });
    });
  }

  async function probe() {
    if (!existsSync(python)) {
      return { ok: false, error: `找不到 Python：${python}\n先建虚拟环境（见 RUNBOOK）` };
    }
    const res = await callHelper(['probe'], { timeoutMs: 20000 });
    const w = res.window;
    const mainish = Boolean(w && w.width >= 600 && w.height >= 400);
    return {
      ok: Boolean(res.permissions?.accessibility && res.permissions?.screen_recording && mainish),
      raw: res,
      missing: [
        !res.permissions?.accessibility && 'accessibility',
        !res.permissions?.screen_recording && 'screen-recording',
        !mainish && 'wechat-window',
      ].filter(Boolean),
    };
  }

  async function readOnce() {
    const win = await callHelper(['bounds'], { timeoutMs: 15000 }).catch(() => null);
    const b = win?.bounds;
    if (!b || b.width < 600 || b.height < 400) {
      lastReason = '窗口不可见（被最小化或关闭）';
      throw new Error(lastReason);
    }
    lastReason = '正常';
    if (readMode === 'clipboard') {
      const res = await callHelper(['copy-all']);
      if (!res.ok) throw new Error(res.error || '复制聊天记录失败');
      return parseTranscript(res.text);
    }
    const res = await callHelper(['read', '--mode', 'ocr']);
    if (!res.ok) throw new Error(res.error || '读取失败');
    return (res.messages || []).map((x) => ({ sender: x.sender || '群友', time: '', text: x.text }));
  }

  return {
    name: 'macos',
    probe,
    readOnce,
    get status() {
      return { visible: lastReason === '正常', reason: lastReason };
    },

    async start(onEvent) {
      handler = onEvent;
      const p = await probe();
      // 只有权限问题才拒绝启动；窗口暂时被最小化/切走就等等，恢复后自动接上
      const blocking = (p.missing || []).filter((m) => m !== 'wechat-window');
      if (blocking.length) throw new Error(explainMissing(p));
      if (!p.ok) logger.warn(explainMissing(p).split('\n').slice(-2).join(' '));
      if (room && p.raw?.window?.name && !String(p.raw.window.name).includes(room)) {
        logger.warn(`当前微信窗口是「${p.raw.window.name}」，不是配置里的「${room}」——请手动切到目标群`);
      }

      // 首轮只记录，不回复历史消息
      try {
        prev = await readOnce();
        logger.info(`已读取当前聊天 ${prev.length} 条作为基线`);
      } catch (err) {
        logger.warn('基线读取失败，跳过历史', err.message);
      }

      const loop = async () => {
        if (stopped) return;
        if (paused) {
          timer = setTimeout(loop, pollMs);
          return;
        }
        try {
          const curr = await readOnce();
          const fresh = diffNew(prev, curr);
          prev = curr;
          const baseline = new Set(prev.slice(0, -Math.max(fresh.length, 1)).map(messageKey));
          for (const msg of fresh) {
            if (baseline.has(messageKey(msg))) continue;
            const text = (msg.text || '').trim();
            if (!text) continue;
            if (msg.sender === '我') continue; // 自己发的不用理
            await handler({
              id: createHash('sha1').update(`${msg.sender}|${msg.time}|${text}`).digest('hex').slice(0, 16),
              chatId: room || 'macos-current',
              chatName: room || '微信当前聊天',
              senderId: msg.sender,
              senderName: msg.sender,
              text,
              isMentioned: Boolean(cfg.agent.name && text.includes(`@${cfg.agent.name}`)),
              type: 'text',
              ts: Date.now(),
            });
          }
        } catch (err) {
          const now = Date.now();
          if (now - lastWarnAt > 60000) {
            lastWarnAt = now;
            logger.warn(`读取失败：${err.message}`);
          }
        }
        if (!stopped) timer = setTimeout(loop, pollMs);
      };
      timer = setTimeout(loop, pollMs);
    },

    send({ text }) {
      // 串行发送：UI 操作不能并发
      sendQueue = sendQueue.then(async () => {
        const res = await callHelper(['send', '--text', text, '--send-key', sendKey, ...(dryRun ? ['--dry-run'] : [])]);
        if (!res.ok) throw new Error(res.error || '发送失败');
        if (dryRun) logger.info(`[dry-run] 本应发送：${text}`);
        else if (res.shortcut) logger.info(`已发送（用 ${res.shortcut === 'cmd+enter' ? '⌘+回车' : '回车'} 键）`);
      });
      return sendQueue;
    },

    async pause() {
      paused = true;
      logger.info('已暂停轮询微信窗口');
    },

    async resume() {
      paused = false;
      logger.info('已恢复轮询微信窗口');
    },

    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function explainMissing(probeResult) {
  const lines = ['macOS 通道还不能启动：'];
  const missing = probeResult.missing || [];
  if (missing.includes('accessibility')) {
    lines.push('  ✗ 辅助功能：系统设置 → 隐私与安全性 → 辅助功能 → 加上运行它的程序（终端 / DeepSeek Harness）');
  }
  if (missing.includes('screen-recording')) {
    lines.push('  ✗ 屏幕录制：系统设置 → 隐私与安全性 → 屏幕录制 → 加上同一个程序');
  }
  if (missing.includes('wechat-window')) {
    lines.push('  ✗ 没找到微信主窗口：打开微信、登录，并把目标群点开，让它保持可见');
  }
  lines.push('改完权限要完全退出并重开那个程序，权限才生效。');
  return lines.join('\n');
}
