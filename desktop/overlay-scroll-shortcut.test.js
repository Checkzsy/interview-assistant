'use strict';

// A5：滚动命令只发给 overlay，作用域与目标隔离在同一个出口判断。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createOverlayCommandSender } = require('./overlayInput');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function createHarness({
  visible = true,
  focus = true,
  destroyed = false,
  windowPresent = true,
} = {}) {
  const sent = [];
  const sender = createOverlayCommandSender({
    getOverlayWindow: () => (windowPresent ? {
      isDestroyed: () => destroyed,
      webContents: { send: (channel, payload) => sent.push([channel, payload]) },
    } : null),
    isOverlayVisible: () => visible,
    isFocusOverlayActive: () => visible && focus,
  });
  return { sender, sent };
}

test('answer scroll works in every visible overlay mode', () => {
  for (const focus of [true, false]) {
    const { sender, sent } = createHarness({ focus });
    assert.equal(sender.sendScroll('answer', 'down'), true);
    assert.deepEqual(sent, [['overlay-scroll-command', { target: 'answer', direction: 'down' }]]);
  }
});

test('question scroll is focus-only and never reaches glass or prompt', () => {
  const nonFocus = createHarness({ focus: false });
  assert.equal(nonFocus.sender.sendScroll('question', 'up'), false);
  assert.deepEqual(nonFocus.sent, []);

  const focus = createHarness({ focus: true });
  assert.equal(focus.sender.sendScroll('question', 'up'), true);
  assert.deepEqual(focus.sent, [['overlay-scroll-command', { target: 'question', direction: 'up' }]]);
});

test('hidden overlay makes every scroll command a no-op', () => {
  const { sender, sent } = createHarness({ visible: false, focus: true });
  assert.equal(sender.sendScroll('answer', 'up'), false);
  assert.equal(sender.sendScroll('question', 'down'), false);
  assert.deepEqual(sent, []);
});

test('rejects unknown targets, directions, and a missing overlay', () => {
  const { sender, sent } = createHarness();
  assert.equal(sender.sendScroll('answer', 'left'), false);
  assert.equal(sender.sendScroll('summary', 'up'), false);
  assert.equal(createHarness({ windowPresent: false }).sender.sendScroll('answer', 'up'), false);
  assert.equal(createHarness({ destroyed: true }).sender.sendScroll('answer', 'up'), false);
  assert.deepEqual(sent, []);
});

test('existing question navigation keeps its original scope and channel', () => {
  const { sender, sent } = createHarness({ focus: false });
  assert.equal(sender.sendQuestion('next'), true);
  assert.deepEqual(sent, [['overlay-question-command', 'next']]);
  assert.equal(createHarness({ visible: false }).sender.sendQuestion('prev'), false);
});

test('focus tab navigation still requires the focus panel', () => {
  assert.equal(createHarness({ focus: false }).sender.sendFocusTab('prev'), false);
  const { sender, sent } = createHarness({ focus: true });
  assert.equal(sender.sendFocusTab('prev'), true);
  assert.deepEqual(sent, [['focus-tab-command', 'prev']]);
});

test('existing question navigation keeps its original visible-overlay scope in main', () => {
  const focusSet = MAIN_SOURCE.match(/FOCUS_OVERLAY_SHORTCUT_ACTIONS = new Set\(\[([^\]]*)\]\)/);
  const visibleSet = MAIN_SOURCE.match(/VISIBLE_OVERLAY_SHORTCUT_ACTIONS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(focusSet && visibleSet);

  assert.ok(!focusSet[1].includes("'overlayPrevQuestion'"));
  assert.ok(!focusSet[1].includes("'overlayNextQuestion'"));
  assert.ok(visibleSet[1].includes("'overlayPrevQuestion'"));
  assert.ok(visibleSet[1].includes("'overlayNextQuestion'"));
  assert.ok(focusSet[1].includes("'overlayScrollPrevQuestion'"));
  assert.ok(focusSet[1].includes("'overlayScrollNextQuestion'"));
  assert.ok(visibleSet[1].includes("'overlayScrollPrevAnswer'"));
  assert.ok(visibleSet[1].includes("'overlayScrollNextAnswer'"));
});
