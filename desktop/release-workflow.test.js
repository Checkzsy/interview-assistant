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

test('Windows release workflow caches and verifies the bundled whisper model', () => {
  const source = fs.readFileSync(workflowPath, 'utf8');

  // 145MB model download per release; the Hugging Face cache is content-addressed.
  assert.match(source, /actions\/cache@v4/);
  assert.match(source, /\.cache[\/\\]huggingface/);

  // The staged model must exist in the PyInstaller output and the release must
  // fail loudly if a model-less installer would otherwise be published.
  assert.match(source, /whisper-base/);
  assert.match(source, /model\.bin/);
  assert.match(source, /Test-Path/);
  assert.match(source, /throw /);

  const distIndex = source.indexOf('npm run dist');
  const verifyIndex = source.lastIndexOf('whisper-base');
  assert.ok(distIndex >= 0 && verifyIndex > distIndex, 'packaged model must be verified after the installer build');
});

test('Windows release workflow validates the packaged app before publishing', () => {
  const source = fs.readFileSync(workflowPath, 'utf8');
  const distIndex = source.indexOf('npm run dist');
  const gateIndex = source.indexOf('node verify-packaged-app.js');
  const uploadIndex = source.indexOf('uses: actions/upload-artifact@v4');
  const publishIndex = source.indexOf('softprops/action-gh-release');
  assert.ok(distIndex >= 0, 'installer build must run');
  assert.ok(gateIndex > distIndex, 'packaged app gate must run after the build');
  assert.ok(uploadIndex > gateIndex, 'archive validation must precede artifact upload');
  assert.ok(publishIndex > gateIndex, 'archive validation must precede publishing');
  assert.match(source, /working-directory: desktop\s+shell: pwsh\s+run: \|\s+node verify-packaged-app\.js --version \(\$env:GITHUB_REF_NAME\.Substring\(1\)\)/);
});

test('desktop CI runs the packaged app gate tests explicitly', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(source, /node --test[^\n]*\bverify-packaged-app\.test\.js\b/);
});

test('Windows release workflow gates publishing on the artifact validator', () => {
  const source = fs.readFileSync(workflowPath, 'utf8');

  // The validator CLI must run against the freshly built dist before upload.
  const distIndex = source.indexOf('npm run dist');
  const validatorIndex = source.indexOf('node release-artifacts.js');
  const publishIndex = source.indexOf('softprops/action-gh-release');
  assert.ok(distIndex >= 0, 'installer build must run');
  assert.ok(validatorIndex > distIndex, 'validator must run after the build');
  assert.ok(publishIndex > validatorIndex, 'publish must happen only after validation');
  assert.match(source, /release-artifacts\.js\s+--version/);

  // Differential updates need the blockmap and metadata next to the EXE, or the
  // SDK silently falls back to full downloads (or fails to see any release).
  for (const required of ['desktop/dist/\\*\\.exe\\.blockmap', 'desktop/dist/latest\\.yml']) {
    assert.match(source, new RegExp(required), `release must upload ${required}`);
  }
});
