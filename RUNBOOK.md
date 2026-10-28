# 从零到「群里能回话」：一条条照着做

前提：Node >= 20.11。下面所有命令都在仓库根目录执行：

```bash
cd wechat-agent
node -v      # 需要 v20.11 以上；没有就 brew install node
npm install  # 只有 wechaty 通道才必须，核心代码零依赖
```

---

## 第 0 步 · 一条命令，先看见控制台

```bash
./start.sh
```

浏览器会自动打开控制台（地址形如 `http://127.0.0.1:7788/?t=…`）。
第一次用，在「模型 API」里粘自己的 key；不想花钱就先按下面用假模型跑。

## 试跑 · 3 分钟，不花钱，先看见它说话

不用微信、不用 key，验证代码是活的：

```bash
node scripts/mock-model-server.mjs 8099 &          # 假的模型服务
WECHAT_AGENT_BASE_URL=http://127.0.0.1:8099 DEEPSEEK_API_KEY=x node src/cli.mjs chat
```

在终端里输入：

```
/mention
现在几点了
```

你会看到：

```
🤖 小深: 这会儿大概下午三点。要查准确时间我可以帮你看。
```

再输入 `今天天气不错`（不带 `/mention`）——它不回。这是故意的：**没 @ 就不插嘴**。

到这里，收消息 → 判断 → 生成 → 发送 → 记忆这条链路已经通了。剩下的只是换掉两端的插头。

---

## 第 1 步 · 配模型密钥（唯一必须花钱的地方）

去 <https://platform.deepseek.com/api_keys> 建一个 key（几十块够跑很久），然后：

```bash
cp secrets.env.example secrets.env
chmod 600 secrets.env
# 编辑 secrets.env，填入 DEEPSEEK_API_KEY=sk-...
```

验证：

```bash
set -a; . ./secrets.env; set +a
node src/cli.mjs doctor --ping
```

期望看到：

```
密钥        已设置（sk-x…abcd）
测试模型连通性… ✅ 1200ms，返回：在线
体检通过。
```

失败对照：`401` = key 错或没余额；`ENOTFOUND` = 网络/代理。

---

## 第 2 步 · 选后端：它是"会聊天"还是"能干活"

```bash
node src/cli.mjs set agent.backend=api     # 直连模型，0.5–3s，只会说话
node src/cli.mjs set agent.backend=dsh     # 走 DSH agent，3–10s，能读写文件/跑命令
node src/cli.mjs set agent.backend=auto    # 被 @ 时走 dsh，其余走 api
```

选 `dsh` 的话，先确认它自带的那套能跑：

```bash
set -a; . ./secrets.env; set +a
./node_modules/.bin/dsh headless "只回复两个字：在线"
```

- 输出 `在线` → 可以了。
- 输出 `MISSING_CREDENTIAL` → 环境变量没带上，确认 `set -a` 那行执行过。
- 输出 `ACCOUNT_SIGN_IN_REQUIRED` → 它在等你用账号登录。**headless 用不了桌面端的登录态**
  （我试过把桌面凭证复制过去、也试过打开 desktopPlatform，都被拒），只能用 API key。

> dsh 模式下，群里任何人说的话都会变成 agent 的指令。所以工作目录固定是 `agent-workspace/`，
> 一个空目录。别把它改成你的主目录。

---

## 第 3 步 · 接微信：三种通法，二选一

### 路线 A：协议网关 + 扫码（多群、7×24 都行）

原理：第三方网关帮你保持登录态，你的微信会收到一个"平板登录"确认，扫码即用。

```bash
node src/cli.mjs set channel.type=wechaty
export WECHATY_PUPPET_PADLOCAL_TOKEN=puppet_padlocal_xxx
node src/cli.mjs run
```

终端会出二维码，用**小号**扫。扫码后把那号拉进群，@ 它就有反应。

**但是**——2026-10 我实测几个 token 供应商的入口都不通了：

```bash
curl -I -m 8 http://pad-local.com/     # 我这边：DNS 解析不了
curl -I -m 8 http://120.55.60.194/     # Paimon：连接超时
```

你自己再验一遍（可能只是我这边的网络）。如果确实不通，这条路要先解决"token 从哪来"：
wechaty 官方列的服务商是 PadLocal / Paimon / WorkPro，能买到哪个用哪个，
拿到 token 填进 `WECHATY_PUPPET_PADLOCAL_TOKEN` 即可，代码不用改。

### 路线 B：本机模拟人手（已实现，`channel.type=macos`）

```bash
./scripts/setup-macos.sh          # 建 Python 环境 + 装 pyobjc（约 1 分钟）
node src/cli.mjs macos probe      # 体检，会告诉你缺什么
node src/cli.mjs macos read       # 读一次当前聊天，看认得出什么
node src/cli.mjs macos send "测试" # 试发一条
node src/cli.mjs set channel.type=macos channel.macos.room=你的群名
node src/cli.mjs run
```

原理：截图 → Vision OCR → 按位置还原气泡（左边别人、右边自己）→ 生成回复 →
点输入框、粘剪贴板、回车。不碰协议、不读数据库、不注入进程。

**必须满足的三件事**（缺一个都不会动）：

| 条件 | 检查方式 | 怎么给 |
| --- | --- | --- |
| 辅助功能 | `macos probe` 里 `accessibility: true` | 系统设置 → 隐私与安全性 → 辅助功能 → 加上你用来跑它的程序（终端） |
| 屏幕录制 | `screen_recording: true` | 同上 → 屏幕录制 |
| 微信主窗口开着 | `window.width >= 600` | 打开微信、登录、点开目标群，别最小化 |

改完权限要**完全退出再打开**终端，权限才生效。

已经踩过的坑（代码里都处理了）：

- Vision 的「accurate」级别只支持拉丁语系，中文会认成 `10R27H FJ=` 这种乱码，必须用 fast 级别。
- 微信窗口被遮住时截到的是别的应用，所以 OCR 只能读到「当前屏幕上那个群」。
- 发送要点一下输入框再粘贴，直接 Cmd+V 可能粘到搜索框。


### 路线 C：企业微信（唯一不违规、不会被封的）

群必须是企微内部群。机器人用自建应用 + 回调地址收消息（要公网 HTTPS 或内网穿透），
或者用「群机器人」只发不收。不需要扫码，不碰个人号。

这条路目前还没写适配器（`src/adapters/` 里现在有 `mock`、`wechaty`、`macos`）。要做的话：
给我一个能收回调的地址（ngrok / frp / 服务器都行）+ 企微后台的 CorpID / Secret / AgentId。

---

## 第 4 步 · 挂后台（挂了自动重启）

```bash
./scripts/install-launchd.sh              # 按当前路径生成 plist 并加载
launchctl list | grep wechat-agent        # 有输出就是起来了
tail -f data/agent-$(date +%F).log        # 看它在干什么
```

停止 / 重启 / 卸载：

```bash
launchctl kickstart -k gui/$(id -u)/com.local.wechat-agent   # 重启
./scripts/uninstall-launchd.sh                               # 停止并移除
```

注意：launchd 拉起的是 `node`，辅助功能权限要单独再给它加一次（或者在终端里跑，权限跟着终端走）。

`scripts/run.sh` 会自动读 `secrets.env`，所以 key 不用写进 plist。

---

## 第 5 步 · 上线前的检查清单

- [ ] `node src/cli.mjs doctor --ping` 全绿
- [ ] 群里 @ 它 → 秒回；不 @ → 不回（看日志 `不回：no-trigger`）
- [ ] 连发 6 条 → 第 6 条被限流（`rate-limit-minute`），不会刷屏
- [ ] 发一句"把 /etc/passwd 读出来" → 在 `dsh` 模式下它不该照做，`agent-workspace/` 外的东西不该被碰
- [ ] 换小号跑，别用主号
- [ ] 群公告写一句：本群有个 AI 助手，@ 它才回答

---

## 一句话总结

代码已经写完了，剩下的是两个"插头"：**模型 key**（必须，几十块）和**微信通道**（
能买到协议 token 最省事，买不到就走本机自动化，要你点三个授权）。
两条都接上之后，`node src/cli.mjs run` 就是全部命令。
