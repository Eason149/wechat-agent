#!/bin/sh
# 双击这个文件即可启动（不用记命令）
cd "$(dirname "$0")"

if [ -x ./.tools/node/bin/node ]; then
  NODE=./.tools/node/bin/node
else
  NODE=node
fi

[ -f config.json ] || "$NODE" src/cli.mjs init

echo "正在启动 wechat-agent…控制台地址会打印在下面，浏览器会自动打开。"
echo "关掉这个窗口 = 停止服务（也可以按 Ctrl+C）。"
echo

"$NODE" src/cli.mjs run

echo
echo "服务已停止。按回车关闭窗口。"
read _
