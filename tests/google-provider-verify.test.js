'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { main } = require('../scripts/sandbox/google-provider-verify.cjs');
const { providerReport, verifyProvider } = require('../scripts/sandbox/google-provider-verify-child.cjs');

const expectedEmail = 'fixture-isolated@fixture-project.iam.gserviceaccount.com';
const secret = 'fixture-access-token-never-report';
const oauthUrl = 'https://oauth2.googleapis.com/token';
const aboutUrl = 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)';

function fixture(overrides = {}) {
  const calls = [];
  const auth = {
    readServiceAccount(profile) {
      assert.equal(profile, 'sandbox-integrator-google');
      return { client_email: overrides.accountEmail ?? expectedEmail };
    },
    async getAccessToken() {
      if (overrides.skipOAuth) return secret;
      const response = await global.fetch(overrides.extraEndpoint ?? oauthUrl, { method: 'POST', body: 'fixture-jwt-never-report' });
      return (await response.json()).access_token;
    },
  };
  const fetchImpl = async (input, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    calls.push(String(input));
    if (overrides.transportError) throw new Error(secret);
    if (overrides.oversized) return new Response('x'.repeat(65537));
    if (overrides.malformed) return new Response(`<html>${secret}</html>`);
    const oauth = String(input) === oauthUrl;
    if (!oauth) assert.equal(options.headers.authorization, `Bearer ${secret}`);
    return Response.json(oauth ? { access_token: secret } : { user: { emailAddress: overrides.aboutEmail ?? expectedEmail } },
      { status: overrides.status ?? 200 });
  };
  return { auth, fetchImpl, calls };
}

test('verifies only fresh OAuth and Drive about for the exact isolated account, without leaking credentials', async () => {
  const mock = fixture();
  const originalFetch = global.fetch;
  const report = await verifyProvider({ expectedEmail, ...mock });
  assert.equal(report.passed, true);
  assert.equal(report.exactAccountVerified, true);
  assert.equal(report.providerOnly, true);
  assert.equal(report.googleSheetsAcceptance, false);
  assert.equal(report.realGoogleArtifactCalls, 0);
  assert.equal(report.credentialReadyEventSent, false);
  assert.equal(report.credentialsForwardedToEngine, false);
  assert.deepEqual(mock.calls, [oauthUrl, aboutUrl]);
  assert.deepEqual(report.calls, [{ endpoint: 'oauth_token', status: 200 }, { endpoint: 'drive_about', status: 200 }]);
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.equal(global.fetch, originalFetch);
});

for (const [name, overrides, reason] of [
  ['wrong mounted account', { accountEmail: 'other@fixture-project.iam.gserviceaccount.com' }, 'isolated_account_mismatch'],
  ['wrong provider account', { aboutEmail: 'other@fixture-project.iam.gserviceaccount.com' }, 'provider_account_mismatch'],
  ['cached token without fresh OAuth', { skipOAuth: true }, 'oauth_token_response_invalid'],
  ['unexpected artifact endpoint', { extraEndpoint: 'https://www.googleapis.com/drive/v3/files' }, 'unexpected_provider_request'],
  ['redirect response', { status: 302 }, 'oauth_token_response_invalid'],
  ['provider transport error', { transportError: true }, 'oauth_token_transport'],
  ['oversized body', { oversized: true }, 'oauth_token_response_invalid'],
  ['malformed JSON', { malformed: true }, 'oauth_token_response_invalid'],
]) test(`refuses ${name} with provider-only sanitized evidence`, async () => {
  const mock = fixture(overrides);
  const report = await verifyProvider({ expectedEmail, ...mock });
  assert.equal(report.passed, false);
  assert.equal(report.reason, reason);
  assert.equal(report.realGoogleArtifactCalls, 0);
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(mock.calls.every(url => [oauthUrl, aboutUrl].includes(url)));
});

test('parent launches fresh auth child with only childEnvironment and never forwards raw child output', () => {
  const env = { AGENT_DATA_DIR: '/private/fixture/work', USER_ID: 'sandbox-integrator-google', CRED_ENCRYPTION_KEY: 'fixture-key-never-report' };
  let spawned = 0;
  const report = main(['--runtime', '/private/fixture', '--expected-sa-email', expectedEmail], {
    childEnvironment(runtime, probe) {
      assert.equal(runtime, '/private/fixture');
      assert.equal(probe, false);
      return env;
    },
    execFileSync(command, args, options) {
      spawned++;
      assert.equal(command, process.execPath);
      assert.equal(path.basename(args[0]), 'google-provider-verify-child.cjs');
      assert.equal(args[1], expectedEmail);
      assert.equal(options.env, env);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(options.timeout, 35000);
      assert.equal(options.maxBuffer, 65536);
      const child = providerReport(true, expectedEmail, [{ endpoint: 'oauth_token', status: 200 }, { endpoint: 'drive_about', status: 200 }]);
      child.privateKey = secret;
      child.calls[0].body = secret;
      return Buffer.from(JSON.stringify(child));
    },
  });
  assert.equal(spawned, 1);
  assert.equal(report.passed, true);
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(!JSON.stringify(report).includes(env.CRED_ENCRYPTION_KEY));
});

test('parent rejects strong success without both provider 200 receipts', () => {
  const report = main(['--runtime', '/private/fixture', '--expected-sa-email', expectedEmail], {
    childEnvironment: () => ({ AGENT_DATA_DIR: '/private/fixture/work' }),
    execFileSync: () => Buffer.from(JSON.stringify(providerReport(true, expectedEmail))),
  });
  assert.equal(report.passed, false);
  assert.equal(report.reason, 'provider_verification_failed');
});

test('unsafe arguments and child failures emit no secrets; CLI refuses before credential reads', () => {
  const dependencies = { childEnvironment: () => { throw new Error(secret); } };
  const unsafe = main(['--runtime', 'relative', '--expected-sa-email', expectedEmail], dependencies);
  assert.equal(unsafe.reason, 'invalid_configuration');
  const runtimeFailure = main(['--runtime', '/private/fixture', '--expected-sa-email', expectedEmail], dependencies);
  assert.equal(runtimeFailure.reason, 'invalid_runtime_binding');
  assert.ok(!JSON.stringify(runtimeFailure).includes(secret));
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/sandbox/google-provider-verify.cjs'),
    '--runtime', '/private/not-read', '--expected-sa-email', 'invalid'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).reason, 'invalid_configuration');
});
