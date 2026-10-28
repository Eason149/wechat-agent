#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { copyFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig, resolveApiKey } from './config.mjs';
import { createLogger, redact } from './log.mjs';
import { ChatStore } from './store.mjs';
import { Bridge } from './bridge.mjs';
import { chatCompletion } from './llm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HELP = `
wechat-agent — 把 AI 接进微信群

用法：
  node src/cli.mjs <command> [options]

命令：
  init                生成 config.json（已存在则不覆盖）
  set k=v [k=v ...]   改配置，如 set agent.backend=dsh channel.type=wechaty
  doctor [--ping]     检查配置、密钥、模型连通性
  chat                本地模拟群聊（不连微信，先验证人设）
  run                 启动真实通道（按 config.json 的 channel.type）
  macos probe         体检：微信窗口 + 辅助功能/屏幕录制权限
  macos read          读一次当前聊天，看能认出什么
  macos send <文本>   往当前聊天发一条（试手用）

选项：
  --config <path>     指定配置文件（默认 ./config.json）
  --log-level <lvl>   debug | info | warn | error
  --no-color          关闭彩色输出

环境变量：
  DEEPSEEK_API_KEY              模型密钥（可在 config.json 的 agent.apiKeyEnv 改名）
  WECHATY_PUPPET_PADLOCAL_TOKEN wechaty puppet token（通道选 wechaty 时）
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', default: 'config.json' },
      'log-level': { type: 'string', default: 'info' },
      ping: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const cmd = positionals[0];
  if (!cmd || values.help) {
    console.log(HELP);
    process.exit(0);
  }

  switch (cmd) {
    case 'init':
      return cmdInit(values.config);
    case 'set':
      return cmdSet(values.config, positionals.slice(1));
    case 'doctor':
      return cmdDoctor(values.config, values.ping);
    case 'chat':
      return cmdRun(values.config, values['log-level'], 'mock');
    case 'run':
      return cmdRun(values.config, values['log-level']);
    case 'macos':
      return cmdMacos(values.config, positionals[1] || 'probe', positionals.slice(2));
    default:
      console.error(`未知命令：${cmd}\n${HELP}`);
      process.exit(1);
  }
}

async function cmdInit(configPath) {
  const target = path.resolve(configPath);
  const example = path.join(ROOT, 'config.example.json');
  try {
    await access(target);
    console.log(`配置已存在，未覆盖：${target}`);
  } catch {
    await copyFile(example, target);
    console.log(`已生成配置：${target}`);
  }
  await mkdir(path.join(ROOT, 'data'), { recursive: true });
  console.log(`
下一步：
  1. 把模型密钥放进环境变量：export DEEPSEEK_API_KEY=sk-...
  2. 检查：node src/cli.mjs doctor --ping
  3. 本地试聊：node src/cli.mjs chat
  4. 接微信：改 config.json 的 channel.type，然后 node src/cli.mjs run
`);
}

async function cmdSet(configPath, pairs) {
  if (!pairs.length) {
    console.error('用法：node src/cli.mjs set agent.backend=dsh channel.type=wechaty');
    process.exit(1);
  }
  const { readFile, writeFile } = await import('node:fs/promises');
  const target = path.resolve(configPath);
  const cfg = JSON.parse(await readFile(target, 'utf8'));
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) {
      console.error(`跳过（缺少 =）：${pair}`);
      continue;
    }
    const keyPath = pair.slice(0, idx).split('.');
    const raw = pair.slice(idx + 1);
    let value = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // 不是 JSON 就按字符串处理
    }
    let cursor = cfg;
    for (const key of keyPath.slice(0, -1)) {
      if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[keyPath.at(-1)] = value;
    console.log(`  ${pair}`);
  }
  await writeFile(target, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log(`已写入 ${target}`);
}

async function cmdDoctor(configPath, ping) {
  const cfg = await loadConfig(configPath);
  const { errors, warnings } = validateConfig(cfg);
  const key = resolveApiKey(cfg);

  console.log('配置');
  console.log(`  文件        ${cfg.configPath}`);
  console.log(`  模型        ${cfg.agent.model} @ ${cfg.agent.baseUrl}`);
  console.log(`  密钥        ${key ? `已设置（${key.slice(0, 4)}…${key.slice(-4)}）` : '未设置'}`);
  console.log(`  控制台      ${cfg.panel?.enabled === false ? '关闭' : `http://127.0.0.1:${cfg.panel?.port ?? 7788}`}`);
  console.log(`  后端        ${cfg.agent.backend}${cfg.agent.backend === 'auto' ? '（@它时用 dsh，其余直连模型）' : ''}`);
  console.log(`  通道        ${cfg.channel.type}`);
  console.log(`  数据目录    ${cfg.storage.dir}`);
  console.log(`  触发条件    ${describeTriggers(cfg)}`);
  console.log(`  限流        冷却 ${cfg.behavior.limits.perGroupCooldownMs}ms，${cfg.behavior.limits.maxRepliesPerMinute}/分，${cfg.behavior.limits.maxRepliesPerHour}/时`);
  console.log(`  Node        ${process.version}`);

  for (const w of warnings) console.log(`  ⚠️  ${w}`);
  for (const e of errors) console.log(`  ❌  ${e}`);

  if (errors.length) {
    console.log('\n体检未通过。');
    process.exitCode = 1;
    return;
  }

  if (cfg.agent.backend === 'dsh' || cfg.agent.backend === 'auto') {
    const { createsDshBackend } = await import('./backends/dsh.mjs');
    const dsh = createsDshBackend({ cfg, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    process.stdout.write('\n检查 dsh 后端… ');
    const probe = await dsh.probe();
    console.log(probe.ok ? `✅ ${probe.version || '可用'}` : `❌ ${probe.error}`);
    if (!probe.ok) process.exitCode = 1;
  }

  if (ping) {
    process.stdout.write('\n测试模型连通性… ');
    const started = Date.now();
    try {
      const res = await chatCompletion({
        cfg: { ...cfg, agent: { ...cfg.agent, maxTokens: 32, temperature: 0 } },
        messages: [
          { role: 'system', content: '只回复两个字：在线' },
          { role: 'user', content: 'ping' },
        ],
      });
      console.log(`✅ ${Date.now() - started}ms，返回：${res.text.replace(/\s+/g, ' ').slice(0, 40)}`);
    } catch (err) {
      console.log(`❌ ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log('\n体检通过。');
  if (warnings.length) console.log(redact({ hint: '警告不影响运行' }));
}

function describeTriggers(cfg) {
  const t = cfg.behavior.trigger;
  const bits = [];
  if (t.mentions) bits.push('@提及');
  if (t.keywords?.length) bits.push(`关键词(${t.keywords.join('/')})`);
  if (t.whitelistGroups?.length) bits.push(`白名单(${t.whitelistGroups.length} 个群, 概率 ${t.whitelistReplyProbability})`);
  return bits.join('，') || '无';
}

async function cmdRun(configPath, logLevel, forceChannel) {
  const cfg = await loadConfig(configPath);
  const { errors, warnings } = validateConfig(cfg);
  if (forceChannel) cfg.channel.type = forceChannel;
  // 没有 key 不算致命：控制台就是用来填 key 的，先起来再说
  const deferred = errors.filter((e) => /缺少 API key/.test(e));
  const fatal = errors.filter((e) => !deferred.includes(e));
  if (fatal.length) {
    console.error('配置有问题：\n  - ' + fatal.join('\n  - '));
    process.exit(1);
  }
  for (const w of warnings) console.warn(`⚠️  ${w}`);
  for (const d of deferred) console.warn(`⚠️  ${d}（可以在控制台里填）`);

  const logger = createLogger({ dir: cfg.storage.dir, level: logLevel });
  const store = new ChatStore(cfg.storage.dir, logger);
  let adapter;
  try {
    const { createAdapter } = await import('./adapters/index.mjs');
    adapter = await createAdapter(cfg, logger);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
  const backends = await createBackends(cfg, logger);
  const bridge = new Bridge({ cfg, store, adapter, logger, backends });

  let panel = null;
  const shutdown = async (sig) => {
    logger.info(`收到 ${sig}，正在退出…`);
    try {
      await panel?.close?.();
      await bridge.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error('未处理的 Promise 拒绝', err?.stack || String(err)));

  await bridge.start();

  if (cfg.panel?.enabled !== false) {
    try {
      const { startPanel } = await import('./panel/server.mjs');
      panel = await startPanel({
        cfg,
        bridge,
        store,
        logger,
        port: cfg.panel.port ?? 7788,
      });
      console.log(`\n🖥  控制台：${panel.url}\n`);
    } catch (err) {
      logger.warn(`控制台启动失败（端口被占用？）：${err.message}`);
    }
  }

  logger.info(`运行中。指标：${JSON.stringify(bridge.metrics)}`);
}

async function cmdMacos(configPath, sub, args) {
  const cfg = await loadConfig(configPath);
  const m = cfg.channel.macos || {};
  const { spawn } = await import('node:child_process');
  const path = await import('node:path');
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(moduleDir, '..');
  const python = m.python || path.join(root, '.tools/venv/bin/python');
  const helper = m.helper || path.join(root, 'scripts/mac/wechat_helper.py');

  const table = { probe: ['probe'], read: ['read', '--mode', m.readMode === 'clipboard' ? 'ax' : 'ocr'], send: ['send', '--text', args.join(' ')] };
  const argv = table[sub];
  if (!argv) {
    console.error(`未知子命令：macos ${sub}（可用：probe / read / send）`);
    process.exit(1);
  }

  const child = spawn(python, [helper, ...argv], { stdio: 'inherit' });
  child.on('close', async (code) => {
    process.exitCode = code ?? 0;
    if (sub === 'probe') {
      const { createMacosAdapter } = await import('./adapters/macos.mjs');
      const adapter = createMacosAdapter({ cfg, logger: { info() {}, warn() {}, debug() {} } });
      const p = await adapter.probe().catch((e) => ({ ok: false, error: e.message, missing: [] }));
      if (!p.ok) {
        console.error('\n' + (await import('./adapters/macos.mjs')).explainMissing(p));
        process.exitCode = 1;
      }
    }
  });
}

async function createBackends(cfg, logger) {
  const { createApiBackend } = await import('./backends/api.mjs');
  const backends = { api: createApiBackend() };
  const mode = cfg.agent.backend || 'api';
  if (mode === 'dsh' || mode === 'auto') {
    const { createsDshBackend } = await import('./backends/dsh.mjs');
    backends.dsh = createsDshBackend({ cfg, logger });
  }
  return backends;
}

main().catch((err) => {
  console.error(err?.stack || err.message || String(err));
  process.exit(1);
});
