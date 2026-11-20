'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { extractAll } = require('@electron/asar');
const projectPackage = require('./package.json');

function verifyPackagedApp({ archive, version }) {
  if (!version) throw new Error('--version is required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-packaged-app-verify-'));
  try {
    extractAll(archive, root);
    const manifestPath = path.join(root, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (pkg.version !== version) throw new Error(`archive version ${pkg.version} does not match release version ${version}`);
    if (pkg.main !== 'bootstrap.js') throw new Error('packaged main must be bootstrap.js');
    for (const file of projectPackage.build.files.filter((file) => file.endsWith('.js'))) {
      if (!fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`packaged runtime file is missing: ${file}`);
      }
    }

    const seen = new Set();
    function visit(issuer, name) {
      const entry = createRequire(issuer).resolve(name);
      const relative = path.relative(root, fs.realpathSync(entry));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`packaged dependency ${name} resolved outside the archive`);
      }
      let directory = path.dirname(entry);
      let dependencyPath;
      let dependency;
      while (directory !== root && directory.startsWith(`${root}${path.sep}`)) {
        const candidate = path.join(directory, 'package.json');
        if (fs.existsSync(candidate)) {
          const value = JSON.parse(fs.readFileSync(candidate, 'utf8'));
          if (value.name === name) {
            dependencyPath = candidate;
            dependency = value;
            break;
          }
        }
        directory = path.dirname(directory);
      }
      if (!dependency) throw new Error(`packaged dependency manifest is missing: ${name}`);
      if (name === 'electron-updater' && dependency.version !== projectPackage.dependencies[name]) {
        throw new Error(`electron-updater version ${dependency.version} does not match ${projectPackage.dependencies[name]}`);
      }
      if (seen.has(dependencyPath)) return;
      seen.add(dependencyPath);
      for (const child of Object.keys(dependency.dependencies || {})) visit(dependencyPath, child);
    }

    // Check the trusted runtime requirements even if an incomplete archive drops
    // its dependencies field. Resolution never executes package or application code.
    for (const name of Object.keys({ ...pkg.dependencies, ...projectPackage.dependencies })) visit(manifestPath, name);
    return { version: pkg.version, dependencies: seen.size };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const versionIndex = args.indexOf('--version');
    const archiveIndex = args.indexOf('--asar');
    const result = verifyPackagedApp({
      archive: archiveIndex < 0 ? path.join(__dirname, 'dist', 'win-unpacked', 'resources', 'app.asar') : path.resolve(args[archiveIndex + 1]),
      version: versionIndex < 0 ? null : args[versionIndex + 1],
    });
    console.log(`Packaged app OK: ${result.version}, ${result.dependencies} production dependencies`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyPackagedApp };
