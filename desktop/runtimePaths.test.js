const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { buildBackendEnvironment, resolveRuntimePaths, resolveServerPort, probePort } = require('./runtimePaths')

test('development runtime keeps repository layout and does not force user-data overrides', () => {
  const result = resolveRuntimePaths({
    isPackaged: false,
    resourcesPath: 'C:\\fake\\resources',
    appDataPath: 'C:\\fake\\app-data',
  })

  assert.strictEqual(result.root, path.resolve(__dirname, '..'))
  assert.strictEqual(result.dataDir, null)
  assert.strictEqual(result.configPath, null)
  assert.strictEqual(result.startScript, path.join(result.root, 'start.py'))
})

test('packaged runtime uses extraResources and writable user data', () => {
  const resourcesPath = path.join('C:', 'fake', 'resources')
  const appDataPath = path.join('C:', 'fake', 'app-data')
  const result = resolveRuntimePaths({ isPackaged: true, resourcesPath, appDataPath })

  assert.strictEqual(result.root, resourcesPath)
  assert.strictEqual(result.backendDir, path.join(resourcesPath, 'backend'))
  assert.strictEqual(result.frontendDist, path.join(resourcesPath, 'frontend', 'dist'))
  assert.strictEqual(result.startScript, path.join(resourcesPath, 'start.py'))
  assert.strictEqual(result.backendExecutable, path.join(resourcesPath, 'backend', 'backend.exe'))
  assert.strictEqual(result.dataDir, path.join(appDataPath, 'data'))
  assert.strictEqual(result.configPath, path.join(appDataPath, 'config.json'))
})

test('backend environment is isolated only in packaged mode', () => {
  const devPaths = resolveRuntimePaths({
    isPackaged: false,
    resourcesPath: 'C:\\fake\\resources',
    appDataPath: 'C:\\fake\\app-data',
  })
  const devEnv = buildBackendEnvironment(devPaths, {
    IA_DATA_DIR: 'C:\\existing-data',
    IA_CONFIG_PATH: 'C:\\existing-config.json',
  })
  assert.strictEqual(devEnv.IA_DATA_DIR, 'C:\\existing-data')
  assert.strictEqual(devEnv.IA_CONFIG_PATH, 'C:\\existing-config.json')

  const packagedPaths = resolveRuntimePaths({
    isPackaged: true,
    resourcesPath: path.join('C:', 'fake', 'resources'),
    appDataPath: path.join('C:', 'fake', 'app-data'),
  })
  const packagedEnv = buildBackendEnvironment(packagedPaths, {})
  assert.strictEqual(packagedEnv.IA_DATA_DIR, packagedPaths.dataDir)
  assert.strictEqual(packagedEnv.IA_CONFIG_PATH, packagedPaths.configPath)
  assert.strictEqual(packagedEnv.IA_FRONTEND_DIST, packagedPaths.frontendDist)
})

test('resolveServerPort probes the default port first and returns it when free', async () => {
  const port = await resolveServerPort(18080, {
    envPort: undefined,
    probe: async () => true,
  })
  assert.strictEqual(port, 18080)
})

test('resolveServerPort skips reserved/occupied ports and falls back to an available one', async () => {
  const unavailable = new Set([18080, 9090])
  const port = await resolveServerPort(18080, {
    envPort: undefined,
    probe: async (p) => !unavailable.has(p),
  })
  assert.strictEqual(port, 18122)
})

test('resolveServerPort honors an explicit PORT env even when the default is free', async () => {
  const port = await resolveServerPort(18080, {
    envPort: 19530,
    probe: async (p) => p === 19530,
  })
  assert.strictEqual(port, 19530)
})

test('resolveServerPort falls back to probing when explicit PORT is unusable', async () => {
  // explicit 19400 与默认 18080、9090 均不可用，回退到 18122
  const port = await resolveServerPort(18080, {
    envPort: 19400,
    probe: async (p) => p !== 19400 && p !== 18080 && p !== 9090,
  })
  assert.strictEqual(port, 18122)
})

test('resolveServerPort returns the preferred port when every candidate is unavailable', async () => {
  const port = await resolveServerPort(18080, {
    envPort: undefined,
    probe: async () => false,
  })
  assert.strictEqual(port, 18080)
})

test('probePort detects a port currently in use and reports it free after release', async () => {
  const net = require('node:net')

  // 占住一个随机空闲端口（不硬编码端口号，避免环境差异导致 flaky）
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = server.address().port
  assert.ok(port > 0, '应取得一个有效端口')

  try {
    // 被占用时应探测为不可用
    assert.strictEqual(await probePort(port), false, '被占用的端口应探测为不可用')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  // 释放后重试探测直到可绑定（端口刚释放可能有极短的重绑窗口，重试避免 flaky）
  let free = false
  for (let i = 0; i < 20 && !free; i += 1) {
    free = await probePort(port)
    if (!free) await new Promise((r) => setTimeout(r, 50))
  }
  assert.strictEqual(free, true, '释放后的端口应恢复可绑定')
})
