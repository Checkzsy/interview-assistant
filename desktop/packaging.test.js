const test = require('node:test')
const assert = require('node:assert')

test('desktop package defines a safe electron-builder layout', () => {
  const pkg = require('./package.json')
  assert.strictEqual(pkg.scripts.dist, 'npm run build:backend && electron-builder --win nsis --x64')
  assert.strictEqual(pkg.scripts['dist:dir'], 'npm run build:backend && electron-builder --win --x64 --dir')
  assert.ok(pkg.scripts['build:backend'])

  const build = pkg.build
  assert.ok(build)
  assert.strictEqual(build.appId, 'com.interviewassistant.desktop')
  assert.strictEqual(build.productName, 'Interview Assistant')
  assert.deepStrictEqual(build.directories, { output: 'dist' })
  for (const file of ['main.js', 'preload.js', 'runtimePaths.js']) {
    assert.ok(build.files.includes(file))
  }

  const resources = build.extraResources
  assert.ok(resources.some((item) => item.to === 'backend'))
  assert.ok(!resources.some((item) => item.from === '../backend' && !item.filter))

  const frontend = resources.find((item) => item.to === 'frontend/dist')
  assert.strictEqual(frontend.from, '../frontend/dist')
  const starter = resources.find((item) => item.to === 'start.py')
  assert.strictEqual(starter.from, '../start.py')

  assert.deepStrictEqual(build.win.target, ['nsis'])
  assert.strictEqual(build.nsis.oneClick, false)
  assert.strictEqual(build.nsis.perMachine, false)
})
