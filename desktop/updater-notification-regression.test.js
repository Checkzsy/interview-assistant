const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('startup update check uses a persisted notification tracker', () => {
  assert.match(mainSource, /require\(['"]\.\/updater-notify['"]\)/);
  assert.match(mainSource, /notified-version\.json/);
  assert.match(mainSource, /app\.getPath\(['"]userData['"]\)/);
  assert.match(mainSource, /state\.hasUpdate/);
  assert.match(mainSource, /state\.latest/);
  assert.match(mainSource, /tracker\.shouldNotify\(/);
  assert.match(mainSource, /tracker\.markNotified\(/);
  assert.match(mainSource, /notifyDesktopToast\(/);
});

test('startup update check remains delayed and non-blocking', () => {
  assert.match(mainSource, /setTimeout\(async \(\) => \{/);
  assert.match(mainSource, /const controller = buildUpdateController\(\)/);
  assert.match(mainSource, /await controller\.check\(\)/);
  assert.match(mainSource, /catch \{\s*\/\/ 更新检查、通知记录失败都不能阻断应用启动。\s*\}/);
  assert.match(mainSource, /}, 5000\);/);
});

test('update notification does not auto-download or auto-install', () => {
  const startupBlock = mainSource.slice(mainSource.indexOf('// 启动后延迟检查更新'));
  assert.doesNotMatch(startupBlock, /\.download\(\)|\.install\(\)/);
});
