'use strict';
// Drive SA key lives at <AGENT_TOKENS_DIR>/<profile>/gdrive (mode 0600), and the
// JWT it signs verifies with the SA's public key.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tokens = fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-'));
process.env.AGENT_TOKENS_DIR = tokens;
const auth = require('../src/gdrive/google-auth');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { client_email: 'u-abcd@trained-assist-gdrive-sa.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };

test('write/read round-trip under AGENT_TOKENS_DIR with mode 0600', () => {
  auth.writeServiceAccount('alice', sa);
  const file = path.join(tokens, 'alice', 'gdrive');
  assert.equal(auth.saKeyPath('alice'), file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(auth.readServiceAccount('alice'), sa);
  assert.equal(auth.getSaEmail('alice'), sa.client_email);
});

test('missing, broken or incomplete key → null', () => {
  assert.equal(auth.readServiceAccount('nobody'), null);
  assert.equal(auth.readServiceAccount(''), null);
  fs.mkdirSync(path.join(tokens, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(tokens, 'broken', 'gdrive'), '{not json');
  assert.equal(auth.readServiceAccount('broken'), null);
  fs.mkdirSync(path.join(tokens, 'partial'), { recursive: true });
  fs.writeFileSync(path.join(tokens, 'partial', 'gdrive'), JSON.stringify({ client_email: 'x' }));
  assert.equal(auth.readServiceAccount('partial'), null);
});

test('JWT is RS256-signed by the SA key and carries drive scope', () => {
  const [h, p, s] = auth.makeJwt(sa, 1000).split('.');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')));
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(payload.iss, sa.client_email);
  assert.equal(payload.exp, 4600);
  assert.match(payload.scope, /auth\/drive(\s|$)/);
});

test('deleteServiceAccount without a key does not call GCP', async () => {
  assert.deepEqual(await auth.deleteServiceAccount('nobody'), { deleted: false, reason: 'no_sa_configured' });
});
