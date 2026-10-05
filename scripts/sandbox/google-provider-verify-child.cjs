'use strict';

const oauthUrl = 'https://oauth2.googleapis.com/token';
const aboutUrl = 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)';
const expectedAccount = value => typeof value === 'string' && value.length <= 254 && /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(value);

function providerReport(passed, expectedEmail, calls = [], reason) {
  return { schemaVersion: 'google-provider-verification-v1', providerOnly: true, passed,
    exactAccountVerified: passed, ...(expectedAccount(expectedEmail) ? { expectedSaEmail: expectedEmail } : {}),
    verifiedAt: new Date().toISOString(), calls, ...(reason ? { reason } : {}),
    realGoogleArtifactCalls: 0, credentialsForwardedToEngine: false, credentialReadyEventSent: false,
    googleSheetsAcceptance: false };
}

async function boundedJson(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_PROVIDER_RESPONSE');
        return body;
      }
      size += chunk.value.byteLength;
      if (size > 65536) throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

async function verifyProvider({ expectedEmail, auth, fetchImpl = global.fetch }) {
  const calls = [];
  const originalFetch = global.fetch;
  let phase = 'invalid_expected_account';
  try {
    if (!expectedAccount(expectedEmail)) throw new Error('INVALID_EXPECTED_ACCOUNT');
    phase = 'isolated_account_mismatch';
    const account = auth.readServiceAccount('sandbox-integrator-google');
    if (!account || account.client_email !== expectedEmail) throw new Error('ACCOUNT_MISMATCH');
    global.fetch = async (input, options = {}) => {
      const url = String(input);
      const endpoint = url === oauthUrl ? 'oauth_token' : url === aboutUrl ? 'drive_about' : null;
      if (!endpoint || (calls.length === 0 ? endpoint !== 'oauth_token' : calls.length !== 1 || endpoint !== 'drive_about')
        || (options.method ?? 'GET') !== (endpoint === 'oauth_token' ? 'POST' : 'GET')) {
        phase = 'unexpected_provider_request';
        throw new Error('UNEXPECTED_PROVIDER_REQUEST');
      }
      phase = `${endpoint}_transport`;
      const response = await fetchImpl(input, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
      calls.push({ endpoint, status: response.status });
      phase = `${endpoint}_response_invalid`;
      if (response.status !== 200) throw new Error('PROVIDER_STATUS_INVALID');
      const body = await boundedJson(response);
      return Response.json(body);
    };
    phase = 'oauth_token_response_invalid';
    const token = await auth.getAccessToken(account);
    if (typeof token !== 'string' || !token || calls.length !== 1 || calls[0].status !== 200) throw new Error('FRESH_TOKEN_REQUIRED');
    const response = await global.fetch(aboutUrl, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json();
    phase = 'provider_account_mismatch';
    if (body.user?.emailAddress !== expectedEmail || calls.length !== 2) throw new Error('ACCOUNT_MISMATCH');
    return providerReport(true, expectedEmail, calls);
  } catch {
    return providerReport(false, expectedEmail, calls, phase);
  } finally { global.fetch = originalFetch; }
}

module.exports = { expectedAccount, providerReport, verifyProvider };
if (require.main === module) {
  (async () => {
    const expectedEmail = process.argv[2];
    if (process.env.USER_ID !== 'sandbox-integrator-google' || !expectedAccount(expectedEmail)) {
      return providerReport(false, expectedEmail, [], 'invalid_child_context');
    }
    const auth = require('../../src/gdrive/google-auth.js');
    return verifyProvider({ expectedEmail, auth });
  })().then(report => process.stdout.write(JSON.stringify(report) + '\n')).catch(() => {
    process.stdout.write(JSON.stringify(providerReport(false, undefined, [], 'provider_verification_failed')) + '\n');
  });
}
