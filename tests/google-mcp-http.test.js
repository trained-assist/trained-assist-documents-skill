'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHttpHost, mintBinding, readBinding, registeredDomainEnvironment, stdioRpc } = require('../scripts/sandbox/google-mcp-http.cjs');
const runId = `run_${crypto.randomUUID()}`;
const userTaskId = 'ut-test-google';
const profile = 'integration-v1';
const credentialProfile = 'sandbox-integrator-google';

function runtimeFixture(context) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'google-http-test-'));
  fs.chmodSync(runtime, 0o700);
  for (const directory of ['home', 'work', 'tokens', 'tokens/sandbox-integrator-google']) {
    fs.mkdirSync(path.join(runtime, directory), { mode: 0o700 });
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(runtime, '.host-encryption-key'), key.toString('hex'), { mode: 0o600 });
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const raw = JSON.stringify({ client_email: 'synthetic@test.invalid', private_key: 'synthetic-private-key-never-wire' });
  const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
  fs.writeFileSync(path.join(runtime, 'tokens/sandbox-integrator-google/gdrive'),
    Buffer.concat([Buffer.from([2]), iv, cipher.getAuthTag(), encrypted]).toString('base64'), { mode: 0o600 });
  context.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  return runtime;
}

async function hostFixture(context) {
  const runtime = runtimeFixture(context);
  mintBinding({ runtime, runId, userTaskId, expectedActorProfile: profile, credentialProfile, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const binding = readBinding(runtime);
  const host = await createHttpHost({ runtime });
  context.after(() => host.close());
  const url = `http://127.0.0.1:${host.server.address().port}/mcp`;
  const headers = { Authorization: `Bearer ${binding.authToken}`, 'X-MCP-Run-Id': runId,
    'X-MCP-User-Task-Id': userTaskId, 'X-MCP-Profile': profile,
    Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  async function post(message, extra = {}) {
    const response = await fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(message) });
    const body = await response.text();
    assert.doesNotMatch(body, /synthetic-private-key|synthetic@test|CRED_ENCRYPTION_KEY/);
    assert.ok(!body.includes(binding.authToken));
    return { status: response.status, body: body ? JSON.parse(body) : null };
  }
  return { runtime, binding, host, url, headers, post };
}

test('host-only mint returns metadata, persists a private opaque token and refuses reuse', context => {
  const runtime = runtimeFixture(context);
  const inputs = { runtime, runId, userTaskId, expectedActorProfile: profile, credentialProfile, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  assert.deepEqual(mintBinding(inputs), { runId, userTaskId, profile, credentialProfile, expiresAt: inputs.expiresAt });
  const binding = readBinding(runtime);
  assert.equal(binding.authToken.length, 43);
  assert.equal(fs.statSync(path.join(runtime, 'http-binding.json')).mode & 0o777, 0o600);
  assert.throws(() => mintBinding(inputs), /EEXIST/);
  assert.throws(() => mintBinding({ ...inputs, expectedActorProfile: 'real-user' }), /INVALID_HTTP_BINDING/);
  assert.throws(() => mintBinding({ ...inputs, expectedActorProfile: credentialProfile }), /INVALID_HTTP_BINDING/);
  assert.throws(() => mintBinding({ ...inputs, expectedActorProfile: undefined }), /INVALID_HTTP_BINDING/);
  assert.throws(() => mintBinding({ ...inputs, credentialProfile: 'real-user' }), /INVALID_HTTP_BINDING/);
  assert.throws(() => mintBinding({ ...inputs, credentialProfile: undefined }), /INVALID_HTTP_BINDING/);
  assert.throws(() => mintBinding({ ...inputs, expiresAt: new Date(Date.now() - 1).toISOString() }), /INVALID_HTTP_BINDING/);
});

test('mint and private binding accept only canonical run_<UUID> IDs', context => {
  const runtime = runtimeFixture(context);
  const inputs = { runtime, runId, userTaskId, expectedActorProfile: profile, credentialProfile, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const invalidIds = [runId.slice(4), `RUN_${runId.slice(4)}`, `job_${runId.slice(4)}`,
    `run_${runId}`, 'run_not-a-uuid', runId.slice(0, -1)];
  const file = path.join(runtime, 'http-binding.json');
  for (const invalidId of invalidIds) {
    assert.throws(() => mintBinding({ ...inputs, runId: invalidId }), /INVALID_HTTP_BINDING/);
    assert.equal(fs.existsSync(file), false);
  }
  mintBinding(inputs);
  const binding = readBinding(runtime);
  assert.equal(binding.runId, runId);
  for (const invalidId of invalidIds) {
    fs.writeFileSync(file, JSON.stringify({ ...binding, runId: invalidId }));
    assert.throws(() => readBinding(runtime), /INVALID_HTTP_BINDING/);
  }
  fs.writeFileSync(file, JSON.stringify(binding));
  assert.equal(readBinding(runtime).runId, runId);
});

test('HTTP startup refuses unavailable SA readiness without exposing decryption errors', async context => {
  const runtime = runtimeFixture(context);
  mintBinding({ runtime, runId, userTaskId, expectedActorProfile: profile, credentialProfile, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  fs.writeFileSync(path.join(runtime, '.host-encryption-key'), crypto.randomBytes(32).toString('hex'));
  await assert.rejects(createHttpHost({ runtime }), /^Error: DOMAIN_NOT_READY$/);
});

test('automatic owner approval is canonical and complete before real domain startup', async context => {
  const runtime = runtimeFixture(context);
  const authorization = { profile, userTaskId, ownerApproved: true, spreadsheetId: 'approved-sheet', folderId: 'approved-folder' };
  fs.writeFileSync(path.join(runtime, 'owner-authorization.json'), JSON.stringify(authorization), { mode: 0o600 });
  mintBinding({ runtime, runId, userTaskId, expectedActorProfile: profile, credentialProfile, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const stdioHost = require('../scripts/sandbox/google-mcp-host.cjs');
  const originalSpawn = stdioHost.spawnDomain;
  let spawns = 0;
  let networkGuardActive = false;
  let blockedNetworkAttempts = 0;
  stdioHost.spawnDomain = env => {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, 'owner-target.json'), 'utf8')), { ...authorization, runId });
    assert.equal(env.GOOGLE_MCP_RUN_ID, runId);
    spawns++;
    const child = originalSpawn(env, true);
    child.on('message', message => {
      if (message?.networkGuardActive === true) networkGuardActive = true;
      if (message?.blockedNetworkAttempt === true) blockedNetworkAttempts++;
    });
    return child;
  };
  let host;
  try { host = await createHttpHost({ runtime }); } finally { stdioHost.spawnDomain = originalSpawn; }
  context.after(() => host.close());
  assert.equal(spawns, 1);
  assert.equal(host.isReady(), true);
  assert.equal(networkGuardActive, true);
  assert.equal(blockedNetworkAttempts, 0);
  assert.equal(readBinding(runtime).runId, runId);
});

test('trusted actor registration never changes the hard-pinned credential mount or inherits secrets', context => {
  const runtime = runtimeFixture(context);
  const binding = { profile, credentialProfile, userTaskId, runId, authToken: 'private-transport-token' };
  const env = registeredDomainEnvironment(runtime, binding);
  assert.equal(env.GOOGLE_MCP_ACTOR_PROFILE, 'integration-v1');
  assert.equal(env.USER_ID, 'sandbox-integrator-google');
  assert.equal(env.GOOGLE_MCP_USER_TASK_ID, userTaskId);
  assert.equal(env.GOOGLE_MCP_RUN_ID, runId);
  for (const name of ['authToken', 'GOOGLE_DOCUMENTS_MCP_TOKEN', 'GDRIVE_SA_JSON', 'GOOGLE_APPLICATION_CREDENTIALS', 'AGENT_SECRET', 'OPENAI_API_KEY']) {
    assert.equal(env[name], undefined);
  }
  for (const invalid of [{ ...binding, profile: credentialProfile }, { ...binding, credentialProfile: 'integration-v1' },
    { ...binding, credentialProfile: 'real-user' }, { ...binding, credentialProfile: undefined }]) {
    assert.throws(() => registeredDomainEnvironment(runtime, invalid), /INVALID_HTTP_BINDING/);
  }
});

test('remote JSON handshake negotiates HTTP protocol and exposes exactly three tools', async context => {
  const { post, host } = await hostFixture(context);
  assert.equal(host.isReady(), true);
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-11-25');
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const listed = await post({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  assert.deepEqual(listed.body.result.tools.map(tool => tool.name).sort(),
    ['gdrive_create_spreadsheet', 'gdrive_read_sheet', 'gdrive_write_sheet']);
  assert.equal((await post({ jsonrpc: '2.0', id: 3, method: 'ping' })).body.result.constructor, Object);
});

test('auth and canonical task/profile/run scope refuse before any domain calls', async context => {
  const { post } = await hostFixture(context);
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await post(request, { Authorization: 'Bearer untrusted' })).status, 401);
  for (const mismatch of [{ 'X-MCP-Run-Id': `run_${crypto.randomUUID()}` }, { 'X-MCP-Run-Id': runId.slice(4) },
    { 'X-MCP-Profile': credentialProfile }, { 'X-MCP-Profile': 'real-user' }, { 'X-MCP-User-Task-Id': 'another-task' }]) {
    assert.equal((await post(request, mismatch)).status, 403);
  }
  assert.equal((await post(request, { Origin: 'https://untrusted.invalid' })).status, 403);
});

test('each of the three real handlers refuses missing owner approval without Google calls', async context => {
  const { post } = await hostFixture(context);
  for (const name of ['gdrive_create_spreadsheet', 'gdrive_read_sheet', 'gdrive_write_sheet']) {
    const result = await post({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: {} } });
    assert.equal(result.body.error.message, 'OWNER_TARGET_REQUIRED');
  }
  const hidden = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gdrive_setup' } });
  assert.equal(hidden.body.error.message, 'METHOD_NOT_ALLOWED');
});

test('owner approval is also canonical-run and task bound before artifact networking', async context => {
  const { runtime, post } = await hostFixture(context);
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'gdrive_read_sheet', arguments: { spreadsheet_id: 'different-sheet', sheet_name: 'Expenses' },
  } };
  const target = { profile, userTaskId, runId: `run_${crypto.randomUUID()}`, ownerApproved: true, spreadsheetId: 'approved-sheet' };
  const file = path.join(runtime, 'owner-target.json');
  fs.writeFileSync(file, JSON.stringify(target), { mode: 0o600 });
  assert.equal((await post(request)).body.error.message, 'OWNER_TARGET_REQUIRED');
  fs.writeFileSync(file, JSON.stringify({ ...target, runId, userTaskId: 'another-task' }));
  assert.equal((await post(request)).body.error.message, 'OWNER_TARGET_REQUIRED');
  fs.writeFileSync(file, JSON.stringify({ ...target, runId, profile: credentialProfile }));
  assert.equal((await post(request)).body.error.message, 'OWNER_TARGET_REQUIRED');
  fs.writeFileSync(file, JSON.stringify({ ...target, runId }));
  assert.equal((await post(request)).body.error.message, 'TARGET_NOT_APPROVED');
});

test('revocation, expiry and scope-file substitution fail closed on every request', async context => {
  const { runtime, binding, post } = await hostFixture(context);
  const file = path.join(runtime, 'http-binding.json');
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  fs.writeFileSync(file, JSON.stringify({ ...binding, expiresAt: new Date(Date.now() - 1).toISOString() }));
  assert.equal((await post(request)).status, 401);
  fs.writeFileSync(file, JSON.stringify({ ...binding, userTaskId: 'substituted-task' }));
  assert.equal((await post(request)).status, 401);
  fs.writeFileSync(file, JSON.stringify({ ...binding, credentialProfile: 'integration-v1' }));
  assert.equal((await post(request)).status, 401);
  fs.unlinkSync(file);
  assert.equal((await post(request)).status, 401);
});

test('HTTP methods, protocol, content type and malformed requests return only safe errors', async context => {
  const { url, headers, post } = await hostFixture(context);
  assert.equal((await fetch(url, { headers })).status, 405);
  assert.equal((await post([], {})).status, 400);
  assert.equal((await post({}, {})).status, 400);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'private-secret-method' })).body.error.message, 'METHOD_NOT_ALLOWED');
  assert.equal((await post({}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({}, { 'MCP-Protocol-Version': 'unknown' })).status, 400);
  const malformed = await fetch(url, { method: 'POST', headers, body: 'private-secret-invalid-json' });
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /private-secret/);
});

test('stdio timeout kills the domain and never retries an ambiguous mutation', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let kills = 0;
  child.kill = () => { kills++; queueMicrotask(() => child.emit('close')); };
  const rpc = stdioRpc(child, 20);
  assert.equal(rpc.isReady(), true);
  await assert.rejects(rpc.call('tools/call', { name: 'gdrive_write_sheet' }), /MCP_OUTCOME_UNKNOWN/);
  assert.equal(rpc.isReady(), false);
  await assert.rejects(rpc.call('tools/call', {}), /MCP_UNAVAILABLE/);
  assert.equal(kills, 1);
  await rpc.close();
});

test('body upload cannot outlive transport token revocation or expiry', async context => {
  const { runtime, binding, host, url, headers } = await hostFixture(context);
  const file = path.join(runtime, 'http-binding.json');
  for (const revoke of [() => fs.unlinkSync(file), () => fs.writeFileSync(file,
    JSON.stringify({ ...binding, expiresAt: new Date(Date.now() - 1).toISOString() }))]) {
    fs.writeFileSync(file, JSON.stringify(binding), { mode: 0o600 });
    let request;
    const arrived = new Promise(resolve => host.server.once('request', () => setTimeout(resolve, 20)));
    const response = new Promise((resolve, reject) => {
      request = http.request(url, { method: 'POST', headers }, reply => {
        reply.resume();
        reply.once('end', () => resolve(reply.statusCode));
      });
      request.once('error', reject);
      request.write('{"jsonrpc":"2.0",');
    });
    await arrived;
    revoke();
    request.end('"id":1,"method":"tools/list"}');
    assert.equal(await response, 401);
  }
});

test('shutdown awaits actual exit and escalates an ignored SIGTERM without replay', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const signals = [];
  child.kill = signal => {
    signals.push(signal);
    if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close'));
  };
  const rpc = stdioRpc(child, 1000, 20);
  const pending = assert.rejects(rpc.call('tools/call', {}), /MCP_OUTCOME_UNKNOWN/);
  await rpc.close();
  await pending;
  await rpc.close();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

async function controlledHostFixture(context) {
  const runtime = runtimeFixture(context);
  mintBinding({ runtime, runId, userTaskId, expectedActorProfile: profile, credentialProfile,
    expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const signals = [];
  child.kill = signal => {
    child.killed = true;
    signals.push(signal);
    queueMicrotask(() => child.emit('close'));
  };
  let calls = 0;
  child.stdin.on('data', chunk => {
    const request = JSON.parse(chunk.toString());
    calls++;
    if (calls === 1) queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: { tools: ['gdrive_create_spreadsheet', 'gdrive_read_sheet', 'gdrive_write_sheet'].map(name => ({ name })) },
    }) + '\n'));
  });
  const spawn = context.mock.method(require('../scripts/sandbox/google-mcp-host.cjs'), 'spawnDomain', () => child);
  const host = await createHttpHost({ runtime });
  context.after(() => host.close());
  const url = `http://127.0.0.1:${host.server.address().port}/mcp`;
  const binding = readBinding(runtime);
  const headers = { Authorization: `Bearer ${binding.authToken}`, 'X-MCP-Run-Id': runId,
    'X-MCP-User-Task-Id': userTaskId, 'X-MCP-Profile': profile,
    Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  return { child, host, url, headers, spawn, signals, calls: () => calls };
}

for (const failure of ['exit', 'error', 'stdin_error', 'stdout_end', 'malformed_rpc']) {
  test(`host readiness and listener fail closed immediately on ${failure} without restart`, async context => {
    const fixture = await controlledHostFixture(context);
    assert.equal(fixture.host.isReady(), true);
    if (failure === 'exit') fixture.child.emit('exit', 1);
    else if (failure === 'error') fixture.child.emit('error', new Error('synthetic-private-detail'));
    else if (failure === 'stdin_error') fixture.child.stdin.emit('error', new Error('synthetic-private-detail'));
    else if (failure === 'stdout_end') fixture.child.stdout.emit('end');
    else fixture.child.stdout.write('synthetic-private-malformed-rpc\n');
    assert.equal(fixture.host.isReady(), false);
    assert.equal(fixture.host.server.listening, false);
    await assert.rejects(fetch(fixture.url, { method: 'POST', headers: fixture.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) }));
    await fixture.host.close();
    await fixture.host.close();
    assert.equal(fixture.spawn.mock.callCount(), 1);
    assert.equal(fixture.calls(), 1);
    assert.deepEqual(fixture.signals, ['SIGTERM']);
  });
}

test('RPC timeout tears down listener and pending HTTP connection without retry', async context => {
  const setTimeoutOriginal = setTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) =>
    setTimeoutOriginal(callback, delay === 30000 ? 20 : delay, ...args));
  const fixture = await controlledHostFixture(context);
  await assert.rejects(fetch(fixture.url, { method: 'POST', headers: fixture.headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) }));
  assert.equal(fixture.host.isReady(), false);
  assert.equal(fixture.host.server.listening, false);
  await fixture.host.close();
  assert.equal(fixture.spawn.mock.callCount(), 1);
  assert.equal(fixture.calls(), 2);
  assert.deepEqual(fixture.signals, ['SIGTERM']);
});

test('explicit host shutdown makes readiness false and remains idempotent', async context => {
  const { host } = await hostFixture(context);
  assert.equal(host.isReady(), true);
  await host.close();
  assert.equal(host.isReady(), false);
  assert.equal(host.server.listening, false);
  await host.close();
});

test('actual guarded domain crash closes the real listener with no provider calls or respawn', async context => {
  const stdioHost = require('../scripts/sandbox/google-mcp-host.cjs');
  const originalSpawn = stdioHost.spawnDomain;
  let child;
  let guardActive = false;
  let networkAttempts = 0;
  const spawn = context.mock.method(stdioHost, 'spawnDomain', env => {
    child = originalSpawn(env, true);
    child.on('message', message => {
      if (message?.networkGuardActive) guardActive = true;
      if (message?.blockedNetworkAttempt) networkAttempts++;
    });
    return child;
  });
  const { host, url, headers } = await hostFixture(context);
  assert.equal(host.isReady(), true);
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  assert.equal(host.isReady(), false);
  assert.equal(host.server.listening, false);
  await assert.rejects(fetch(url, { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }));
  await host.close();
  assert.equal(spawn.mock.callCount(), 1);
  assert.equal(guardActive, true);
  assert.equal(networkAttempts, 0);
});
