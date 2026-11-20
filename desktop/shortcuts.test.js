const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createShortcutState,
  getShortcutsFilePath,
  isValidShortcutKey,
  loadShortcutConfig,
  saveShortcutConfig,
  validateShortcutMap,
} = require('./shortcuts');

function makeFakeApp(tmpDir) {
  return {
    getPath(name) {
      assert.equal(name, 'userData');
      return tmpDir;
    },
  };
}

test('isValidShortcutKey accepts CommandOrControl with optional Shift and Alt plus supported key', () => {
  assert.equal(isValidShortcutKey('CommandOrControl+B'), true);
  assert.equal(isValidShortcutKey('CommandOrControl+.'), true);
  assert.equal(isValidShortcutKey('CommandOrControl+/'), true);
  assert.equal(isValidShortcutKey('CommandOrControl+Enter'), true);
  assert.equal(isValidShortcutKey('CommandOrControl+Escape'), true);
  assert.equal(isValidShortcutKey('CommandOrControl+Left'), true);
  assert.equal(isValidShortcutKey('CommandOrControl+Right'), true);
  assert.equal(isValidShortcutKey('CommandOrControl+Shift+J'), true);
  assert.equal(isValidShortcutKey('CommandOrControl+Shift+Enter'), true);
  assert.equal(isValidShortcutKey('CommandOrControl+Shift+/'), true);
  assert.equal(isValidShortcutKey('CommandOrControl+Alt+J'), true);
  assert.equal(isValidShortcutKey('CommandOrControl+Shift+Alt+J'), true);
  assert.equal(isValidShortcutKey('Alt+B'), false);
  assert.equal(isValidShortcutKey('CommandOrControl+Alt+Shift+B'), false);
  assert.equal(isValidShortcutKey('CommandOrControl+Shift+Shift+B'), false);
  assert.equal(isValidShortcutKey('CommandOrControl+Meta+B'), false);
  assert.equal(isValidShortcutKey('CommandOrControl+Backspace'), false);
});

test('validateShortcutMap rejects duplicate keys', () => {
  const shortcuts = createShortcutState({
    hardClearSession: { key: 'CommandOrControl+B' },
  });
  const result = validateShortcutMap(shortcuts);
  assert.equal(result.ok, false);
  assert.match(result.error, /重复/);
});

test('new overlay actions keep distinct defaults and merge existing conflicts per shortcut', () => {
  const defaults = createShortcutState();
  const overlayActions = [
    'overlayScrollPrevAnswer',
    'overlayScrollNextAnswer',
    'overlayScrollPrevQuestion',
    'overlayScrollNextQuestion',
    'toggleOverlayPassthrough',
  ];
  const keys = overlayActions.map((action) => defaults[action].key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(defaults.toggleOverlayPassthrough.key, 'CommandOrControl+1');
  assert.equal(defaults.overlayScrollPrevAnswer.key, 'CommandOrControl+Shift+Up');
  assert.equal(defaults.overlayScrollNextQuestion.key, 'CommandOrControl+Shift+Right');
  assert.equal(isValidShortcutKey(defaults.overlayScrollPrevQuestion.key), true);
  assert.equal(isValidShortcutKey(defaults.toggleOverlayPassthrough.key), true);
  assert.equal(validateShortcutMap(defaults).ok, true);

  // 旧配置里把 overlay 下一题改成和硬清空同键：迁移后只允许这一对既有冲突留存。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-shortcuts-conflict-'));
  fs.writeFileSync(
    path.join(tmpDir, 'shortcuts.json'),
    JSON.stringify({ overlayNextQuestion: { key: 'CommandOrControl+.' } }),
  );
  const loaded = loadShortcutConfig(makeFakeApp(tmpDir));
  assert.equal(loaded.overlayNextQuestion.key, 'CommandOrControl+.');
  assert.equal(loaded.hardClearSession.key, 'CommandOrControl+.');
  assert.equal(validateShortcutMap(loaded).ok, false);
  assert.equal(loaded.overlayScrollPrevAnswer.key, 'CommandOrControl+Shift+Up');
});

test('load and save shortcut config roundtrip', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-shortcuts-'));
  const app = makeFakeApp(tmpDir);
  const shortcuts = createShortcutState({
    askFromServerScreen: { key: 'CommandOrControl+/' },
    cancelAnswer: { key: 'CommandOrControl+Escape' },
    addMultiServerScreenShot: { key: 'CommandOrControl+Shift+/' },
    hardClearSession: { key: 'CommandOrControl+.' },
    toggleInterviewOverlay: { key: 'CommandOrControl+Shift+Enter' },
    focusPrevTab: { key: 'CommandOrControl+Left' },
    focusNextTab: { key: 'CommandOrControl+Right' },
    overlayPrevQuestion: { key: 'CommandOrControl+Up' },
    overlayNextQuestion: { key: 'CommandOrControl+Down' },
    askScreenForceThink: { key: 'CommandOrControl+Alt+/' },
    askScreenForceNoThink: { key: 'CommandOrControl+Alt+.' },
    toggleThinkMode: { key: 'CommandOrControl+Shift+T' },
  });

  saveShortcutConfig(app, shortcuts);
  const loaded = loadShortcutConfig(app);

  assert.equal(loaded.askFromServerScreen.key, 'CommandOrControl+/');
  assert.equal(loaded.cancelAnswer.key, 'CommandOrControl+Escape');
  assert.equal(loaded.addMultiServerScreenShot.key, 'CommandOrControl+Shift+/');
  assert.equal(loaded.hardClearSession.key, 'CommandOrControl+.');
  assert.equal(loaded.toggleInterviewOverlay.key, 'CommandOrControl+Shift+Enter');
  assert.equal(loaded.focusPrevTab.key, 'CommandOrControl+Left');
  assert.equal(loaded.focusNextTab.key, 'CommandOrControl+Right');
  assert.equal(loaded.overlayPrevQuestion.key, 'CommandOrControl+Up');
  assert.equal(loaded.overlayNextQuestion.key, 'CommandOrControl+Down');
  assert.equal(loaded.askScreenForceThink.key, 'CommandOrControl+Alt+/');
  assert.equal(loaded.askScreenForceNoThink.key, 'CommandOrControl+Alt+.');
  assert.equal(loaded.toggleThinkMode.key, 'CommandOrControl+Shift+T');
  assert.ok(fs.existsSync(getShortcutsFilePath(app)));
});

test('default think shortcuts are valid and unique', () => {
  const shortcuts = createShortcutState();
  assert.equal(shortcuts.askScreenForceThink.key, 'CommandOrControl+Alt+/');
  assert.equal(shortcuts.askScreenForceNoThink.key, 'CommandOrControl+Alt+.');
  assert.equal(shortcuts.toggleThinkMode.key, 'CommandOrControl+Shift+T');
  assert.equal(isValidShortcutKey(shortcuts.askScreenForceThink.key), true);
  assert.equal(isValidShortcutKey(shortcuts.askScreenForceNoThink.key), true);
  assert.equal(isValidShortcutKey(shortcuts.toggleThinkMode.key), true);
  const result = validateShortcutMap(shortcuts);
  assert.equal(result.ok, true);
});
