const test = require('node:test');
const assert = require('node:assert/strict');

const { CAPTURE_EXCLUSION_MIN_WIN_BUILD, detectCaptureCapability } = require('./captureCapability');

test('Windows 10 2004 及以上走窗口排除模式（真隐身）', () => {
  const win10 = detectCaptureCapability('win32', '10.0.19041');
  assert.equal(win10.supported, true);
  assert.equal(win10.mode, 'exclude');
  assert.match(win10.label, /窗口排除/);

  const win11 = detectCaptureCapability('win32', '10.0.22631');
  assert.equal(win11.mode, 'exclude');
});

test('低于 Windows 10 2004 时如实标注黑块回退', () => {
  const old = detectCaptureCapability('win32', '10.0.19040');
  assert.equal(old.supported, false);
  assert.equal(old.mode, 'monitor');
  assert.match(old.label, /黑块/);
  assert.match(old.detail, new RegExp(String(CAPTURE_EXCLUSION_MIN_WIN_BUILD)));
});

test('无法解析的 Windows 版本号按不支持处理，不误报真隐身', () => {
  const unknown = detectCaptureCapability('win32', 'garbage');
  assert.equal(unknown.supported, false);
  assert.equal(unknown.mode, 'monitor');
});

test('macOS 走 ScreenCaptureKit 分支', () => {
  const mac = detectCaptureCapability('darwin', '23.0.0');
  assert.equal(mac.platform, 'darwin');
  assert.equal(mac.mode, 'screencapturekit');
  assert.equal(mac.supported, true);
});

test('其他平台回退到原生保护且不抛错', () => {
  const linux = detectCaptureCapability('linux', '6.1.0');
  assert.equal(linux.platform, 'linux');
  assert.equal(linux.mode, 'native');

  const unknown = detectCaptureCapability(undefined, undefined);
  assert.equal(unknown.platform, 'unknown');
});
