const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNotifyTracker } = require('./updater-notify');

function makeTracker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-update-notify-'));
  const filePath = path.join(dir, 'updates', 'notified-version.json');
  return {
    dir,
    filePath,
    tracker: createNotifyTracker({ filePath }),
  };
}

test('notification tracker treats a missing marker as not notified', () => {
  const { dir, tracker } = makeTracker();
  try {
    assert.equal(tracker.lastNotified(), null);
    assert.equal(tracker.shouldNotify('v1.3.0'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('notification tracker persists and suppresses the same tag', () => {
  const { dir, filePath, tracker } = makeTracker();
  try {
    tracker.markNotified('v1.3.0');
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { tag: 'v1.3.0' });
    assert.equal(tracker.lastNotified(), 'v1.3.0');
    assert.equal(tracker.shouldNotify('v1.3.0'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('notification tracker allows a different release tag', () => {
  const { dir, tracker } = makeTracker();
  try {
    tracker.markNotified('v1.3.0');
    assert.equal(tracker.shouldNotify('v1.4.0'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('notification tracker ignores invalid tags and does not write them', () => {
  const { dir, filePath, tracker } = makeTracker();
  try {
    for (const tag of [null, '', undefined, 1, {}]) {
      assert.equal(tracker.shouldNotify(tag), false);
      tracker.markNotified(tag);
    }
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('notification tracker treats corrupt marker JSON as not notified', () => {
  const { dir, filePath, tracker } = makeTracker();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{bad json', 'utf8');
    assert.equal(tracker.lastNotified(), null);
    assert.equal(tracker.shouldNotify('v1.3.0'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('notification tracker surfaces marker write failures', () => {
  const tracker = createNotifyTracker({
    filePath: path.join(os.tmpdir(), 'unwritable-parent', 'marker.json'),
    writeFile: () => { throw new Error('disk unavailable'); },
  });
  assert.throws(() => tracker.markNotified('v1.3.0'), /disk unavailable/);
});
