'use strict';

// 防回归测试（regression guard），不 require electron。
//
// 目的：防止「截图审题」快捷键丢失用户可见反馈。
//   历史缺陷（askFromServerScreen）：该 callback 只在成功时静默 postBackend，
//   失败时仅 console.error，用户按下快捷键后无任何可见反馈。修复后成功必须弹
//   success toast、失败必须弹 error toast（保留 console.error 供诊断）。
//   历史缺陷（addMultiServerScreenShot / multiServerScreenBatch）：多图截图在
//   捕获失败或批次提交失败时仅 console.error，用户无可见反馈。修复后捕获失败
//   弹 error toast「多图截图捕获失败」、批次提交失败弹 error toast
//   「多图截图提交失败」（均保留 console.error），捕获成功不弹 success toast
//   以避免每次截图刷屏，且仍等待配置的 idle 延时后批量提交。
//
// 测试方式：以纯文本形式读取 desktop/main.js 源码，抽取对应函数体或配置对象，
//   断言端点调用、idle/入队调用、成功/失败路径的 notifyDesktopToast 依旧存在
//   且行为未漂移。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// 抽取 `askFromServerScreen: async () => { ... }` 的函数体（括号配对）。
function extractAskFromServerScreen(source) {
  const marker = 'askFromServerScreen:';
  const start = source.indexOf(marker);
  assert.ok(start !== -1, 'main.js 中未找到 askFromServerScreen callback');

  const arrowStart = source.indexOf('=>', start);
  assert.ok(arrowStart !== -1, 'askFromServerScreen callback 缺少箭头函数');

  const open = source.indexOf('{', arrowStart);
  assert.ok(open !== -1, 'askFromServerScreen callback 缺少函数体');

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('askFromServerScreen callback 函数体括号不匹配');
}

test('askFromServerScreen 仍调用 /api/ask-from-server-screen', () => {
  const body = extractAskFromServerScreen(MAIN_SOURCE);
  assert.ok(
    body.includes("postBackend('/api/ask-from-server-screen')"),
    'askFromServerScreen 应调用 postBackend("/api/ask-from-server-screen")'
  );
});

test('askFromServerScreen 成功路径弹出 success toast', () => {
  const body = extractAskFromServerScreen(MAIN_SOURCE);

  const call = "await postBackend('/api/ask-from-server-screen')";
  const postIndex = body.indexOf(call);
  assert.ok(postIndex !== -1, 'askFromServerScreen 应 await 后端调用');

  // 成功 toast 必须出现在成功路径（postBackend 之后、catch 之前）。
  const successSegment = body.slice(postIndex);
  const catchIndex = successSegment.indexOf('catch');
  assert.ok(catchIndex !== -1, 'askFromServerScreen 缺少 catch 分支');
  const successPrefix = successSegment.slice(0, catchIndex);

  assert.ok(
    successPrefix.includes("notifyDesktopToast('已提交服务端截图审题，请在答案区查看', 'success')"),
    '成功路径应调用 notifyDesktopToast("已提交服务端截图审题，请在答案区查看", "success")'
  );
});

test('askFromServerScreen 失败路径弹出 error toast 且保留 console.error', () => {
  const body = extractAskFromServerScreen(MAIN_SOURCE);

  const catchIndex = body.indexOf('catch');
  assert.ok(catchIndex !== -1, 'askFromServerScreen 缺少 catch 分支');
  const catchBody = body.slice(catchIndex);

  assert.ok(
    catchBody.includes("console.error('askFromServerScreen failed:', error)"),
    '失败路径应保留 console.error 以便诊断'
  );
  assert.ok(
    catchBody.includes("notifyDesktopToast(error?.message || '服务端截图审题失败', 'error')"),
    '失败路径应调用 notifyDesktopToast(error?.message || "服务端截图审题失败", "error")'
  );
});

// 抽取 `async function addMultiServerScreenShot() { ... }` 的函数体（括号配对）。
function extractAddMultiServerScreenShot(source) {
  const marker = 'async function addMultiServerScreenShot()';
  const start = source.indexOf(marker);
  assert.ok(start !== -1, 'main.js 中未找到 addMultiServerScreenShot 函数');

  const open = source.indexOf('{', start);
  assert.ok(open !== -1, 'addMultiServerScreenShot 缺少函数体');

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('addMultiServerScreenShot 函数体括号不匹配');
}

// 抽取 `const multiServerScreenBatch = createMultiScreenBatch({ ... })` 对象体（括号配对）。
function extractMultiServerBatchOptions(source) {
  const marker = 'const multiServerScreenBatch = createMultiScreenBatch(';
  const start = source.indexOf(marker);
  assert.ok(start !== -1, 'main.js 中未找到 multiServerScreenBatch 创建语句');

  const open = source.indexOf('{', start);
  assert.ok(open !== -1, 'multiServerScreenBatch 缺少配置对象');

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('multiServerScreenBatch 配置对象括号不匹配');
}

test('addMultiServerScreenShot 仍调用捕获与入队端点且不立即提交', () => {
  const body = extractAddMultiServerScreenShot(MAIN_SOURCE);

  // 捕获端点保持不变。
  assert.ok(
    body.includes("postBackend('/api/capture-server-screen')"),
    'addMultiServerScreenShot 应调用 postBackend("/api/capture-server-screen")'
  );

  // 捕获后仅入队等待 idle 延时，不立即提交。
  assert.ok(
    body.includes('multiServerScreenBatch.add(res.image, idleMs)'),
    'addMultiServerScreenShot 应将截图入队等待 idle 延时'
  );
  assert.ok(
    body.includes('await getMultiScreenIdleMs()'),
    'addMultiServerScreenShot 应读取配置的 idle 延时'
  );
  assert.ok(
    !body.includes('postBackend(\'/api/ask-from-server-screens\')'),
    'addMultiServerScreenShot 不应直接提交多图批次'
  );
});

test('addMultiServerScreenShot 失败路径弹 error toast 且保留 console.error', () => {
  const body = extractAddMultiServerScreenShot(MAIN_SOURCE);

  const catchIndex = body.indexOf('catch');
  assert.ok(catchIndex !== -1, 'addMultiServerScreenShot 缺少 catch 分支');
  const catchBody = body.slice(catchIndex);

  assert.ok(
    catchBody.includes("console.error('addMultiServerScreenShot failed:', error)"),
    '捕获失败应保留 console.error 以便诊断'
  );
  assert.ok(
    catchBody.includes("notifyDesktopToast(error?.message || '多图截图捕获失败', 'error')"),
    '捕获失败应调用 notifyDesktopToast(error?.message || "多图截图捕获失败", "error")'
  );
});

test('addMultiServerScreenShot 成功路径不弹 success toast', () => {
  const body = extractAddMultiServerScreenShot(MAIN_SOURCE);

  const tryIndex = body.indexOf('try {');
  const catchIndex = body.indexOf('catch');
  assert.ok(tryIndex !== -1, 'addMultiServerScreenShot 缺少 try 分支');
  assert.ok(catchIndex > tryIndex, 'addMultiServerScreenShot 缺少 catch 分支');
  const tryPrefix = body.slice(tryIndex, catchIndex);

  assert.ok(
    !tryPrefix.includes('notifyDesktopToast'),
    '多图截图捕获成功不应弹 success toast，避免每次截图刷屏'
  );
});

test('multiServerScreenBatch 提交失败仍弹 error toast 且保留 console.error、端点不变', () => {
  const options = extractMultiServerBatchOptions(MAIN_SOURCE);

  // 提交端点与 payload 保持不变。
  assert.ok(
    options.includes("postBackend('/api/ask-from-server-screens', JSON.stringify({ images }))"),
    '多图批次提交端点与 payload 应保持不变'
  );

  const onErrorStart = options.indexOf('onError:');
  assert.ok(onErrorStart !== -1, 'multiServerScreenBatch 缺少 onError 配置');
  const onErrorSegment = options.slice(onErrorStart);

  assert.ok(
    onErrorSegment.includes("console.error('flushMultiServerScreenBatch failed:', error)"),
    '批次提交失败应保留 console.error 以便诊断'
  );
  assert.ok(
    onErrorSegment.includes("notifyDesktopToast(error?.message || '多图截图提交失败', 'error')"),
    '批次提交失败应调用 notifyDesktopToast(error?.message || "多图截图提交失败", "error")'
  );
});