import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, diffNew, messageKey } from '../src/adapters/macos/transcript.mjs';

test('解析「昵称 时间 + 多行内容」格式', () => {
  const raw = `张三 2026-10-27 17:20
今天开会吗
线上还是线下

李四 2026-10-27 17:21
线上吧
我这边能连；
`;
  const msgs = parseTranscript(raw);
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], { sender: '张三', time: '2026-10-27 17:20', text: '今天开会吗\n线上还是线下' });
  assert.equal(msgs[1].sender, '李四');
  assert.match(msgs[1].text, /线上吧/);
});

test('解析「昵称：内容」单行格式', () => {
  const msgs = parseTranscript('张三：收到\n李四: 好的');
  assert.deepEqual(
    msgs.map((m) => [m.sender, m.text]),
    [
      ['张三', '收到'],
      ['李四', '好的'],
    ],
  );
});

test('解析「昵称 时间：内容」同行格式', () => {
  const msgs = parseTranscript('张三 2026-10-27 17:20：直接说结果');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].sender, '张三');
  assert.equal(msgs[0].text, '直接说结果');
});

test('过滤系统提示与空行', () => {
  const raw = `张三 2026-10-27 17:20
你撤回了一条消息

李四 2026-10-27 17:21
王五加入了群聊

张三 2026-10-27 17:22
  晚上吃什么`;
  const msgs = parseTranscript(raw);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, '晚上吃什么');
});

test('空输入返回空数组', () => {
  assert.deepEqual(parseTranscript(''), []);
  assert.deepEqual(parseTranscript(null), []);
  assert.deepEqual(parseTranscript('   \n\n  '), []);
});

test('diffNew：追加新消息时只返回新增部分', () => {
  const a = [{ sender: '张三', time: 't1', text: '一' }];
  const b = [...a, { sender: '李四', time: 't2', text: '二' }];
  assert.deepEqual(diffNew(a, b), [b[1]]);
});

test('diffNew：内容滚动时按重叠对齐', () => {
  const prev = [
    { sender: '张三', time: 't1', text: '一' },
    { sender: '李四', time: 't2', text: '二' },
  ];
  const curr = [
    { sender: '李四', time: 't2', text: '二' },
    { sender: '王五', time: 't3', text: '三' },
  ];
  assert.deepEqual(diffNew(prev, curr).map(messageKey), ['王五|t3|三']);
});

test('diffNew：完全不同时只取最后一条，避免刷屏', () => {
  const prev = [{ sender: 'A', time: 't1', text: '旧' }];
  const curr = [
    { sender: 'B', time: 't9', text: '新一' },
    { sender: 'C', time: 't10', text: '新二' },
  ];
  assert.deepEqual(diffNew(prev, curr).map((m) => m.text), ['新二']);
});

test('diffNew：首次为空则全部算新', () => {
  const curr = [{ sender: 'A', time: 't1', text: '一' }];
  assert.deepEqual(diffNew([], curr), curr);
});
