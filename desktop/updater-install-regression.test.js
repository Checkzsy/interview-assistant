'use strict';

// 防回归测试（regression guard），不 require electron。
//
// 覆盖两处更新流程回归：
//  1. onApplyAndQuit 回调必须在同步入口置位 isQuitting。历史缺陷把它写在
//     gracefulStopPython().then(...) 的微任务里，而后端进程退出时 ChildProcess
//     先同步 emit 'exit' 再 emit 'close'，微任务尚未执行，导致 'close' 处理器读到
//     isQuitting === false，误报「后台服务已停止」对话框。
//  2. 后端退出告警不得把猜测（端口占用）当结论，也不得泄漏端口号/退出码等内部细节。
//
// 测试方式：以纯文本读取 desktop/main.js，配对括号抽取目标函数体后断言。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// 抽取从 marker 之后第一个 '{' 起、配对到闭合括号为止的函数体。
function extractBracedBody(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `main.js 中未找到 ${marker}`);
  assert.strictEqual(
    source.split(marker).length - 1,
    1,
    `${marker} 在 main.js 中必须唯一，否则本测试可能抽取到错误的位置`,
  );

  const open = source.indexOf('{', start);
  assert.ok(open !== -1, `${marker} 缺少函数体`);

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`${marker} 函数体括号不匹配`);
}

test('onApplyAndQuit 在同步入口置位 isQuitting，早于 gracefulStopPython', () => {
  const body = extractBracedBody(MAIN_SOURCE, 'controller.onApplyAndQuit(');

  const assignIndex = body.indexOf('isQuitting = true');
  const stopIndex = body.indexOf('gracefulStopPython(');

  assert.ok(assignIndex !== -1, 'onApplyAndQuit 回调必须置位 isQuitting');
  assert.ok(stopIndex !== -1, 'onApplyAndQuit 回调应调用 gracefulStopPython');
  assert.ok(
    assignIndex < stopIndex,
    'isQuitting = true 必须在 gracefulStopPython 之前的同步入口执行，' +
      '否则后端退出时 close 处理器会误报退出告警',
  );
});

test('后端退出告警不暴露端口号/退出码，也不把猜测当结论', () => {
  const body = extractBracedBody(MAIN_SOURCE, "if (!isQuitting) {");

  const dialogIndex = body.indexOf('showErrorBox');
  assert.ok(dialogIndex !== -1, '后端退出分支应保留告警对话框');

  const call = body.slice(dialogIndex);
  assert.doesNotMatch(call, /端口/, '告警文案不应提及端口（会误导用户去处理不存在的冲突）');
  assert.doesNotMatch(call, /code \$\{/, '告警文案不应暴露进程退出码');
  assert.doesNotMatch(call, /Python/, '面向用户的告警不应暴露实现语言');
});
