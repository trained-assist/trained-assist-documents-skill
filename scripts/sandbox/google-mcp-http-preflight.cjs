'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');

async function main() {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'google-http-preflight-'));
  fs.chmodSync(runtime, 0o700);
  let host;
  let domainExited = false;
  let networkGuardActive = false;
  let blockedNetworkAttempts = 0;
  const evidence = [];
  const stdioHost = require('./google-mcp-host.cjs');
  const originalSpawn = stdioHost.spawnDomain;
  try {
    for (const directory of ['home', 'work', 'tokens', 'tokens/sandbox-integrator-google']) {
      fs.mkdirSync(path.join(runtime, directory), { mode: 0o700 });
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(path.join(runtime, '.host-encryption-key'), key.toString('hex'), { mode: 0o600 });
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({
      client_email: 'synthetic-preflight@invalid.example', private_key: 'synthetic-not-a-valid-google-key',
    })), cipher.final()]);
    fs.writeFileSync(path.join(runtime, 'tokens/sandbox-integrator-google/gdrive'),
      Buffer.concat([Buffer.from([2]), iv, cipher.getAuthTag(), ciphertext]).toString('base64'), { mode: 0o600 });
    stdioHost.spawnDomain = env => {
      assert.equal(env.USER_ID, 'sandbox-integrator-google');
      assert.equal(env.GOOGLE_MCP_ACTOR_PROFILE, 'integration-v1');
      for (const name of ['GOOGLE_DOCUMENTS_MCP_TOKEN', 'GDRIVE_SA_JSON', 'GOOGLE_APPLICATION_CREDENTIALS', 'AGENT_SECRET', 'OPENAI_API_KEY']) {
        assert.equal(env[name], undefined);
      }
      const child = originalSpawn(env, true);
      child.on('message', message => {
        if (message?.networkGuardActive === true) networkGuardActive = true;
        if (message?.blockedNetworkAttempt === true) blockedNetworkAttempts++;
      });
      child.once('close', () => { domainExited = true; });
      return child;
    };
    const { mintBinding, readBinding, createHttpHost } = require('./google-mcp-http.cjs');
    const runId = `run_${crypto.randomUUID()}`;
    const userTaskId = 'preflight-google-task';
    mintBinding({ runtime, runId, userTaskId, expectedActorProfile: 'integration-v1',
      credentialProfile: 'sandbox-integrator-google', expiresAt: new Date(Date.now() + 300000).toISOString() });
    const { authToken } = readBinding(runtime);
    host = await createHttpHost({ runtime });
    assert.equal(host.isReady(), true);
    const url = `http://127.0.0.1:${host.server.address().port}/mcp`;
    const headers = { Authorization: `Bearer ${authToken}`, 'X-MCP-Profile': 'integration-v1',
      'X-MCP-Run-Id': runId, 'X-MCP-User-Task-Id': userTaskId,
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    let sequence = 0;
    async function probe(name, expectedStatus, expectedError, method, params, overrides = {}) {
      const requestHeaders = { ...headers, ...overrides };
      for (const keyName of Object.keys(requestHeaders)) if (requestHeaders[keyName] === null) delete requestHeaders[keyName];
      const response = await fetch(url, { method: 'POST', headers: requestHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) });
      const text = await response.text();
      assert.ok(!text.includes(authToken));
      assert.doesNotMatch(text, /synthetic-preflight@|synthetic-not-a-valid-google-key|CRED_ENCRYPTION_KEY/);
      const body = JSON.parse(text);
      const error = typeof body.error === 'string' ? body.error : body.error?.message;
      assert.equal(response.status, expectedStatus);
      assert.equal(error, expectedError);
      evidence.push({ probe: name, httpStatus: response.status, ...(error ? { refusal: error } : {}) });
      return body;
    }
    await probe('no_bearer', 401, 'AUTH_REQUIRED', 'tools/list', {}, { Authorization: null });
    await probe('wrong_actor', 403, 'SCOPE_DENIED', 'tools/list', {}, { 'X-MCP-Profile': 'sandbox-integrator-google' });
    await probe('wrong_run', 403, 'SCOPE_DENIED', 'tools/list', {}, { 'X-MCP-Run-Id': `run_${crypto.randomUUID()}` });
    await probe('wrong_task', 403, 'SCOPE_DENIED', 'tools/list', {}, { 'X-MCP-User-Task-Id': 'other-preflight-task' });
    await probe('origin', 403, 'ORIGIN_DENIED', 'tools/list', {}, { Origin: 'https://preflight.invalid' });
    const initialized = await probe('initialize', 200, undefined, 'initialize', { protocolVersion: '2025-11-25' });
    assert.equal(initialized.result.protocolVersion, '2025-11-25');
    const listed = await probe('authenticated_tools_list', 200, undefined, 'tools/list', {});
    const toolNames = listed.result.tools.map(tool => tool.name).sort();
    assert.deepEqual(toolNames, ['gdrive_create_spreadsheet', 'gdrive_read_sheet', 'gdrive_write_sheet']);
    await probe('missing_owner_target', 200, 'OWNER_TARGET_REQUIRED', 'tools/call', { name: 'gdrive_read_sheet', arguments: {} });
    fs.writeFileSync(path.join(runtime, 'owner-target.json'), JSON.stringify({
      profile: 'integration-v1', userTaskId, runId, ownerApproved: true,
      spreadsheetId: 'synthetic-approved-sheet', folderId: 'synthetic-approved-folder',
    }), { mode: 0o600 });
    for (const name of toolNames) {
      await probe(`wrong_target:${name}`, 200, 'TARGET_NOT_APPROVED', 'tools/call', {
        name, arguments: { spreadsheet_id: 'synthetic-unapproved-sheet', folder_id: 'synthetic-unapproved-folder', sheet_name: 'Expenses' },
      });
    }
    await host.close();
    assert.equal(host.isReady(), false);
    assert.equal(host.server.listening, false);
    host = null;
    assert.equal(domainExited, true);
    assert.equal(networkGuardActive, true);
    assert.equal(blockedNetworkAttempts, 0);
    fs.rmSync(runtime, { recursive: true });
    process.stdout.write(JSON.stringify({ passed: true, realHttpSocket: true, realStdioChild: true,
      syntheticCredentialsOnly: true, actorProfile: 'integration-v1', credentialProfile: 'sandbox-integrator-google',
      canonicalRunFormat: 'run_<UUID>', toolNames, probes: evidence, networkGuardActive, blockedNetworkAttempts,
      domainExited, ephemeralRuntimeRemoved: !fs.existsSync(runtime) }) + '\n');
  } finally {
    stdioHost.spawnDomain = originalSpawn;
    if (host) await host.close();
    fs.rmSync(runtime, { recursive: true, force: true });
  }
}

main().catch(() => {
  process.stderr.write('Synthetic HTTP preflight failed; no private output disclosed.\n');
  process.exitCode = 1;
});
