#!/usr/bin/env node
// 模拟 `dsh --profile headless --json` 的输出协议，用于测试 spawn/解析逻辑
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.2.1-rc.2');
  process.exit(0);
}
const sidIdx = args.indexOf('--session-id');
const resumed = sidIdx >= 0 ? args[sidIdx + 1] : null;
const task = args.at(-1) || '';
const sid = resumed || 'session-fake-0001';

console.log(JSON.stringify({ type: 'session', sessionId: sid, cwd: process.cwd() }));
console.log(JSON.stringify({ type: 'status', phase: 'turn_start', turn: 1 }));
console.log(JSON.stringify({ type: 'final', text: resumed ? `续接会话，收到：${task.slice(0, 20)}` : '第一句回复' }));
