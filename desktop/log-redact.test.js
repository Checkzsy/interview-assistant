'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');

const {
  createConsoleRedactor,
  createRedactingLogger,
  redactText,
} = require('./log-redact');

const SECRET = 'test-bearer-k8m3q1';

test('redactText masks the documented credential forms', () => {
  const cases = [
    [`Authorization: Bearer ${SECRET}`, 'Authorization: Bearer ***'],
    [`authorization='Basic ${SECRET}'`, "authorization='Basic ***'"],
    [`X-Api-Key: ${SECRET}`, 'X-Api-Key: ***'],
    [`X-Api-Access-Key=${SECRET}`, 'X-Api-Access-Key=***'],
    [`GET /path?token=${SECRET}&top_k=5 HTTP/1.1`, 'GET /path?token=***&top_k=5 HTTP/1.1'],
    [`/path?access_token=${SECRET}`, '/path?access_token=***'],
    [`/path?api_key=${SECRET}&y=1`, '/path?api_key=***&y=1'],
    [`{"api_key": "${SECRET}"}`, '{"api_key": "***"}'],
    [`api_key=${SECRET} user=sample`, 'api_key=*** user=sample'],
    [`token: ${SECRET}`, 'token: ***'],
    [
      `postgres://test-user:${SECRET}@db.local:5432/app`,
      'postgres://***@db.local:5432/app',
    ],
    ['max_tokens=1000 processed 3 tokens', 'max_tokens=1000 processed 3 tokens'],
  ];

  for (const [input, expected] of cases) {
    assert.equal(redactText(input), expected);
    assert.equal(redactText(redactText(input)), expected);
  }
});

test('redactText leaves plain text and non-string values untouched', () => {
  assert.equal(redactText('plain log line'), 'plain log line');
  assert.equal(redactText(''), '');
  assert.equal(redactText(undefined), undefined);
  assert.equal(redactText(null), null);
});

test('createConsoleRedactor formats like console then redacts and forwards one string', () => {
  const forwarded = [];
  const original = { calls: 0 };
  const fakeConsole = {
    log(...args) {
      original.calls += 1;
      forwarded.push(args);
    },
    info() {},
    warn() {},
    error(...args) {
      original.calls += 1;
      forwarded.push(args);
    },
    debug() {},
  };

  const redactor = createConsoleRedactor({ target: fakeConsole });

  fakeConsole.log('request %s failed', `/api?token=${SECRET}`);
  const failure = new Error(`Authorization: Bearer ${SECRET}`);
  fakeConsole.error('boom', failure);

  assert.equal(forwarded.length, 2, 'each call must reach the original console once');
  assert.equal(typeof forwarded[0][0], 'string', 'console args must become one formatted string');
  assert.equal(forwarded[0][0], 'request /api?token=*** failed');
  assert.equal(typeof forwarded[1][0], 'string');
  assert.match(forwarded[1][0], /boom Error: Authorization: Bearer \*\*\*/);
  assert.match(forwarded[1][0], /log-redact\.test\.js/, 'Error.stack must be preserved');
  assert.ok(!forwarded[1][0].includes(SECRET), 'secret must not reach the console');

  redactor.uninstall();
  fakeConsole.log('after uninstall', { token: SECRET });
  assert.equal(forwarded[2].length, 2, 'uninstall must restore the original console method');
  assert.equal(forwarded[2][1].token, SECRET);
});

test('console redaction never falls back to raw arguments when formatting fails', () => {
  const forwarded = [];
  const fakeConsole = {
    log(...args) {
      forwarded.push(args);
    },
  };
  const redactor = createConsoleRedactor({ target: fakeConsole });

  const hostile = {
    [util.inspect.custom]() {
      throw new Error(`cannot inspect ${SECRET}`);
    },
  };

  assert.doesNotThrow(() => fakeConsole.log(hostile));
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0][0], '[log formatting failed; message dropped]');
  assert.ok(!JSON.stringify(forwarded).includes(SECRET));

  redactor.uninstall();
});

test('console redaction swallows write failures and still uses fixed text', () => {
  const seen = [];
  const fakeConsole = {
    error() {
      seen.push('called');
      throw new Error('stdout closed');
    },
  };
  const redactor = createConsoleRedactor({ target: fakeConsole });

  assert.doesNotThrow(() => fakeConsole.error(`token=${SECRET}`));
  assert.deepEqual(seen, ['called']);

  redactor.uninstall();
});

test('redacting logger exposes the four console levels with redacted strings', () => {
  const writes = [];
  const logger = createRedactingLogger({
    sink: (level, text) => writes.push([level, text]),
  });

  logger.info('loaded %s', 'module');
  logger.warn(`X-Api-Key: ${SECRET}`);
  logger.error(new Error(`token=${SECRET}`));
  logger.debug('debug');

  assert.equal(writes.length, 4);
  assert.deepEqual(writes[0], ['info', 'loaded module']);
  assert.deepEqual(writes[1], ['warn', 'X-Api-Key: ***']);
  assert.match(writes[2][1], /Error: token=\*\*\*/);
  assert.deepEqual(writes[3], ['debug', 'debug']);
  assert.ok(!JSON.stringify(writes).includes(SECRET));
});
