#!/bin/sh
set -e
PLIST="$HOME/Library/LaunchAgents/com.local.wechat-agent.plist"
launchctl bootout "gui/$(id -u)/com.local.wechat-agent" 2>/dev/null || true
rm -f "$PLIST"
echo "已停止并移除 launchd 服务"
