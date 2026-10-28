#!/bin/sh
# 前台启动，自动加载 secrets.env
set -e
cd "$(dirname "$0")/.."
if [ -f ./secrets.env ]; then
  set -a
  . ./secrets.env
  set +a
fi
if [ -x ./.tools/node/bin/node ]; then
  NODE=./.tools/node/bin/node
else
  NODE=node
fi
exec "$NODE" src/cli.mjs run "$@"
