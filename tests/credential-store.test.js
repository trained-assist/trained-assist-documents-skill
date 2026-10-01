'use strict';
// trained-assist-agent#1939 (C4 rollout шаг 1): the per-profile Drive Service
// Account key (<AGENT_TOKENS_DIR>/<profile>/gdrive) is read and written through
// credential-store, not raw fs — used by both gdrive_* (src/mcp-skills/tools/
// 50-gdrive.js) and the Drive watcher, which share these helpers.
//
// Contract (epic #1789 P0 C4, #1819):
//   - legacy plaintext files pass through transparently;
//   - an encrypted (v2 base64 envelope) file is decrypted;
//   - a base64 stub is NEVER returned as the SA JSON;
//   - a missing CRED_ENCRYPTION_KEY degrades to plaintext WITH a warning —
//     never a hard failure.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/credential-store');

const MASTER_KEY = 'b'.repeat(64); // valid 64-hex → 32-byte AES-256 key
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = {
  client_email: 'u-cred@test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdrive-cred-'));
  const saved = { tokens: process.env.AGENT_TOKENS_DIR, key: process.env.CRED_ENCRYPTION_KEY };
  process.env.AGENT_TOKENS_DIR = root;
  delete process.env.CRED_ENCRYPTION_KEY;
  store._resetMasterKey();
  const auth = require('../src/gdrive/google-auth');
  t.after(() => {
    if (saved.tokens === undefined) delete process.env.AGENT_TOKENS_DIR;
    else process.env.AGENT_TOKENS_DIR = saved.tokens;
    if (saved.key === undefined) delete process.env.CRED_ENCRYPTION_KEY;
    else process.env.CRED_ENCRYPTION_KEY = saved.key;
    store._resetMasterKey();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, auth, file: path.join(root, 'alice', 'gdrive') };
}

function captureWarn(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try { return { result: fn(), warnings }; }
  finally { console.warn = original; }
}

test('legacy plaintext SA key reads through unchanged (no CRED_ENCRYPTION_KEY)', (t) => {
  const h = sandbox(t);
  fs.mkdirSync(path.dirname(h.file), { recursive: true });
  fs.writeFileSync(h.file, JSON.stringify(sa), 'utf8');

  assert.deepEqual(h.auth.readServiceAccount('alice'), sa);
  assert.equal(h.auth.getSaEmail('alice'), sa.client_email);
});

test('missing CRED_ENCRYPTION_KEY → plaintext write with a warning, never a failure', (t) => {
  const h = sandbox(t);
  const { warnings } = captureWarn(() => h.auth.writeServiceAccount('alice', sa));

  assert.equal(fs.readFileSync(h.file, 'utf8'), JSON.stringify(sa), 'stored plaintext without a key');
  assert.ok(warnings.some(w => /PLAINTEXT/.test(w)), `expected a plaintext warning, got: ${warnings.join(' | ')}`);
  assert.equal(fs.statSync(h.file).mode & 0o777, 0o600, 'credential file must stay 0o600');
  assert.deepEqual(h.auth.readServiceAccount('alice'), sa);
});

test('double read: with a key the SA file is encrypted at rest and still reads back', (t) => {
  const h = sandbox(t);
  process.env.CRED_ENCRYPTION_KEY = MASTER_KEY;
  store._resetMasterKey();

  captureWarn(() => h.auth.writeServiceAccount('alice', sa));

  const raw = fs.readFileSync(h.file, 'utf8');
  assert.notEqual(raw, JSON.stringify(sa), 'at rest the file must not hold the SA JSON');
  assert.ok(store.isEncrypted(raw), 'at rest the file must be a v2 envelope');
  assert.equal(fs.statSync(h.file).mode & 0o777, 0o600, 'credential file must stay 0o600');

  assert.deepEqual(h.auth.readServiceAccount('alice'), sa, 'the same read through the store');
  assert.equal(h.auth.getSaEmail('alice'), sa.client_email);
});

test('legacy plaintext still reads through once a key IS set', (t) => {
  const h = sandbox(t);
  fs.mkdirSync(path.dirname(h.file), { recursive: true });
  fs.writeFileSync(h.file, JSON.stringify(sa), 'utf8');

  process.env.CRED_ENCRYPTION_KEY = MASTER_KEY;
  store._resetMasterKey();

  assert.deepEqual(h.auth.readServiceAccount('alice'), sa);
});

test('a base64 stub is never returned as the SA JSON', (t) => {
  const h = sandbox(t);
  process.env.CRED_ENCRYPTION_KEY = MASTER_KEY;
  store._resetMasterKey();
  captureWarn(() => h.auth.writeServiceAccount('alice', sa));

  const blob = fs.readFileSync(h.file, 'utf8');
  assert.ok(store.isEncrypted(blob), 'precondition: the file on disk is a base64 stub');

  // Key withdrawn: the stub must not reach the caller as if it were the SA key.
  delete process.env.CRED_ENCRYPTION_KEY;
  store._resetMasterKey();

  assert.throws(() => store.readCredentialFile(h.file),
    /CRED_ENCRYPTION_KEY/, 'store-level: loud, no base64 garbage');
  assert.equal(h.auth.readServiceAccount('alice'), null,
    'reader-level: degrades to "no SA configured", never the stub');
  assert.equal(h.auth.getSaEmail('alice'), null);
});

test('missing, broken or incomplete key still → null (and reading creates nothing)', (t) => {
  const h = sandbox(t);
  assert.equal(h.auth.readServiceAccount('nobody'), null);
  assert.ok(!fs.existsSync(path.join(h.root, 'nobody')), 'reading must not create a profile dir');

  fs.mkdirSync(path.join(h.root, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(h.root, 'broken', 'gdrive'), '{not json', 'utf8');
  assert.equal(h.auth.readServiceAccount('broken'), null);
});
