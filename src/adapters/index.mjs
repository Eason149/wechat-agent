/** 通道工厂：cli 和控制台都走这里，避免两处各写一份 switch */
export async function createAdapter(cfg, logger) {
  switch (cfg.channel.type) {
    case 'mock': {
      const { createMockAdapter } = await import('./mock.mjs');
      return createMockAdapter({ cfg, logger });
    }
    case 'macos': {
      const { createMacosAdapter } = await import('./macos.mjs');
      return createMacosAdapter({ cfg, logger });
    }
    case 'wechaty': {
      const { createWechatyAdapter } = await import('./wechaty.mjs');
      return createWechatyAdapter({ cfg, logger });
    }
    default:
      throw new Error(`未知通道类型：${cfg.channel.type}（可选：mock、wechaty、macos）`);
  }
}

export const CHANNELS = {
  mock: { label: '模拟', desc: '终端里假装一个群，不需要微信' },
  macos: { label: '本机微信 (macOS)', desc: '截图 OCR + 模拟键盘，需要辅助功能和屏幕录制权限' },
  wechaty: { label: 'Wechaty', desc: '协议网关，需要 puppet token，可多群' },
};
