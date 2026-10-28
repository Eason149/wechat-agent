import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULTS = {
  agent: {
    name: '小深',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 1.15,
    maxTokens: 360,
    timeoutMs: 45000,
    personaFile: 'persona.md',
    // 语气预设 + 附加要求，控制台里可实时改
    tone: 'neutral',
    toneExtra: '',
    // api：直连模型，最快；dsh：交给 DSH 自己的 agent（有工具，但每条要冷启动）
    backend: 'api',
    dsh: {
      command: null,
      binPath: '',
      nodePath: '',
      cwd: './agent-workspace',
      dshHome: '',
      timeoutMs: 240000,
    },
  },
  behavior: {
    memory: { enabled: true, maxContextMessages: 24, contextTtlMinutes: 180 },
    // 去重：OCR 没有真正的消息 id，同一句话发两次会被误杀，所以默认关
    dedupe: { enabled: false },
    // 群里安静时偶尔自己说一句
    proactive: {
      enabled: false,
      perHour: 15,          // 目标频率：安静时每小时大约说几句
      idleMinutes: 2,
      minIntervalMinutes: 2.5,
      maxIntervalMinutes: 120,
      maxPerDay: 180,
      chance: 0.35,         // 没设 perHour 时才用
      quietHours: [[23, 8]],
      promptHint: '',
    },
    trigger: {
      mentions: true,
      keywords: [],
      whitelistGroups: [],
      whitelistReplyProbability: 0,
      ignoreSenders: [],
      minTextLength: 1,
    },
    limits: {
      perGroupCooldownMs: 10000,
      maxRepliesPerMinute: 5,
      maxRepliesPerHour: 60,
      maxContextMessages: 24,
      contextTtlMinutes: 180,
      staleMessageMs: 60000,
    },
    style: {
      splitMessages: true,
      maxCharsPerMessage: 160,
      typingDelayMs: [500, 1600],
      disclosure: '',
    },
  },
  panel: { enabled: true, port: 7788, openBrowser: true },
  channel: {
    type: 'mock',
    wechaty: {},
    // macOS 本机自动化：截图 OCR 读、剪贴板+回车发
    // autoRaise：窗口不在前台时自动切过来读一次（会抢焦点，默认关）
    macos: {
      python: '', helper: '', room: '', pollMs: 3000, readMode: 'ocr',
      dryRun: false, autoRaise: false, sendKey: 'enter',
    },
  },
  storage: { dir: './data' },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并：对象递归合并，数组与标量整体替换 */
export function merge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

/**
 * 读取配置。优先级：默认值 < config.json < 环境变量（少量关键项）
 */
/** 读 secrets.env（KEY=VALUE），只补没有的环境变量，不覆盖已有的 */
export async function loadSecrets(dir) {
  try {
    const text = await readFile(path.join(dir, 'secrets.env'), 'utf8');
    let n = 0;
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const [, key, rawValue] = m;
      const value = rawValue.replace(/^['"]|['"]$/g, '');
      if (!process.env[key] && value) {
        process.env[key] = value;
        n += 1;
      }
    }
    return n;
  } catch {
    return 0;
  }
}

export async function loadConfig(configPath = './config.json') {
  const abs = path.resolve(configPath);
  let raw = {};
  try {
    raw = JSON.parse(await readFile(abs, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`配置文件不存在：${abs}\n先运行：node src/cli.mjs init`);
    }
    throw new Error(`配置文件解析失败：${abs}\n${err.message}`);
  }
  const cfg = merge(DEFAULTS, raw);
  cfg.rootDir = path.dirname(abs);
  cfg.configPath = abs;
  // 启动时把 secrets.env 灌进环境变量，避免"重启后 key 丢了"
  cfg.secretsLoaded = await loadSecrets(cfg.rootDir);

  if (process.env.WECHAT_AGENT_MODEL) cfg.agent.model = process.env.WECHAT_AGENT_MODEL;
  if (process.env.WECHAT_AGENT_BASE_URL) cfg.agent.baseUrl = process.env.WECHAT_AGENT_BASE_URL;

  cfg.storage.dir = path.resolve(cfg.rootDir, cfg.storage.dir);
  cfg.agent.personaFile = path.resolve(cfg.rootDir, cfg.agent.personaFile);
  return cfg;
}

export function resolveApiKey(cfg) {
  if (cfg.agent.apiKey) return cfg.agent.apiKey;
  const envName = cfg.agent.apiKeyEnv || 'DEEPSEEK_API_KEY';
  return process.env[envName] || '';
}

/** 配置体检：返回 { errors, warnings } */
export function validateConfig(cfg) {
  const errors = [];
  const warnings = [];
  const t = cfg.behavior.trigger;

  if (!cfg.agent.model) errors.push('agent.model 为空');
  if (!/^https?:\/\//.test(cfg.agent.baseUrl)) errors.push(`agent.baseUrl 不是合法 URL：${cfg.agent.baseUrl}`);
  const usesDsh = cfg.agent.backend === 'dsh' || cfg.agent.backend === 'auto';
  if (!resolveApiKey(cfg)) {
    if (usesDsh) {
      warnings.push(
        `没设置 ${cfg.agent.apiKeyEnv}：dsh 后端会用 DSH 自己的登录态，若也没登录则会报 MISSING_CREDENTIAL`,
      );
    } else {
      errors.push(`缺少 API key：请在环境变量 ${cfg.agent.apiKeyEnv} 或 agent.apiKey 中设置`);
    }
  }
  const TONES = ['neutral', 'concise', 'witty', 'warm', 'formal'];
  if (!TONES.includes(cfg.agent.tone)) errors.push(`agent.tone 只能是 ${TONES.join('/')}，当前为 ${cfg.agent.tone}`);
  if (!Array.isArray(t.keywords)) errors.push('behavior.trigger.keywords 必须是数组');
  if (!Array.isArray(t.whitelistGroups)) errors.push('behavior.trigger.whitelistGroups 必须是数组');
  if (t.whitelistReplyProbability < 0 || t.whitelistReplyProbability > 1) {
    errors.push('whitelistReplyProbability 必须在 0–1 之间');
  }
  const pr = cfg.behavior.proactive || {};
  if (pr.enabled) {
    if (pr.maxIntervalMinutes <= pr.minIntervalMinutes) errors.push('proactive.maxIntervalMinutes 必须大于 minIntervalMinutes');
    if (pr.idleMinutes < 5) warnings.push('proactive.idleMinutes 太短，容易在别人聊到一半时插嘴');
  }
  const noTrigger = !t.mentions && (t.keywords || []).length === 0 && (t.whitelistGroups || []).length === 0;
  if (noTrigger) warnings.push('没有任何触发条件（mentions/keywords/whitelistGroups 都为空），机器人永远不会说话');
  if (cfg.agent.temperature > 1.5) warnings.push('temperature 偏高，群聊容易跑偏');
  if (!cfg.agent.personaFile) warnings.push('未配置 personaFile，将使用内置默认人设');
  if (!['api', 'dsh', 'auto'].includes(cfg.agent.backend)) {
    errors.push(`agent.backend 只能是 api / dsh / auto，当前为 ${cfg.agent.backend}`);
  }
  if (cfg.agent.backend === 'dsh' || cfg.agent.backend === 'auto') {
    if (process.platform !== 'darwin') warnings.push('dsh 后端目前只在 macOS 上验证过');
  }
  if (cfg.channel.type === 'wechaty' && !process.env[cfg.channel.wechaty?.tokenEnv || 'WECHATY_PUPPET_PADLOCAL_TOKEN']) {
    warnings.push(`通道为 wechaty，但环境变量 ${cfg.channel.wechaty?.tokenEnv || 'WECHATY_PUPPET_PADLOCAL_TOKEN'} 未设置`);
  }
  return { errors, warnings };
}
