'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createShortcutRegistry } = require('./shortcutRegistry');

function createFakeShortcuts(fail = () => false) {
  const calls = [];
  const registered = new Set();
  return {
    calls,
    registered,
    register(key) {
      calls.push(['register', key]);
      if (fail(key) || registered.has(key)) return false;
      registered.add(key);
      return true;
    },
    unregister(key) {
      calls.push(['unregister', key]);
      registered.delete(key);
    },
  };
}

test('rebinds and unregisters only the shortcut this action successfully owns', () => {
  const shortcuts = createFakeShortcuts();
  const registry = createShortcutRegistry(shortcuts);
  assert.equal(registry.register('focusPrevTab', 'CommandOrControl+Left', () => {}), true);
  assert.equal(registry.register('focusPrevTab', 'CommandOrControl+Shift+Left', () => {}), true);
  assert.deepEqual([...shortcuts.registered], ['CommandOrControl+Shift+Left']);
  registry.unregister('focusPrevTab');
  assert.deepEqual([...shortcuts.registered], []);
  assert.deepEqual(shortcuts.calls, [
    ['register', 'CommandOrControl+Left'],
    ['unregister', 'CommandOrControl+Left'],
    ['register', 'CommandOrControl+Shift+Left'],
    ['unregister', 'CommandOrControl+Shift+Left'],
  ]);
});

test('does not unregister a failed or differently owned shortcut', () => {
  const shortcuts = createFakeShortcuts((key) => key === 'CommandOrControl+9');
  const registry = createShortcutRegistry(shortcuts);
  assert.equal(registry.register('oldAction', 'CommandOrControl+9', () => {}), false);
  registry.unregister('oldAction');
  registry.unregister('otherAction');
  assert.deepEqual(shortcuts.calls, [['register', 'CommandOrControl+9']]);
});

test('reset unregisters only successfully owned native shortcuts', () => {
  const shortcuts = createFakeShortcuts((key) => key === 'CommandOrControl+9');
  const registry = createShortcutRegistry(shortcuts);
  assert.equal(registry.register('keptAction', 'CommandOrControl+B', () => {}), true);
  assert.equal(registry.register('unavailableAction', 'CommandOrControl+9', () => {}), false);
  registry.unregisterAll();
  assert.deepEqual([...shortcuts.registered], []);
  assert.deepEqual(shortcuts.calls, [
    ['register', 'CommandOrControl+B'],
    ['register', 'CommandOrControl+9'],
    ['unregister', 'CommandOrControl+B'],
  ]);
});

test('reported conflicts allow old pairs to remain while forbidding new or additional pairs', () => {
  const { hasNewShortcutConflicts } = require('./shortcutRegistry');
  const existing = { first: 'A', second: 'A', third: 'B' };
  assert.equal(hasNewShortcutConflicts(existing, { ...existing, third: 'A' }), true);
  assert.equal(hasNewShortcutConflicts(existing, { ...existing, second: 'C' }), false);
  assert.equal(hasNewShortcutConflicts({ first: 'A', second: 'B' }, { first: 'A', second: 'A' }), true);
  assert.equal(hasNewShortcutConflicts({ first: 'A', second: 'A' }, { first: 'A', second: 'A', third: 'A' }), true);
});

test('owns() reports only keys this action actually registered', () => {
  const shortcuts = createFakeShortcuts((key) => key === 'CommandOrControl+9');
  const registry = createShortcutRegistry(shortcuts);
  registry.register('kept', 'CommandOrControl+B', () => {});
  assert.equal(registry.owns('kept'), true);
  assert.equal(registry.owns('kept', 'CommandOrControl+B'), true);
  assert.equal(registry.owns('kept', 'CommandOrControl+9'), false);
  assert.equal(registry.owns('failed'), false);
});
