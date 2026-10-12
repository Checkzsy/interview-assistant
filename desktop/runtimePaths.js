const path = require('node:path')
const net = require('node:net')

function resolveRuntimePaths({ isPackaged, resourcesPath, appDataPath }) {
  if (!isPackaged) {
    const root = path.resolve(__dirname, '..')
    return {
      root,
      backendDir: path.join(root, 'backend'),
      frontendDist: path.join(root, 'frontend', 'dist'),
      startScript: path.join(root, 'start.py'),
      backendExecutable: null,
      dataDir: null,
      configPath: null,
      isPackaged: false,
    }
  }

  return {
    root: resourcesPath,
    backendDir: path.join(resourcesPath, 'backend'),
    frontendDist: path.join(resourcesPath, 'frontend', 'dist'),
    startScript: path.join(resourcesPath, 'start.py'),
    backendExecutable: path.join(resourcesPath, 'backend', 'backend.exe'),
    dataDir: path.join(appDataPath, 'data'),
    configPath: path.join(appDataPath, 'config.json'),
    isPackaged: true,
  }
}

function buildBackendEnvironment(runtimePaths, baseEnvironment = {}) {
  const env = { ...baseEnvironment }
  if (runtimePaths.isPackaged) {
    env.IA_DATA_DIR = runtimePaths.dataDir
    env.IA_CONFIG_PATH = runtimePaths.configPath
    env.IA_FRONTEND_DIST = runtimePaths.frontendDist
  }
  return env
}

const DEFAULT_SERVER_PORT = 18080
// 候选端口：先用默认端口，若被保留/占用则逐个尝试回退端口。探测结果只认真实 bind 成功。
const FALLBACK_SERVER_PORTS = [9090, 18122, 9091]

// 真实探测端口是否可绑定。任何非"可监听"结果都视为不可用，
// 包括端口被进程占用(EADDRINUSE)或被系统保留(EACCES)。
function probePort(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const server = net.createServer()
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { server.close() } catch (_) { /* ignore */ }
      resolve(false)
    }, timeoutMs)
    server.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES' ? false : false)
    })
    server.once('listening', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close(() => resolve(true))
    })
    server.listen(port, host)
  })
}

function parseExplicitPort(explicit) {
  if (explicit === undefined || explicit === null) return null
  const value = Number(explicit)
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null
}

// 异步挑选可用端口：显式 PORT > 默认端口 > 回退候选。全部不可用时返回首选端口，
// 交由启动路径负责报告错误。
async function resolveServerPort(preferred = DEFAULT_SERVER_PORT, opts = {}) {
  const probe = opts.probe || probePort
  const explicit = parseExplicitPort(opts.envPort)
  const candidates = []
  if (explicit !== null) candidates.push(explicit)
  const initial = Number.isInteger(preferred) && preferred > 0 && preferred <= 65535
    ? preferred
    : DEFAULT_SERVER_PORT
  candidates.push(initial)
  for (const port of FALLBACK_SERVER_PORTS) {
    candidates.push(port)
  }
  for (const port of candidates) {
    const usable = await probe(port)
    if (usable) return port
  }
  return initial
}

module.exports = { resolveRuntimePaths, buildBackendEnvironment, resolveServerPort, probePort }
