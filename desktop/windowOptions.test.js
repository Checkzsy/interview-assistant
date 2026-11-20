const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  PROMPT_OVERLAY_DEFAULT_WIDTH,
  PROMPT_OVERLAY_MAX_WIDTH,
  consumePendingOverlayShow,
  createOverlayChromeOptions,
  getPromptOverlayInitialWidth,
  relayChildOutput,
  writeToStreamSafely,
} = require('./windowOptions');

test('Windows overlay disables the native thick frame that can expose a white title strip', () => {
  const options = createOverlayChromeOptions('win32', true);

  assert.equal(options.frame, false);
  assert.equal(options.transparent, true);
  assert.equal(options.thickFrame, false);
  assert.equal(options.resizable, false);
});

test('non-Windows overlay keeps the existing native resize behavior', () => {
  const options = createOverlayChromeOptions('darwin', true);

  assert.equal(options.frame, false);
  assert.equal(options.transparent, true);
  assert.equal(options.thickFrame, undefined);
  assert.equal(options.resizable, true);
});

test('prompt overlay width falls back safely when persisted width is invalid', () => {
  assert.equal(getPromptOverlayInitialWidth(undefined), PROMPT_OVERLAY_DEFAULT_WIDTH);
  assert.equal(getPromptOverlayInitialWidth('not-a-number'), PROMPT_OVERLAY_DEFAULT_WIDTH);
  assert.equal(getPromptOverlayInitialWidth('780.6'), 781);
  assert.equal(getPromptOverlayInitialWidth(10), 180);
  assert.equal(getPromptOverlayInitialWidth(9999), PROMPT_OVERLAY_MAX_WIDTH);
  assert.equal(getPromptOverlayInitialWidth(undefined, 9999), PROMPT_OVERLAY_MAX_WIDTH);
});

test('pending overlay show is discarded after the overlay was hidden', () => {
  const win = { _pendingShow: true };

  assert.equal(consumePendingOverlayShow(win, false), false);
  assert.equal(win._pendingShow, false);
});

test('pending overlay show is consumed once while the overlay remains visible', () => {
  const win = { _pendingShow: true };

  assert.equal(consumePendingOverlayShow(win, true), true);
  assert.equal(win._pendingShow, false);
  assert.equal(consumePendingOverlayShow(win, true), false);
});

test('writeToStreamSafely swallows broken pipe writes', () => {
  const stream = {
    writable: true,
    destroyed: false,
    write() {
      const error = new Error('broken pipe');
      error.code = 'EPIPE';
      throw error;
    },
  };

  assert.equal(writeToStreamSafely(stream, 'hello'), false);
});

test('relayChildOutput prefixes text and never throws on target write failure', () => {
  const childStream = new EventEmitter();
  const writes = [];
  let shouldThrow = false;
  const stream = {
    writable: true,
    destroyed: false,
    write(chunk) {
      if (shouldThrow) {
        throw new Error('boom');
      }
      writes.push(chunk);
      return true;
    },
  };

  const dispose = relayChildOutput(childStream, stream, '[py] ');
  childStream.emit('data', Buffer.from('line 1\n'));
  shouldThrow = true;
  assert.doesNotThrow(() => childStream.emit('data', 'line 2\n'));
  dispose();
  shouldThrow = false;
  childStream.emit('data', 'line 3\n');

  assert.deepEqual(writes, ['[py] line 1\n']);
});

test('relayChildOutput redacts credentials split across chunks using whole-line buffering', () => {
  const childStream = new EventEmitter();
  const writes = [];
  const stream = {
    writable: true,
    destroyed: false,
    write(chunk) {
      writes.push(chunk);
      return true;
    },
  };

  const dispose = relayChildOutput(childStream, stream, '[py] ');
  childStream.emit('data', Buffer.from('Authorization: Bearer test-jkjg'));
  childStream.emit('data', Buffer.from('ff-j4n8u3\nready\n'));
  dispose();

  assert.deepEqual(writes, ['[py] Authorization: Bearer ***\n', '[py] ready\n']);
});

test('relayChildOutput splits UTF-8 correctly across chunk boundaries', () => {
  const childStream = new EventEmitter();
  const writes = [];
  const stream = {
    writable: true,
    destroyed: false,
    write(chunk) {
      writes.push(chunk);
      return true;
    },
  };

  const dispose = relayChildOutput(childStream, stream, '');
  const bytes = Buffer.from('中文日志\n', 'utf8');
  childStream.emit('data', bytes.subarray(0, 4)); // 切在「文」中间
  childStream.emit('data', bytes.subarray(4));
  dispose();

  assert.deepEqual(writes, ['中文日志\n']);
});

test('relayChildOutput drops an oversized line entirely and marks the drop', () => {
  const childStream = new EventEmitter();
  const writes = [];
  const stream = {
    writable: true,
    destroyed: false,
    write(chunk) {
      writes.push(chunk);
      return true;
    },
  };

  const dispose = relayChildOutput(childStream, stream, '[py] ');
  childStream.emit('data', 'x'.repeat(9000));
  childStream.emit('data', 'still-same-line\nnext-line\n');
  dispose();

  assert.equal(writes[0], '[py] [oversized output line dropped]\n', 'half a token must never be flushed');
  assert.deepEqual(writes.slice(1), ['[py] next-line\n']);
  assert.ok(!writes.join('').includes('x'.repeat(100)));
});
