const path = require('node:path')

function resolveRuntimePaths({ isPackaged, resourcesPath, appDataPath }) {
  if (!isPackaged) {
    const root = path.resolve(__dirname, '..')
    return {
      root,
      backendDir: path.join(root, 'backend'),
      frontendDist: path.join(root, 'frontend', 'dist'),
      startScript: path.join(root, 'start.py'),
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

module.exports = { resolveRuntimePaths, buildBackendEnvironment }
