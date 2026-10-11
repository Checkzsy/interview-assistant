'use strict';

// 防回归测试（regression guard），不 require electron。
//
// 目的：防止「reset-shortcuts」handler 在调用 registerShortcutSet 之前重新引入
//   `fs.unlinkSync(...'shortcuts.json')` 这一破坏性操作。历史缺陷会先物理删除
//   userData 下的 shortcuts.json，再构造 defaults 注册；删除用户配置属于
//   副作用，reset 只应重新构造并注册默认快捷键，不应触碰磁盘文件。
//
// 测试方式：以纯文本形式读取 desktop/main.js 源码，抽取 reset-shortcuts 的
//   handler 函数体，断言其内部在调用 registerShortcutSet 之前不存在对
//   shortcuts.json 的 unlink / unlinkSync 调用。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// 抽取 `ipcMain.handle('reset-shortcuts', ...)` 的函数体。
function extractResetHandler(source) {
  const marker = "ipcMain.handle('reset-shortcuts'";
  const start = source.indexOf(marker);
  assert.ok(start !== -1, 'main.js 中未找到 reset-shortcuts handler');

  const arrowStart = source.indexOf('=>', start);
  assert.ok(arrowStart !== -1, 'reset-shortcuts handler 缺少箭头函数');

  const open = source.indexOf('{', arrowStart);
  assert.ok(open !== -1, 'reset-shortcuts handler 缺少函数体');

  // 括号配对，找到与 open 对应的闭合括号。
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('reset-shortcuts handler 函数体括号不匹配');
}

test('reset-shortcuts handler 在 registerShortcutSet 之前不再删除 shortcuts.json', () => {
  const body = extractResetHandler(MAIN_SOURCE);

  const registerCall = body.indexOf('registerShortcutSet');
  assert.ok(registerCall !== -1, 'reset-shortcuts handler 应调用 registerShortcutSet');

  const prefix = body.slice(0, registerCall);

  // 删除调用一旦出现，即视为回归。unlinkSync / unlink / rmSync 均可命中。
  const destructivePatterns = [
    /unlinkSync\s*\(\s*path\.join\s*\(\s*app\.getPath\s*\(\s*'userData'\s*\)\s*,\s*'shortcuts\.json'\s*\)\s*\)/,
    /unlinkSync/,
    /unlink\s*\(/,
    /rmSync/,
  ];
  for (const re of destructivePatterns) {
    assert.ok(
      !re.test(prefix),
      `reset-shortcuts handler 在 registerShortcutSet 之前不应出现破坏性删除调用，命中模式：${re}`
    );
  }

  // 顺带确认 registerShortcutSet 之后、仍以 defaults 注册（行为未变）。
  assert.ok(body.includes('const defaults = createShortcutState();'), 'reset 应重新构造 defaults');
});

// ---- 以下断言针对 registerShortcutSet 的失败回滚分支 ----
//
// 背景：注册新快捷键集失败时，回滚到上一组快捷键。历史缺陷会把回滚后的
//   shortcut.status 无条件置为 Registered，即使 globalShortcut.register 实际失败，
//   导致渲染进程侧界面状态与系统真实注册状态不一致（失败仍显示 Registered）。
// 期望：回滚循环必须依据 globalShortcut.register 的真实返回值设置
//   Registered / Failed，并在 failedKey 分支返回前调用 sendShortcutsState() 广播。

// 抽取 `function <name>(` 的配对函数体。
function extractFunctionBody(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  assert.ok(start !== -1, `main.js 中未找到 function ${functionName}`);

  const open = source.indexOf('{', start);
  assert.ok(open !== -1, `${functionName} 缺少函数体`);

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`${functionName} 函数体括号不匹配`);
}

// 抽取 `if (failedKey) { ... }` 的分支体。
function extractFailedKeyBranch(functionBody) {
  const marker = 'if (failedKey)';
  const start = functionBody.indexOf(marker);
  assert.ok(start !== -1, 'registerShortcutSet 缺少 if (failedKey) 分支');

  const open = functionBody.indexOf('{', start);
  assert.ok(open !== -1, 'if (failedKey) 分支缺少函数体');

  let depth = 0;
  for (let i = open; i < functionBody.length; i++) {
    if (functionBody[i] === '{') depth++;
    else if (functionBody[i] === '}') {
      depth--;
      if (depth === 0) return functionBody.slice(open, i + 1);
    }
  }
  throw new Error('if (failedKey) 分支括号不匹配');
}

// 抽取回滚循环 `Object.values(shortcuts).forEach((shortcut) => { ... })` 的循环体。
function extractRollbackLoopBody(failedBranch) {
  const anchor = 'shortcuts = prevShortcuts;';
  const anchorIndex = failedBranch.indexOf(anchor);
  assert.ok(anchorIndex !== -1, 'failedKey 分支缺少回滚起始（shortcuts = prevShortcuts）');

  const forEachMarker = 'Object.values(shortcuts).forEach((shortcut) =>';
  const forEachStart = failedBranch.indexOf(forEachMarker, anchorIndex);
  assert.ok(forEachStart !== -1, '回滚循环缺少 Object.values(shortcuts).forEach');

  const open = failedBranch.indexOf('{', forEachStart);
  assert.ok(open !== -1, '回滚循环缺少函数体');

  let depth = 0;
  for (let i = open; i < failedBranch.length; i++) {
    if (failedBranch[i] === '{') depth++;
    else if (failedBranch[i] === '}') {
      depth--;
      if (depth === 0) return failedBranch.slice(open, i + 1).trim();
    }
  }
  throw new Error('回滚循环括号不匹配');
}

test('registerShortcutSet 失败回滚分支广播已校验的注册状态，不无条件置 Registered', () => {
  const functionBody = extractFunctionBody(MAIN_SOURCE, 'registerShortcutSet');
  const failedBranch = extractFailedKeyBranch(functionBody);

  // 失败回滚完成后必须广播 shortcuts-state，避免界面显示与真实注册状态脱节。
  assert.ok(
    failedBranch.includes('sendShortcutsState()'),
    'if (failedKey) 分支在返回前应调用 sendShortcutsState() 广播失败回滚状态'
  );

  // 回滚循环内部不得出现无条件 `shortcut.status = ShortcutStatus.Registered;`：
  // Registered 赋值必须紧跟在 `if (globalShortcut.register(..., callback)) {` 守卫之后。
  const rollbackLoopBody = extractRollbackLoopBody(failedBranch);
  const lines = rollbackLoopBody.split('\n');
  const assignmentTarget = 'shortcut.status = ShortcutStatus.Registered;';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== assignmentTarget) continue;
    let prev = '';
    for (let j = i - 1; j >= 0; j--) {
      if (lines[j].trim() !== '') {
        prev = lines[j].trim();
        break;
      }
    }
    assert.equal(
      prev,
      'if (globalShortcut.register(shortcut.key, callback)) {',
      `回滚循环内 ${assignmentTarget} 必须受 globalShortcut.register 返回值守卫`
    );
  }
});