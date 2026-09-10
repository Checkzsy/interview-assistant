const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

test('main process wires runtime paths into backend startup', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
  assert.match(source, /require\('\.\/runtimePaths'\)/)
  assert.match(source, /resolveRuntimePaths\(\{/)
  assert.match(source, /buildBackendEnvironment\(RUNTIME_PATHS/)
  assert.match(source, /RUNTIME_PATHS\.startScript/)
})
