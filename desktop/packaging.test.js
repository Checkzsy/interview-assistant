const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

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
  for (const file of ['main.js', 'preload.js', 'runtimePaths.js', 'updater-notify.js']) {
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

test('NSIS installer lets the user pick the installation directory', () => {
  const pkg = require('./package.json')

  assert.strictEqual(pkg.build.nsis.allowToChangeInstallationDirectory, true)
  // Upgrade identity must not change, or the next installer creates a parallel
  // install and orphans the existing userData directory.
  assert.strictEqual(pkg.build.appId, 'com.interviewassistant.desktop')
  assert.strictEqual(pkg.build.productName, 'Interview Assistant')
  assert.strictEqual(pkg.build.nsis.oneClick, false)
  assert.strictEqual(pkg.build.nsis.perMachine, false)
})

test('backend build stages the bundled whisper model before PyInstaller', () => {
  const pkg = require('./package.json')
  const stageScript = pkg.scripts['bundle:whisper']
  const verifyScript = pkg.scripts['verify:whisper']
  const script = pkg.scripts['build:backend']

  assert.ok(stageScript, 'bundle:whisper script must exist')
  assert.match(stageScript, /bundle_whisper_base\.py"?\s+stage\s+--dest/)
  assert.match(stageScript, /backend\\assets\\whisper-base/)
  assert.ok(verifyScript, 'verify:whisper script must exist')
  assert.match(verifyScript, /verify-packaged/)

  const stageIndex = script.indexOf('npm run bundle:whisper')
  const pyinstallerIndex = script.indexOf('PyInstaller')
  const verifyIndex = script.indexOf('npm run verify:whisper')

  assert.ok(stageIndex >= 0, 'build:backend must stage the bundled whisper model')
  assert.ok(pyinstallerIndex > stageIndex, 'model staging must run before PyInstaller')
  assert.ok(verifyIndex > pyinstallerIndex, 'packaged output must be verified after PyInstaller')
  assert.match(script, /--add-data\s+"%CD%\\\.\.\\backend\\assets;assets"/)
})

test('both dist entry points cannot skip the model staging step', () => {
  const pkg = require('./package.json')
  for (const name of ['dist', 'dist:dir']) {
    assert.match(pkg.scripts[name], /^npm run build:backend && electron-builder /, `${name} must build the backend first`)
  }
  // The backend build is what stages and verifies the model, so both targets
  // inherit the guarantee from this shared pre-step.
  const build = pkg.scripts['build:backend']
  assert.ok(build.includes('npm run bundle:whisper'))
  assert.ok(build.includes('npm run verify:whisper'))
})

test('bundled model weights stay out of git', () => {
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8')
  const lines = ignore.split(/\r?\n/).map((line) => line.trim())
  assert.ok(
    lines.includes('backend/assets/whisper-base/'),
    '.gitignore must ignore the staged whisper model directory',
  )
})
