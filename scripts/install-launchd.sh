#!/bin/sh
# 把当前目录注册成开机自启服务（macOS launchd）
set -e
PROJECT_DIR=$(cd "$(dirname "$0")/.." && pwd)
PLIST="$HOME/Library/LaunchAgents/com.local.wechat-agent.plist"

mkdir -p "$PROJECT_DIR/data" "$HOME/Library/LaunchAgents"
sed "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
  "$PROJECT_DIR/scripts/com.local.wechat-agent.plist.template" > "$PLIST"

launchctl bootout "gui/$(id -u)/com.local.wechat-agent" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "已安装并启动：$PLIST"
echo "日志：tail -f $PROJECT_DIR/data/agent-\$(date +%F).log"
