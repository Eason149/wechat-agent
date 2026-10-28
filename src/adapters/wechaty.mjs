/**
 * Wechaty 通道（个人微信）。实验性：需要 puppet token，且属于非官方协议。
 *
 * 安装依赖：
 *   npm install wechaty wechaty-puppet-padlocal
 * 配置：
 *   channel.type = "wechaty"
 *   环境变量 WECHATY_PUPPET_PADLOCAL_TOKEN=<你的 token>
 * 启动后终端会打印二维码，用手机微信扫码登录。
 */
export async function createWechatyAdapter({ cfg, logger }) {
  let wechaty;
  try {
    wechaty = await import('wechaty');
  } catch {
    throw new Error('未安装 wechaty，请先运行：npm install wechaty wechaty-puppet-padlocal');
  }

  const { WechatyBuilder } = wechaty;
  const wcfg = cfg.channel.wechaty || {};
  const puppet = wcfg.puppet || 'wechaty-puppet-padlocal';
  const token = process.env[wcfg.tokenEnv || 'WECHATY_PUPPET_PADLOCAL_TOKEN'];
  if (!token) {
    throw new Error(`缺少 puppet token：请设置环境变量 ${wcfg.tokenEnv || 'WECHATY_PUPPET_PADLOCAL_TOKEN'}`);
  }

  const bot = WechatyBuilder.build({
    name: wcfg.name || 'wechat-agent',
    puppet,
    puppetOptions: { token },
  });

  let handler = null;
  let selfName = '';
  const rooms = new Map();

  bot.on('scan', async (qrcode, status) => {
    logger.info(`需要扫码登录（状态 ${status}）`);
    try {
      const mod = await import('qrcode-terminal');
      mod.default.generate(qrcode, { small: true });
    } catch {
      logger.info(`未安装 qrcode-terminal，请把下面的地址转成二维码：\nhttps://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`);
    }
  });

  bot.on('login', (user) => {
    selfName = user.name();
    logger.info(`已登录：${selfName}`);
  });

  bot.on('logout', (user) => logger.warn(`已登出：${user?.name?.() || '未知'}`));
  bot.on('error', (err) => logger.error('wechaty 错误', err?.message || String(err)));

  bot.on('message', async (msg) => {
    try {
      if (!handler) return;
      if (msg.self()) return;

      const room = msg.room();
      if (!room) return; // 只处理群消息；私聊要开的话在这里放开

      if (msg.type() !== bot.Message.Type.Text && msg.type() !== bot.Message.Type.Unknown) return;

      const chatId = room.id;
      const chatName = (await room.topic()) || chatId;
      rooms.set(chatId, room);

      const talker = msg.talker();
      let text = msg.text() || '';
      const isMentioned = await msg.mentionSelf().catch(() => false);
      // 微信 @ 会在正文里带上 "@昵称 "
      if (isMentioned || selfName) {
        text = text.replace(new RegExp(`@${escapeRe(selfName)}\\s*`, 'g'), '').trim();
      }
      if (!text) return;

      await handler({
        id: msg.id,
        chatId,
        chatName,
        senderId: talker.id,
        senderName: talker.name(),
        text,
        isMentioned,
        type: 'text',
        ts: msg.date()?.getTime?.() || Date.now(),
      });
    } catch (err) {
      logger.error('处理 wechaty 消息失败', err?.stack || String(err));
    }
  });

  return {
    name: 'wechaty',

    async start(onEvent) {
      handler = onEvent;
      await bot.start();
    },

    async send({ chatId, chatName, text }) {
      let room = rooms.get(chatId);
      if (!room && bot.Room?.load) {
        room = await bot.Room.load(chatId).catch(() => null);
      }
      if (!room && bot.Room?.find && chatName) {
        room = await bot.Room.find({ topic: chatName }).catch(() => null);
      }
      if (!room) throw new Error(`找不到群：${chatName || chatId}`);
      rooms.set(chatId, room);
      await new Promise((r) => setTimeout(r, 200)); // 真人节奏
      await room.say(text);
    },

    async stop() {
      await bot.stop().catch(() => {});
    },
  };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
