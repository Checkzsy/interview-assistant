const test = require('node:test')
const assert = require('node:assert')

test('desktop package defines a safe electron-builder layout', () => {
  const pkg = require('./package.json')
  assert.strictEqual(pkg.scripts.dist, 'electron-builder --win nsis --x64')
  assert.strictEqual(pkg.scripts['dist:dir'], 'electron-builder --win --x64 --dir')

  const build = pkg.build
  assert.ok(build)
  assert.strictEqual(build.appId, 'com.interviewassistant.desktop')
  assert.strictEqual(build.productName, 'Interview Assistant')
  assert.deepStrictEqual(build.directories, { output: 'dist' })
  for (const file of ['main.js', 'preload.js', 'runtimePaths.js']) {
    assert.ok(build.files.includes(file))
  }

  const resources = build.extraResources
  const backendTargets = resources.filter((item) => item.to?.startsWith('backend/'))
  for (const target of [
    'backend/api',
    'backend/core',
    'backend/services',
    'backend/assets',
    'backend/main.py',
    'backend/requirements.txt',
    'backend/pyproject.toml',
    'backend/config.example.json',
  ]) {
    assert.ok(backendTargets.some((item) => item.to === target), `missing ${target}`)
  }
  assert.ok(!resources.some((item) => item.from === '../backend' && !item.filter))

  const frontend = resources.find((item) => item.to === 'frontend/dist')
  assert.strictEqual(frontend.from, '../frontend/dist')
  const starter = resources.find((item) => item.to === 'start.py')
  assert.strictEqual(starter.from, '../start.py')

  assert.deepStrictEqual(build.win.target, ['nsis'])
  assert.strictEqual(build.nsis.oneClick, false)
  assert.strictEqual(build.nsis.perMachine, false)
})
