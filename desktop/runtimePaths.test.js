const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { buildBackendEnvironment, resolveRuntimePaths } = require('./runtimePaths')

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
