'use strict';

// Publish gate. Parses the produced latest.yml and blockmap with the same pinned
// electron-builder tool that wrote them, then proves they describe the exact
// installer bytes about to be uploaded. A blockmap with the right length but the
// wrong per-block checksums must be rejected, so length alone is never trusted.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const yaml = require('js-yaml');

function sha512Base64(filePath) {
  const hash = crypto.createHash('sha512');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('base64');
}

async function buildBlockMap() {
  // Resolved lazily so the CLI's own argument handling runs without the builder
  // installed only when it actually needs to recompute the map.
  return require('app-builder-lib/out/targets/blockmap/blockmap').buildBlockMap;
}

function assertIntegrityMatches(metadataSha512, recomputed, label) {
  if (typeof metadataSha512 !== 'string' || !metadataSha512) {
    throw new Error(`${label} is missing sha512`);
  }
  if (metadataSha512 !== recomputed) {
    throw new Error(`${label} sha512 does not match the installer bytes`);
  }
}

async function validateReleaseArtifacts({ distDir, version }) {
  const packageVersion = JSON.parse(fs.readFileSync(path.join(distDir, '..', 'package.json'), 'utf8')).version;
  if (version !== packageVersion) throw new Error(`tag version ${version} does not match desktop/package.json ${packageVersion}`);
  const exePath = path.join(distDir, `Interview.Assistant.Setup.${version}.exe`);
  const metadataPath = path.join(distDir, 'latest.yml');
  if (!fs.existsSync(exePath)) throw new Error(`installer not found: ${exePath}`);
  if (!fs.existsSync(metadataPath)) throw new Error(`metadata not found: ${metadataPath}`);
  const metadata = yaml.load(fs.readFileSync(metadataPath, 'utf8'));
  if (!metadata || typeof metadata !== 'object') throw new Error('latest.yml is empty');

  if (metadata.version !== version) throw new Error(`latest.yml version ${metadata.version} does not match ${version}`);

  const installerSize = fs.statSync(exePath).size;
  const installerDigest = sha512Base64(exePath);
  const files = Array.isArray(metadata.files) ? metadata.files : [];
  const entry = files.find((file) => file && file.url === path.basename(exePath));
  if (!entry) throw new Error(`latest.yml files[] has no entry for ${path.basename(exePath)}`);
  assertIntegrityMatches(entry.sha512, installerDigest, 'latest.yml files[].sha512');
  assertIntegrityMatches(metadata.sha512, installerDigest, 'latest.yml sha512');
  if (metadata.path != null && metadata.path !== path.basename(exePath)) {
    throw new Error(`legacy path ${metadata.path} must equal the uploaded installer name`);
  }
  // Size is optional in the format: only verify it when the producer wrote it.
  if (entry.size != null && entry.size !== installerSize) throw new Error('latest.yml files[].size does not match the installer');
  if (metadata.size != null && metadata.size !== installerSize) throw new Error('latest.yml size does not match the installer');

  const blockMapPath = `${exePath}.blockmap`;
  if (!fs.existsSync(blockMapPath)) throw new Error(`blockmap not found: ${blockMapPath}`);
  const blockMap = JSON.parse(zlib.gunzipSync(fs.readFileSync(blockMapPath)).toString('utf8'));
  const blockFile = Array.isArray(blockMap.files) ? blockMap.files[0] : null;
  if (!blockFile || !Array.isArray(blockFile.checksums) || !Array.isArray(blockFile.sizes)) {
    throw new Error('blockmap is missing per-block checksums/sizes');
  }
  if (blockFile.checksums.length !== blockFile.sizes.length) throw new Error('blockmap checksum and size counts differ');
  const total = blockFile.sizes.reduce((sum, size) => sum + size, 0);
  if (total !== installerSize) throw new Error(`blockmap describes ${total} bytes, installer is ${installerSize}`);

  // Recompute against the exact bytes. Comparing only total length would accept a
  // same-size map for a different installer, so per-block checksums are required.
  const rebuiltPath = path.join(path.dirname(blockMapPath), `.validator-${version}.blockmap`);
  const build = await buildBlockMap();
  try {
    await build(exePath, 'gzip', rebuiltPath);
    const rebuilt = JSON.parse(zlib.gunzipSync(fs.readFileSync(rebuiltPath)).toString('utf8'));
    const produced = JSON.stringify(blockFile);
    const expected = JSON.stringify(rebuilt.files[0]);
    if (produced !== expected) throw new Error('blockmap checksums do not match the installer bytes');
  } finally {
    fs.rmSync(rebuiltPath, { force: true });
  }
  return { version, installer: path.basename(exePath), size: installerSize, sha512: installerDigest, blocks: blockFile.checksums.length };
}

function parseArgs(argv) {
  const args = { distDir: path.join(__dirname, 'dist'), version: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dist') args.distDir = path.resolve(argv[++i]);
    else if (argv[i] === '--version') args.version = argv[++i];
  }
  if (!args.version) throw new Error('--version is required');
  return args;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => validateReleaseArtifacts(parseArgs(process.argv.slice(2))))
    .then((result) => {
      console.log(`Release artifacts OK: ${result.installer} ${result.size} bytes, ${result.blocks} blocks`);
    })
    .catch((error) => {
      console.error(`Release artifacts invalid: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { validateReleaseArtifacts, sha512Base64 };
