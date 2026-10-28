/**
 * 把「微信聊天窗口里复制出来的文本」解析成一条条消息。
 *
 * 微信 Mac 版 Cmd+A / Cmd+C 复制聊天记录时，常见两种形态：
 *
 *   张三 2026-10-27 17:20
 *   今天开会吗
 *
 *   李四：收到
 *
 * 也可能是「昵称 时间」和内容挤在同一行。这里都兼容。
 * 纯函数，便于用真实样本做回归测试。
 */

const HEADER_WITH_TIME = /^\s*(.{1,40}?)\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2})\s*$/;
const INLINE_WITH_TIME = /^\s*(.{1,40}?)\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2})\s*[:：]\s*(.+)$/;
const INLINE_NAME_COLON = /^\s*([^\s:：]{1,20})\s*[:：]\s*(.+)$/;

const NOISE = [/^以下为新消息$/, /^-+$/, /^\s*$/];

export function parseTranscript(raw) {
  if (!raw) return [];
  const lines = String(raw)
    .replace(/\r\n?/g, '\n')
    .split('\n');

  const out = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    if (text) out.push({ sender: current.sender, time: current.time, text });
    current = null;
  };

  for (const line of lines) {
    if (NOISE.some((re) => re.test(line))) {
      if (!/^\s*$/.test(line)) flush();
      continue;
    }

    const inlineTime = line.match(INLINE_WITH_TIME);
    if (inlineTime) {
      flush();
      out.push({ sender: cleanSender(inlineTime[1]), time: inlineTime[2], text: inlineTime[3].trim() });
      continue;
    }

    const header = line.match(HEADER_WITH_TIME);
    if (header) {
      flush();
      current = { sender: cleanSender(header[1]), time: header[2], lines: [] };
      continue;
    }

    if (!current) {
      const inline = line.match(INLINE_NAME_COLON);
      if (inline) {
        out.push({ sender: cleanSender(inline[1]), time: '', text: inline[2].trim() });
      }
      continue;
    }

    current.lines.push(line);
  }
  flush();
  return out.filter((m) => m.text && !isSystemNotice(m));
}

function cleanSender(s) {
  return String(s)
    .replace(/^[@\s]+/, '')
    .replace(/\s*[:：]\s*$/, '')
    .trim();
}

/** 「你撤回了一条消息」「XX 加入了群聊」这类不是人说的话 */
function isSystemNotice(m) {
  return (
    /撤回了一条消息/.test(m.text) ||
    /加入了群聊/.test(m.text) ||
    /退出了群聊/.test(m.text) ||
    /修改群名为/.test(m.text)
  );
}

export function messageKey(m) {
  return `${m.sender}|${m.time}|${m.text}`;
}

/**
 * 两次轮询之间，找出新增的消息。
 * 聊天记录只会变长：在 curr 里找到 prev 结尾的那一段，后面的就是新的。
 * 找不到重叠时保守地认为只有最后一条是新的（避免把整屏历史当成新消息刷出去）。
 */
export function diffNew(prev, curr) {
  if (!curr.length) return [];
  if (!prev.length) return curr;

  const maxK = Math.min(prev.length, curr.length);
  for (let k = maxK; k > 0; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (messageKey(prev[prev.length - k + i]) !== messageKey(curr[i])) {
        same = false;
        break;
      }
    }
    if (same) return curr.slice(k);
  }
  return curr.slice(-1);
}
