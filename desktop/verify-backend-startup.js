'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const READY_PREFIX = 'IA_BACKEND_READY ';

// Resolves with 'timeout' after `ms`. Used with Promise.race so a hang is caught,
// and unref'd so a successful race does not keep the process alive for the full
// timeout.
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms, 'timeout');
    timer.unref();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// The packaged backend must announce readiness while its parent still holds the
// stdin pipe open. A blocking read on that pipe stalls extension imports, so the
// marker never appears and the desktop shell reports a startup timeout.
async function verifyBackendStartup(options) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-backend-startup-'));
  try {
    return await runVerification({ ...options, workDir });
  } finally {
    // The child may still hold open handles for a moment after exit; a failed
    // cleanup must not turn a passing gate into a failed one.
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

async function runVerification({
  backendDir,
  command,
  workDir,
  timeoutMs = 60000,
  settleMs = 1500,
  graceMs = 25000,
}) {
  const exe = path.join(backendDir, 'backend.exe');
  if (!command && !fs.existsSync(exe)) throw new Error(`packaged backend is missing: ${exe}`);

  const launchId = `startup-gate-${process.pid}`;
  const child = spawn(command ? command[0] : exe, command ? command.slice(1) : [], {
    cwd: workDir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      IA_MANAGED_BACKEND: '1',
      IA_BACKEND_LAUNCH_ID: launchId,
      IA_AUTH_DISABLE: '1',
      IA_ACCESS_LOG: '0',
      IA_CONFIG_PATH: path.join(workDir, 'config.json'),
      IA_DATA_DIR: path.join(workDir, 'data'),
      PORT: String(await freePort()),
    },
  });

  const output = [];
  let ready = false;
  let markReady;
  const readySignal = new Promise((resolve) => { markReady = resolve; });

  // Electron only reads the readiness marker from stdout (main.js relays
  // child.stdout through backend.acceptMarker), so a marker on stderr does not
  // mean the desktop shell would ever see it.
  const collect = (stream, prefix, acceptsMarker) => {
    let pending = '';
    const handle = (text) => {
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        output.push(`${prefix}${line}`);
        if (acceptsMarker
          && line.startsWith(READY_PREFIX)
          && line.slice(READY_PREFIX.length).trim() === launchId) {
          ready = true;
          markReady();
        }
      }
    };
    stream.setEncoding('utf8');
    stream.on('data', handle);
    // A marker written without a trailing newline is still a line once the
    // stream ends (the backend always prints with \n; this is a safety net).
    stream.on('end', () => { if (pending) handle('\n'); });
  };
  collect(child.stdout, '', true);
  collect(child.stderr, '[err] ', false);

  // The child may close first; an EPIPE on our side is then expected and the
  // exit status below is what decides the outcome.
  child.stdin.on('error', () => {});
  const exited = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, signal: null, error }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const outcome = await Promise.race([readySignal.then(() => 'ready'), exited, delay(timeoutMs)]);

  if (outcome !== 'ready' || !ready) {
    child.kill();
    await exited;
    throw new Error(
      `packaged backend never announced readiness within ${timeoutMs}ms while stdin stayed open.`
      + `\n${output.slice(-40).join('\n')}`,
    );
  }

  // Readiness alone is not enough: a backend that prints the marker and dies
  // immediately would still fail for the user. Requiring the process to outlive
  // a short window rules out that specific false green. It does not prove the
  // server keeps answering requests, and it cannot distinguish "exited because
  // stdin closed" from "exited on an unrelated timer" - it only guarantees the
  // process was still running at the moment stdin was closed.
  const settled = await Promise.race([delay(settleMs).then(() => 'alive'), exited]);
  if (settled !== 'alive') {
    throw new Error('packaged backend exited right after announcing readiness; '
      + 'it must keep serving until its parent goes away'
      + `\n${output.slice(-40).join('\n')}`);
  }

  // Closing stdin is the last thing the gate does, so an exit observed from
  // here on is the expected parent-loss path being exercised end to end.
  child.stdin.end();
  const shutdown = await Promise.race([exited, delay(graceMs).then(() => 'timeout')]);
  if (shutdown === 'timeout') {
    child.kill();
    await exited;
    throw new Error(`packaged backend did not exit within ${graceMs}ms of stdin EOF`);
  }
  if (shutdown.error || shutdown.code !== 0) {
    throw new Error(`packaged backend exited abnormally after stdin EOF: ${JSON.stringify(shutdown)}\n`
      + output.slice(-40).join('\n'));
  }
  return { launchId };
}

function parseArgs(argv) {
  const args = { backendDir: path.join(__dirname, 'build', 'backend'), timeoutMs: 60000 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--backend') args.backendDir = path.resolve(argv[index += 1]);
    else if (argv[index] === '--timeout') args.timeoutMs = Number(argv[index += 1]);
  }
  return args;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  verifyBackendStartup(options)
    .then(() => {
      console.log(`Packaged backend startup OK: ${path.join(options.backendDir, 'backend.exe')} `
        + 'announced readiness on stdout while stdin stayed open and exited 0 once stdin closed');
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = { verifyBackendStartup };
