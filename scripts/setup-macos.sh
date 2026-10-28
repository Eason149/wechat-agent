#!/bin/sh
# 一次性准备 macOS 通道的 Python 环境（pyobjc：截屏、OCR、模拟键盘）
set -e
cd "$(dirname "$0")/.."

if [ ! -x .tools/venv/bin/python ]; then
  echo "→ 创建虚拟环境"
  /usr/bin/python3 -m venv .tools/venv
fi

echo "→ 安装 pyobjc（Vision / Quartz / ApplicationServices / Cocoa）"
./.tools/venv/bin/python -m pip install --upgrade pip >/dev/null
./.tools/venv/bin/python -m pip install pyobjc-framework-Vision pyobjc-framework-Quartz \
  pyobjc-framework-ApplicationServices pyobjc-framework-Cocoa

echo "→ 体检"
./.tools/venv/bin/python scripts/mac/wechat_helper.py probe
