const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

test('main process prefers packaged backend executable when available', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
  assert.match(source, /RUNTIME_PATHS\.backendExecutable/)
  assert.match(source, /backendExecutable && fs\.existsSync\(RUNTIME_PATHS\.backendExecutable\)/)
  assert.match(source, /RUNTIME_PATHS\.startScript/)
})
