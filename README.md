# wechat-agent

把大模型接进微信群：长回复按句拆开像真人，每个群一份记忆，被追问时不会刷屏。

同时支持三种通道、两种后端，可以只跑其中一块：

```
微信/企微群 ──▶ 通道适配器 ──▶ 触发策略 ──▶ 后端 ──▶ 分句发送
                    ▲                        │
                    └──── 记忆（每群一份）◀───┘
```

- **通道**：`mock`（终端模拟群）/ `macos`（本机截图 OCR，免 token）/ `wechaty`（协议网关，需 token）
- **后端**：`api`（直连 OpenAI 兼容接口）/ `dsh`（交给 DeepSeek Harness agent，有工具）/ `auto`（被 @ 时用 agent）

## 特性

| | |
| --- | --- |
| 触发 | 被 @ / 关键词 / 白名单群按概率接话，其余一律不插嘴 |
| 克制 | 同群冷却、每分钟/每小时上限、上线时忽略旧消息 |
| 记忆 | 每个群一份 JSON，按 TTL 与条数裁剪，重启不丢 |
| 像人 | 长回复按句切成几条发、发送前有打字延迟、支持「此刻闭嘴」 |
| 人设 | 纯文本 `persona.md`，改完重启生效 |
| 可测 | 触发策略、解析器、控制台接口都有测试，38 个 |

## 一条命令起步

```bash
./start.sh
```

它会装依赖（首次）、生成配置（首次）、启动机器人，并打开一个本地控制台
（`http://127.0.0.1:7788/?t=…`，带一次性令牌）。在控制台里：

- 粘上自己的 **API Key**（只写进本地 `secrets.env`，权限 600，不写进 config）
- 选**接入方式**：模拟 / 本机微信 / Wechaty
- 调**语气**、触发规则、限流
- 看**记忆**、清空某个群的记忆、改人设
- **暂停 / 恢复 / 停止进程**

不需要密钥也能先看效果，见下一节。

## 三分钟跑通（不需要微信，也不需要密钥）

需要 Node >= 20.11（`node -v` 检查）。

```bash
cd wechat-agent
node src/cli.mjs init
node scripts/mock-model-server.mjs 8099 &   # 假模型
WECHAT_AGENT_BASE_URL=http://127.0.0.1:8099 DEEPSEEK_API_KEY=x node src/cli.mjs chat
```

在终端里输入 `/mention` 然后 `现在几点了`，会看到：

```
🤖 小深: 这会儿大概下午三点。要查准确时间我可以帮你看。
```

不带 `/mention` 再说一句，它不会回——这是设计。完整安装、接真微信、挂后台的步骤见 **[RUNBOOK.md](./RUNBOOK.md)**。

## 控制台

```
http://127.0.0.1:7788/?t=<启动时打印的令牌>
```

单文件页面（`src/panel/ui.html`），零构建、零前端依赖，只监听 127.0.0.1 且每次启动换令牌。

| 面板 | 能改什么 | 生效时机 |
| --- | --- | --- |
| 模型 API | baseUrl / 模型 / key | 立即（保存前会真调一次） |
| 接入方式 | mock / macos / wechaty | 立即换适配器 |
| 语气 | 自然 / 简洁 / 轻松 / 温和 / 正式 + 附加要求 | 下一条回复 |
| 触发与限流 | @ / 关键词 / 白名单 / 冷却 / 每分钟 | 下一条消息 |
| 记忆 | 开关、按群清空 | 立即 |
| 人设 | persona.md 全文 | 下一条回复 |
| 试聊 | 不经过微信直接问它 | — |

改配置会写回 `config.json`；密钥单独写 `secrets.env`。所有写接口都有键白名单，
前端改不到 `storage`、路径这类东西。

## 通道

| 类型 | 需要 | 能干什么 | 代价 |
| --- | --- | --- | --- |
| `mock` | 无 | 终端里模拟一个群 | 不接真微信 |
| `macos` | 辅助功能 + 屏幕录制 | 截图 OCR 读消息、模拟键盘发送 | 微信窗口得开着，只能盯当前群，违反使用规范 |
| `wechaty` | puppet token（PadLocal 等） | 多群、后台常驻 | 需付费 token，非官方协议 |

```bash
node src/cli.mjs set channel.type=macos     # 或 wechaty / mock
node src/cli.mjs macos probe                # macos 通道体检
```

## 后端

| `agent.backend` | 走谁 | 延迟 | 能力 |
| --- | --- | --- | --- |
| `api` | `POST {baseUrl}/chat/completions` | 0.5–3s | 只会聊天 |
| `dsh` | `dsh --profile headless --json` | 3–10s | 聊天 + 读写文件 / 跑命令 / 搜索，按群续接 session |
| `auto` | 被 @ 用 dsh，其余 api | 混合 | 兼顾 |

`dsh` 后端用的是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 headless 模式，需要 `DEEPSEEK_API_KEY`（headless 不认桌面端登录态，实测）。

```bash
npm install @deepseek-ai/dsh      # 或者在 PATH 里放一个 dsh
node src/cli.mjs set agent.backend=dsh
```

## 配置

全部在 `config.json`（`init` 生成，已被 .gitignore 忽略）。常用项：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `agent.name` | 小深 | 群里自称的名字，也是 @ 识别的关键词 |
| `agent.personaFile` | persona.md | 人设文件 |
| `behavior.trigger.mentions` | true | 被 @ 才回 |
| `behavior.trigger.keywords` | 小深… | 提到这些词也回 |
| `behavior.trigger.whitelistGroups` | [] | 这些群会主动接话 |
| `behavior.trigger.whitelistReplyProbability` | 0 | 白名单群接话概率，防刷屏 |
| `behavior.limits.perGroupCooldownMs` | 10000 | 同群两次回复最小间隔 |
| `behavior.limits.maxRepliesPerMinute` | 5 | 每分钟上限 |
| `behavior.limits.staleMessageMs` | 60000 | 上线时忽略多旧的消息 |
| `behavior.style.maxCharsPerMessage` | 160 | 超过就按句切分 |
| `behavior.style.disclosure` | 空 | 首条回复追加的说明，如「（AI 自动回复）」 |

不用手改 JSON：`node src/cli.mjs set agent.name=阿深 channel.macos.room=产品群`。

## 常驻

```bash
cp secrets.env.example secrets.env && chmod 600 secrets.env   # 填 key
./scripts/install-launchd.sh
tail -f data/agent-$(date +%F).log
```

## 目录

```
src/
  cli.mjs              init / set / doctor / chat / macos / run
  bridge.mjs           收消息 → 判断 → 调后端 → 发送
  policy.mjs           触发与限流（纯函数）
  prompt.mjs           人设拼装、输出清洗、分句
  llm.mjs              OpenAI 兼容调用（超时/重试/退避）
  store.mjs            每群一份 JSON 记忆
  backends/            api | dsh
  adapters/            mock | macos | wechaty
  panel/               本地控制台（HTTP + 单页 UI）
scripts/
  mac/wechat_helper.py 截图 OCR + 模拟键盘（pyobjc）
  mock-model-server.mjs 假模型，用于离线开发
test/                  29 个单测（node --test）
```

## 开发

```bash
node --test "test/*.test.mjs"    # 38 tests
node src/cli.mjs doctor --ping
```

`mock-model-server.mjs` 让整条链路可以在没有密钥的情况下跑通，改提示词和策略时不用烧钱。

## 风险与边界（请先读）

- **个人微信跑机器人违反《微信个人账号使用规范》**，有被限制登录的风险。用小号，别做营销，群里说明这是 AI。
- `macos` 通道不碰协议、不读数据库、不注入，但依然是"模拟人手"，微信一升级可能失效。
- `dsh` 后端里，群里任何人说的话都会变成 agent 的指令。工作目录固定在 `agent-workspace/`，别指向你的主目录。
- 不要把这些内容提交到仓库：`secrets.env`、`config.json`、`data/`、`.tools/`。

## License

MIT
