'use strict';

function createShortcutRegistry(globalShortcut) {
  const ownedKeys = new Map();

  function register(action, key, callback) {
    const existingKey = ownedKeys.get(action);
    if (existingKey === key) return true;
    if (existingKey) {
      globalShortcut.unregister(existingKey);
      ownedKeys.delete(action);
    }
    if (!globalShortcut.register(key, callback)) return false;
    ownedKeys.set(action, key);
    return true;
  }

  function unregister(action) {
    const key = ownedKeys.get(action);
    if (!key) return false;
    globalShortcut.unregister(key);
    ownedKeys.delete(action);
    return true;
  }

  function unregisterAll() {
    for (const action of [...ownedKeys.keys()]) unregister(action);
  }

  function owns(action, key) {
    const ownedKey = ownedKeys.get(action);
    return key === undefined ? ownedKey !== undefined : ownedKey === key;
  }

  return { owns, register, unregister, unregisterAll };
}

// 只用于“编辑是否引入新冲突”：既有冲突允许逐项化解，不要求一次清空。
function getShortcutConflictPairs(shortcuts) {
  const entries = Object.entries(shortcuts || {}).filter(([, key]) => typeof key === 'string' && key);
  const pairs = new Set();
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (entries[i][1] === entries[j][1]) pairs.add(`${entries[i][0]}\u0000${entries[j][0]}`);
    }
  }
  return pairs;
}

function hasNewShortcutConflicts(previous, next) {
  const previousPairs = getShortcutConflictPairs(previous);
  for (const pair of getShortcutConflictPairs(next)) {
    if (!previousPairs.has(pair)) return true;
  }
  return false;
}

module.exports = { createShortcutRegistry, getShortcutConflictPairs, hasNewShortcutConflicts };
