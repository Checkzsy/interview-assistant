const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const GITHUB_API_LATEST =
  'https://api.github.com/repos/Checkzsy/interview-assistant/releases/latest';

/** 去掉 v 前缀并把版本号拆成数字段；预发布标记(如 -beta)不参与比较返回 null 段标记 */
function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^[vV]/, '');
  if (!s) return null;
  const preIdx = s.search(/[-+]/);
  const core = preIdx === -1 ? s : s.slice(0, preIdx);
  const parts = core.split('.').map((p) => {
    const n = Number(p);
    return Number.isFinite(n) ? n : 0;
  });
  if (parts.length === 0) return null;
  return { parts, prerelease: preIdx !== -1 };
}

/** a < b => -1, a == b => 0, a > b => 1；无法解析按 0 处理 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa.parts[i] ?? 0;
    const db = pb.parts[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  if (pa.prerelease !== pb.prerelease) return pa.prerelease ? -1 : 1;
  return 0;
}

/** 从 release 的 assets 里挑出符合平台的下载项 */
function pickAsset(assets, kind = 'exe') {
  if (!Array.isArray(assets)) return null;
  const name = kind === 'portable' ? /-win64-portable\.zip$/i : /\.exe$/i;
  const item = assets.find((a) => a && typeof a.name === 'string' && name.test(a.name));
  if (!item) return null;
  return {
    name: item.name,
    size: Number(item.size) || null,
    url: item.browser_download_url || item.url || null,
    updatedAt: item.updated_at || null,
  };
}

/** 用 Node https 请求 JSON（跟随重定向），返回状态码与解析后的 body；网络错误抛异常 */
function requestJson(url, { timeoutMs = 15000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const lib = /^https:/i.test(url) ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'interview-assistant-updater', Accept: 'application/vnd.github+json', ...headers } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        requestJson(res.headers.location, { timeoutMs, headers }).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          resolve({ status, body: JSON.parse(text) });
        } catch (err) {
          reject(new Error(`JSON parse failed: ${err.message}`));
        }
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

/** 检查 GitHub 最新 release，返回 { current, latest, hasUpdate, asset }；失败抛异常由调用方决定降级 */
async function checkForUpdate({ currentVersion, kind = 'exe', apiUrl = GITHUB_API_LATEST, request = requestJson } = {}) {
  const { body } = await request(apiUrl);
  const latest = typeof body?.tag_name === 'string' ? body.tag_name : null;
  const asset = pickAsset(body?.assets, kind);
  const hasUpdate = !!(latest && currentVersion && compareVersions(latest, currentVersion) > 0 && asset);
  return {
    current: currentVersion ?? null,
    latest,
    hasUpdate,
    asset,
    releaseName: body?.name ?? null,
    publishedAt: body?.published_at ?? null,
  };
}

/** 从 url 下载到 destPath，带进度回调 (received,total)；校验最终大小与 expectedBytes 一致 */
function downloadFile(url, destPath, { onProgress, expectedBytes = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = /^https:/i.test(url) ? https : http;
    const tmpPath = `${destPath}.part`;
    const file = fs.createWriteStream(tmpPath, { flags: 'w' });
    let received = 0;
    let total = 0;
    const cleanup = () => {
      try { file.close(); } catch { /* ignore */ }
    };
    const req = lib.get(url, { headers: { 'User-Agent': 'interview-assistant-updater', Accept: '*/*' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        cleanup();
        downloadFile(res.headers.location, destPath, { onProgress, expectedBytes, timeoutMs }).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        cleanup();
        reject(new Error(`download HTTP ${status}`));
        return;
      }
      total = Number(res.headers['content-length']) || 0;
      res.pipe(file);
      res.on('data', (c) => {
        received += c.length;
        if (onProgress) onProgress({ received, total });
      });
      res.on('end', () => {
        file.end();
        // 等待文件 flush
        file.on('close', () => {
          if (expectedBytes !== null && expectedBytes > 0 && received !== expectedBytes) {
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
            reject(new Error(`size mismatch: expected ${expectedBytes}, got ${received}`));
            return;
          }
          try {
            fs.renameSync(tmpPath, destPath);
          } catch (err) {
            reject(new Error(`rename failed: ${err.message}`));
            return;
          }
          resolve({ received, total, destPath });
        });
      });
      res.on('error', (err) => {
        cleanup();
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        reject(err);
      });
    });
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(); } catch { /* ignore */ }
    });
    req.on('error', (err) => {
      cleanup();
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      reject(err);
    });
    file.on('error', (err) => {
      try { req.destroy(); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      reject(err);
    });
  });
}

/** 静默安装 NSIS 安装包；detached 让安装器独立于本进程生命周期 */
function launchInstaller(exePath) {
  return new Promise((resolve) => {
    try {
      if (!exePath || !fs.existsSync(exePath)) {
        resolve({ ok: false, error: 'installer not found' });
        return;
      }
      const child = spawn(exePath, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
      let settled = false;
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: err && err.message ? err.message : String(err) });
      });
      child.on('spawn', () => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve({ ok: true, pid: child.pid });
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

module.exports = {
  GITHUB_API_LATEST,
  parseVersion,
  compareVersions,
  pickAsset,
  checkForUpdate,
  downloadFile,
  launchInstaller,
};
