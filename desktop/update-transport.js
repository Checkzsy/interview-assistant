'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkForUpdate, downloadFile } = require('./updater');

function parseAssetDigest(digest) {
  if (typeof digest !== 'string') return null;
  const match = /^(sha256|sha512):([a-f0-9]+)$/i.exec(digest);
  if (!match || match[2].length !== (match[1].toLowerCase() === 'sha256' ? 64 : 128)) return null;
  return Object.freeze({ algorithm: match[1].toLowerCase(), encoding: 'hex', value: match[2].toLowerCase() });
}

async function verifyFile(filePath, integrity) {
  if (!integrity) throw new Error('更新缺少可信摘要，请从发布页面手动下载');
  const hash = crypto.createHash(integrity.algorithm);
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  if (hash.digest(integrity.encoding) !== integrity.value) throw new Error('installer checksum mismatch');
}

function targetId(version, asset, integrity) {
  return JSON.stringify([version?.replace(/^v/i, ''), asset?.name, asset?.url, integrity]);
}

function createUpdateTransport({ currentVersion, downloadsDir, apiUrl, request, downloadFn = downloadFile, updater = null, logger = console } = {}) {
  if (updater) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.disableWebInstaller = true;
    updater.logger = logger;
  }
  let checkedId = null;

  async function check() {
    let result = null;
    if (updater) {
      try {
        result = await updater.checkForUpdates();
      } catch (error) {
        // Only "no update metadata published" is a legitimate legacy release.
        // Anything else (bad YAML, bad digest, network) must surface, otherwise a
        // corrupt feed would silently downgrade the client to size-only checks.
        if (error.code !== 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') throw error;
      }
    }
    if (result) {
      const info = result.updateInfo;
      const file = info.files?.find((item) => /\.exe$/i.test(item.url));
      if (!file || typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) {
        throw new Error('SDK update metadata is missing a valid SHA512 digest');
      }
      const integrity = Object.freeze({ algorithm: 'sha512', encoding: 'base64', value: file.sha512 });
      const asset = { name: path.posix.basename(file.url), url: file.url, size: file.size || null, updatedAt: info.releaseDate || null };
      checkedId = targetId(info.version, asset, integrity);
      return { current: currentVersion, latest: info.version, hasUpdate: result.isUpdateAvailable, asset, releaseName: info.releaseName || null, publishedAt: info.releaseDate || null, integrity, targetId: checkedId, source: 'sdk' };
    }
    const legacy = await checkForUpdate({ currentVersion, apiUrl, request });
    const integrity = parseAssetDigest(legacy.asset?.digest);
    checkedId = targetId(legacy.latest, legacy.asset, integrity);
    return { ...legacy, integrity, targetId: checkedId, source: 'legacy' };
  }

  async function download(target, { onProgress, timeoutMs } = {}) {
    if (target.targetId !== checkedId || !target.hasUpdate) throw new Error('更新目标已改变，请重新检查');
    if (!target.integrity) throw new Error('更新缺少可信摘要，请从发布页面手动下载');
    let downloadedPath;
    if (target.source === 'sdk') {
      let event = null;
      const progress = (info) => onProgress?.({ received: info.transferred, total: info.total });
      const done = (info) => { event = info; };
      updater.on('download-progress', progress);
      updater.on('update-downloaded', done);
      try {
        await updater.downloadUpdate();
        if (!event?.downloadedFile || event.version !== target.latest) throw new Error('SDK downloaded target did not match the checked update');
        downloadedPath = event.downloadedFile;
      } finally {
        updater.removeListener('download-progress', progress);
        updater.removeListener('update-downloaded', done);
      }
    } else {
      fs.mkdirSync(downloadsDir, { recursive: true });
      downloadedPath = path.join(downloadsDir, path.basename(target.asset.name));
      await downloadFn(target.asset.url, downloadedPath, { onProgress, expectedBytes: target.asset.size, timeoutMs });
    }
    await verifyFile(downloadedPath, target.integrity);
    const size = fs.statSync(downloadedPath).size;
    return { downloadedPath, received: size, total: size };
  }
  return { check, download, dispose() {} };
}

function createElectronUpdateTransport(options = {}) {
  let updater = null;
  try {
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
  } catch (error) {
    options.logger?.warn('Updater SDK unavailable; using release API with digest verification');
  }
  return createUpdateTransport({ ...options, updater });
}

module.exports = { createUpdateTransport, createElectronUpdateTransport, parseAssetDigest, verifyFile };
