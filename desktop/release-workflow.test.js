const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'release-windows.yml');

test('Windows release workflow publishes a version-matched NSIS installer', () => {
  assert.equal(fs.existsSync(workflowPath), true, 'release workflow must exist');
  const source = fs.readFileSync(workflowPath, 'utf8');

  for (const required of [
    'windows-latest',
    'actions/checkout@v4',
    'actions/setup-node@v4',
    'actions/setup-python@v5',
    'actions/upload-artifact@v4',
    'contents: write',
    'npm ci',
    'npm run build',
    'npm run dist',
    'pyinstaller',
    'desktop/dist/*.exe',
    'softprops/action-gh-release@v2',
    'generate_release_notes: true',
  ]) {
    assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing ${required}`);
  }

  assert.match(source, /tags:[\s\S]*v\*\.\*\.\*/);
  assert.match(source, /v\\d\+\\\.\\d\+\\\.\\d\+/);
  assert.match(source, /github\.ref_name/);
  assert.match(source, /desktop\/package\.json/);
  assert.match(source, /package\.json.*version|version.*package\.json/s);
  assert.match(source, /if-no-files-found:\s*error/);
  assert.match(source, /fail_on_unmatched_files:\s*true/);
});

test('Windows release workflow rejects prerelease and mismatched versions', () => {
  const source = fs.readFileSync(workflowPath, 'utf8');
  assert.match(source, /stable|semver|prerelease/i);
  assert.match(source, /throw\s+['"]|throw new Error|exit 1|process\.exit\(1\)/);
  assert.match(source, /tag.*version|version.*tag/i);
});
