#!/bin/sh
# 一条命令启动：装依赖（首次）→ 生成配置（首次）→ 跑起来 → 自动打开控制台
set -e
cd "$(dirname "$0")"

# 优先用仓库自带的 Node（没有全局安装也能跑）
if [ -x ./.tools/node/bin/node ]; then
  PATH="$PWD/.tools/node/bin:$PATH"
  export PATH
fi

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 20.11 或更高版本：https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "当前 Node $(node -v) 太旧，需要 >= 20.11"
  exit 1
fi

[ -f config.json ] || node src/cli.mjs init

# 核心功能零依赖；只有 Wechaty 通道需要 node_modules
if [ "${1:-}" = "--with-wechaty" ] && [ ! -d node_modules ]; then
  echo "安装 Wechaty 依赖…"
  npm install --no-audit --no-fund
  shift
fi

exec node src/cli.mjs run "$@"
