const fs = require('node:fs');
const path = require('node:path');

function createNotifyTracker({
  filePath,
  readFile = fs.readFileSync,
  writeFile = fs.writeFileSync,
}) {
  if (!filePath) throw new TypeError('filePath is required');

  let loaded = false;
  let cachedTag = null;

  function loadTag() {
    if (loaded) return cachedTag;
    loaded = true;
    try {
      const raw = readFile(filePath, 'utf8');
      const parsed = JSON.parse(String(raw));
      cachedTag = typeof parsed?.tag === 'string' && parsed.tag.trim()
        ? parsed.tag
        : null;
    } catch {
      cachedTag = null;
    }
    return cachedTag;
  }

  function lastNotified() {
    return loadTag();
  }

  function shouldNotify(tag) {
    return typeof tag === 'string' && tag.trim().length > 0 && tag !== loadTag();
  }

  function markNotified(tag) {
    if (typeof tag !== 'string' || tag.trim().length === 0) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFile(filePath, JSON.stringify({ tag }), 'utf8');
    loaded = true;
    cachedTag = tag;
    return true;
  }

  return { lastNotified, shouldNotify, markNotified };
}

module.exports = { createNotifyTracker };
