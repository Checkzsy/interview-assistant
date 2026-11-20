'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const yaml = require('js-yaml');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
const { validateReleaseArtifacts, sha512Base64 } = require('./release-artifacts');

const VERSION = '1.2.3';

function deterministicBytes(len, seedInit) {
  const buffer = Buffer.alloc(len);
  let seed = seedInit;
  for (let i = 0; i < len; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    buffer[i] = seed >>> 24;
  }
  return buffer;
}

async function makeDist({ extraSize = null, seed = 7 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-release-'));
  const dist = path.join(dir, 'dist');
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: VERSION }));
  const name = `Interview.Assistant.Setup.${VERSION}.exe`;
  const exe = path.join(dist, name);
  const bytes = Buffer.concat([deterministicBytes(300 * 1024, seed), extraSize ? Buffer.alloc(extraSize, 3) : Buffer.alloc(0)]);
  fs.writeFileSync(exe, bytes);
  await buildBlockMap(exe, 'gzip', `${exe}.blockmap`);
  const sha512 = sha512Base64(exe);
  const write = (over = {}) => fs.writeFileSync(path.join(dist, 'latest.yml'), yaml.dump({
    version: VERSION,
    files: [{ url: name, sha512, size: bytes.length }],
    path: name,
    sha512,
    releaseDate: '2026-11-20T00:00:00.000Z',
    ...over,
  }));
  write();
  return { dir, dist, exe, name, bytes, sha512, write };
}

test('accepts a release whose metadata and blockmap match the installer bytes', async (t) => {
  const fixture = await makeDist();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const result = await validateReleaseArtifacts({ distDir: fixture.dist, version: VERSION });
  assert.equal(result.size, fixture.bytes.length);
  assert.equal(result.sha512, fixture.sha512);
  assert.equal(result.blocks > 0, true);
});

test('size fields are optional, but wrong values are still rejected', async (t) => {
  const fixture = await makeDist();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  fixture.write({ files: [{ url: fixture.name, sha512: fixture.sha512 }], size: undefined });
  await validateReleaseArtifacts({ distDir: fixture.dist, version: VERSION });

  fixture.write({ files: [{ url: fixture.name, sha512: fixture.sha512, size: fixture.bytes.length + 1 }] });
  await assert.rejects(validateReleaseArtifacts({ distDir: fixture.dist, version: VERSION }), /size/);
});

test('rejects a metadata sha512 that does not describe the installer', async (t) => {
  const fixture = await makeDist();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  fixture.write({ sha512: 'A'.repeat(86) + '==' });
  await assert.rejects(validateReleaseArtifacts({ distDir: fixture.dist, version: VERSION }), /sha512/);
});

test('rejects a tag/version mismatch', async (t) => {
  const fixture = await makeDist();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  await assert.rejects(validateReleaseArtifacts({ distDir: fixture.dist, version: '1.2.4' }), /does not match/);
});

test('rejects a same-size blockmap produced from different bytes', async (t) => {
  const fixture = await makeDist();
  const other = await makeDist({ seed: 99 });
  t.after(() => {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
    fs.rmSync(other.dir, { recursive: true, force: true });
  });
  // Same length, different content: a length-only comparison would pass.
  assert.equal(fs.statSync(other.exe).size, fs.statSync(fixture.exe).size);
  assert.notEqual(other.bytes.toString('hex').slice(0, 64), fixture.bytes.toString('hex').slice(0, 64));
  fs.copyFileSync(`${other.exe}.blockmap`, `${fixture.exe}.blockmap`);
  await assert.rejects(validateReleaseArtifacts({ distDir: fixture.dist, version: VERSION }), /blockmap/);
});

test('rejects an embedded blockmap whose block count disagrees with the installer', async (t) => {
  const fixture = await makeDist();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const original = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${fixture.exe}.blockmap`)).toString('utf8'));
  original.files[0].sizes[0] += 1;
  fs.writeFileSync(`${fixture.exe}.blockmap`, zlib.gzipSync(JSON.stringify(original)));
  await assert.rejects(validateReleaseArtifacts({ distDir: fixture.dist, version: VERSION }), /block/);
});

test('rejects a metadata entry that names a different installer', async (t) => {
  const fixture = await makeDist();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  fixture.write({ files: [{ url: 'other.exe', sha512: fixture.sha512, size: fixture.bytes.length }], path: 'other.exe' });
  await assert.rejects(validateReleaseArtifacts({ distDir: fixture.dist, version: VERSION }), /no entry|must equal/);
});

test('sha512Base64 hashes large files in chunks without loading them whole', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-sha-'));
  try {
    const file = path.join(dir, 'big.bin');
    fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 + 7, 9));
    const expected = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
    assert.equal(sha512Base64(file), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
