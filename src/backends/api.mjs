import { chatCompletion } from '../llm.mjs';
import { buildMessages } from '../prompt.mjs';

/**
 * 直连模型：每次把（人设 + 最近若干条群聊）发给 OpenAI 兼容接口。
 * 快、便宜、无状态；但没有本机工具能力。
 */
export function createApiBackend({ llm = chatCompletion } = {}) {
  return {
    name: 'api',
    async respond({ cfg, chat, event, history, signal }) {
      const messages = await buildMessages({ cfg, chat, event, history });
      const res = await llm({ cfg, messages, signal });
      return { text: res.text, usage: res.usage, sessionPatch: {} };
    },
  };
}
