import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

/**
 * 本地模拟通道：不连微信，直接在终端里假装一个群。
 * 用来验证人设、触发策略、限流，再上真通道。
 *
 * 命令：
 *   /group 产品群    切换群
 *   /who 李四        切换说话人
 *   /mention         下一条消息 @机器人
 *   /stats           看统计
 *   /quit            退出
 */
export function createMockAdapter({ cfg, logger, mentionByDefault = false }) {
  let handler = null;
  let rl = null;
  let currentChat = { id: 'mock-group-1', name: '测试群' };
  let sender = { id: 'mock-user-1', name: '张三' };
  let nextMention = mentionByDefault;
  const stats = { sent: [] };

  return {
    name: 'mock',

    async start(onEvent) {
      handler = onEvent;
      rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
      printHelp(cfg);

      rl.on('line', async (line) => {
        const raw = line.trim();
        if (!raw) return;

        if (raw.startsWith('/')) {
          const [cmd, ...rest] = raw.split(/\s+/);
          const arg = rest.join(' ');
          switch (cmd) {
            case '/group':
              if (arg) currentChat = { id: `mock-${arg}`, name: arg };
              console.log(`[群] ${currentChat.name}`);
              break;
            case '/who':
              if (arg) sender = { id: `mock-${arg}`, name: arg };
              console.log(`[说话人] ${sender.name}`);
              break;
            case '/mention':
              nextMention = true;
              console.log('[下一条会 @ 机器人]');
              break;
            case '/stats':
              console.log(`[统计] 发出 ${stats.sent.length} 条：\n` + stats.sent.map((s) => `  ${s.chat} > ${s.text}`).join('\n'));
              break;
            case '/help':
              printHelp(cfg);
              break;
            case '/quit':
            case '/exit':
              rl.close();
              process.exit(0);
              break;
            default:
              console.log(`未知命令：${cmd}`);
          }
          return;
        }

        const evt = {
          id: randomUUID(),
          chatId: currentChat.id,
          chatName: currentChat.name,
          senderId: sender.id,
          senderName: sender.name,
          text: raw,
          isMentioned: nextMention,
          isSelf: false,
          type: 'text',
          ts: Date.now(),
        };
        nextMention = false;
        await handler(evt);
        process.stdout.write(`\n[${currentChat.name}] ${sender.name}: ${raw}\n> `);
      });

      rl.on('close', () => {
        if (this.onClose) this.onClose();
      });

      console.log('模拟群已就绪，输入消息试试（/help 看命令）。');
    },

    async send({ chatId, chatName, text }) {
      stats.sent.push({ chat: chatName || chatId, text });
      logger?.debug('发送（mock）', { chat: chatName, text });
      console.log(`\n🤖 ${cfg.agent.name}: ${text}`);
    },

    async stop() {
      rl?.close();
    },
  };
}

function printHelp(cfg) {
  console.log(`
可用命令：
  /group <群名>   切换群
  /who <昵称>     切换说话人
  /mention        下一条消息 @${cfg.agent.name}
  /stats          查看已发消息
  /quit           退出
直接输入文字即为群消息。
`);
}
