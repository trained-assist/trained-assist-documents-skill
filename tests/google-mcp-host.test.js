'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { childEnvironment } = require('../scripts/sandbox/google-mcp-host.cjs');
const wrapper = require('../scripts/sandbox/google-mcp-tools/google');
const original = require('../src/mcp-skills/tools/50-gdrive');
const script = path.join(__dirname, '../scripts/sandbox/google-mcp-host.cjs');

function runtimeFixture(context) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'google-mcp-test-'));
  fs.chmodSync(runtime, 0o700);
  for (const directory of ['home', 'work', 'tokens', 'tokens/sandbox-integrator-google']) {
    fs.mkdirSync(path.join(runtime, directory), { mode: 0o700 });
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(runtime, '.host-encryption-key'), key.toString('hex'), { mode: 0o600 });
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const credentials = JSON.stringify({ client_email: 'synthetic@test.invalid', private_key: 'synthetic-private-key-never-output' });
  const ciphertext = Buffer.concat([cipher.update(credentials), cipher.final()]);
  fs.writeFileSync(path.join(runtime, 'tokens/sandbox-integrator-google/gdrive'),
    Buffer.concat([Buffer.from([2]), iv, cipher.getAuthTag(), ciphertext]).toString('base64'), { mode: 0o600 });
  context.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  return runtime;
}

function targetFixture(context, runtime, target) {
  const previousRuntime = process.env.GOOGLE_MCP_RUNTIME;
  const previousProbe = process.env.GOOGLE_MCP_PROBE_ONLY;
  process.env.GOOGLE_MCP_RUNTIME = runtime;
  process.env.GOOGLE_MCP_PROBE_ONLY = '0';
  context.after(() => {
    for (const [name, value] of [['GOOGLE_MCP_RUNTIME', previousRuntime], ['GOOGLE_MCP_PROBE_ONLY', previousProbe]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  if (target) fs.writeFileSync(path.join(runtime, 'owner-target.json'), JSON.stringify(target), { mode: 0o600 });
}

test('child environment is explicit and never inherits owner/model credentials', context => {
  const runtime = runtimeFixture(context);
  const env = childEnvironment(runtime, true);
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'HOME', 'USER_ID', 'AGENT_TOKENS_DIR', 'AGENT_DATA_DIR',
    'USERS_DIR', 'TOOLS_DIR', 'GOOGLE_MCP_RUNTIME', 'GOOGLE_MCP_PROBE_ONLY', 'CRED_ENCRYPTION_KEY'].sort());
  assert.equal(env.HOME, path.join(fs.realpathSync(runtime), 'home'));
  assert.equal(env.USER_ID, 'sandbox-integrator-google');
  assert.equal(env.GOOGLE_MCP_PROBE_ONLY, '1');
  assert.equal(env.CRED_ENCRYPTION_KEY.length, 64);
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GDRIVE_SA_JSON', 'AGENT_SECRET']) {
    assert.equal(env[name], undefined);
  }
});

test('runtime refuses plaintext credentials, unsafe modes and symlink keys', context => {
  const runtime = runtimeFixture(context);
  const keyPath = path.join(runtime, '.host-encryption-key');
  fs.chmodSync(keyPath, 0o644);
  assert.throws(() => childEnvironment(runtime, true), /UNSAFE_RUNTIME_BINDING/);
  fs.chmodSync(keyPath, 0o600);
  fs.renameSync(keyPath, keyPath + '.original');
  fs.symlinkSync(keyPath + '.original', keyPath);
  assert.throws(() => childEnvironment(runtime, true), /UNSAFE_RUNTIME_BINDING/);
  fs.unlinkSync(keyPath);
  fs.renameSync(keyPath + '.original', keyPath);
  fs.writeFileSync(path.join(runtime, 'tokens/sandbox-integrator-google/gdrive'), '{}');
  assert.throws(() => childEnvironment(runtime, true), /UNSAFE_RUNTIME_BINDING/);
});

test('real stdio probe lists exactly three tools and stays offline even after owner approval', context => {
  const runtime = runtimeFixture(context);
  fs.writeFileSync(path.join(runtime, 'owner-target.json'), JSON.stringify({
    profile: 'sandbox-integrator-google', ownerApproved: true, spreadsheetId: 'approved-sheet', folderId: 'approved-folder',
  }), { mode: 0o600 });
  const result = spawnSync(process.execPath, [script, '--runtime', runtime, '--probe'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.deepEqual(evidence.toolNames, ['gdrive_create_spreadsheet', 'gdrive_read_sheet', 'gdrive_write_sheet']);
  assert.equal(evidence.ownerTargetGateVerified, true);
  assert.equal(evidence.liveGoogleArtifactCalls, 0);
  assert.equal(evidence.networkGuardActive, true);
  assert.equal(evidence.blockedNetworkAttempts, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-key|synthetic@test|CRED_ENCRYPTION_KEY/);
});

test('approval gates every bounded tool before invoking Google', async context => {
  const runtime = runtimeFixture(context);
  targetFixture(context, runtime);
  for (const tool of Object.values(wrapper.tools)) {
    await assert.rejects(tool.handler({}), /^Error: OWNER_TARGET_REQUIRED$/);
  }
  fs.writeFileSync(path.join(runtime, 'owner-target.json'), '{invalid', { mode: 0o600 });
  assert.equal(wrapper.approvedTarget('gdrive_read_sheet', {}), 'OWNER_TARGET_REQUIRED');
});

test('owner targets are exact, private, profile-bound and explicitly approved', context => {
  const runtime = runtimeFixture(context);
  targetFixture(context, runtime, { profile: 'sandbox-integrator-google', ownerApproved: true,
    spreadsheetId: 'approved-sheet', folderId: 'approved-folder' });
  assert.equal(wrapper.approvedTarget('gdrive_read_sheet', { spreadsheet_id: 'approved-sheet' }), null);
  assert.equal(wrapper.approvedTarget('gdrive_write_sheet', { spreadsheet_id: 'other-sheet' }), 'TARGET_NOT_APPROVED');
  assert.equal(wrapper.approvedTarget('gdrive_create_spreadsheet', { folder_id: 'approved-folder' }), null);
  assert.equal(wrapper.approvedTarget('gdrive_create_spreadsheet', { folder_id: 'other-folder' }), 'TARGET_NOT_APPROVED');
  fs.chmodSync(path.join(runtime, 'owner-target.json'), 0o644);
  assert.equal(wrapper.approvedTarget('gdrive_read_sheet', { spreadsheet_id: 'approved-sheet' }), 'OWNER_TARGET_REQUIRED');
  fs.chmodSync(path.join(runtime, 'owner-target.json'), 0o600);
  for (const target of [{ profile: 'real-user', ownerApproved: true }, { profile: 'sandbox-integrator-google', ownerApproved: false }]) {
    fs.writeFileSync(path.join(runtime, 'owner-target.json'), JSON.stringify(target));
    assert.equal(wrapper.approvedTarget('gdrive_read_sheet', {}), 'OWNER_TARGET_REQUIRED');
  }
});

test('approved calls delegate unchanged but provider errors cannot disclose credentials', async context => {
  const runtime = runtimeFixture(context);
  targetFixture(context, runtime, { profile: 'sandbox-integrator-google', ownerApproved: true, spreadsheetId: 'approved-sheet' });
  const originalHandler = original.tools.gdrive_write_sheet.handler;
  context.after(() => { original.tools.gdrive_write_sheet.handler = originalHandler; });
  const args = { spreadsheet_id: 'approved-sheet', sheet_name: 'Results', operationId: 'task:v1', rows: [[123]] };
  original.tools.gdrive_write_sheet.handler = async received => { assert.deepEqual(received, args); return { verified: true }; };
  assert.deepEqual(await wrapper.tools.gdrive_write_sheet.handler(args), { verified: true });
  original.tools.gdrive_write_sheet.handler = async () => {
    throw Object.assign(new Error('private_key secret refresh_token jwt'), { code: 'SHEETS_OUTCOME_UNKNOWN' });
  };
  await assert.rejects(wrapper.tools.gdrive_write_sheet.handler(args), /^Error: SHEETS_OUTCOME_UNKNOWN$/);
  original.tools.gdrive_write_sheet.handler = async () => { throw new Error('private_key secret'); };
  await assert.rejects(wrapper.tools.gdrive_write_sheet.handler(args), /^Error: GOOGLE_TOOL_FAILED$/);
  original.tools.gdrive_write_sheet.handler = async () => { throw Object.assign(new Error('secret'), { code: 'SHEETS_SECRET_TOKEN' }); };
  await assert.rejects(wrapper.tools.gdrive_write_sheet.handler(args), /^Error: GOOGLE_TOOL_FAILED$/);
});

test('probe preload denies fetch and socket networking before any request', () => {
  const guard = path.join(__dirname, '../scripts/sandbox/google-mcp-probe-guard.cjs');
  const result = spawnSync(process.execPath, ['--require', guard, '-e',
    "for (const attempt of [() => fetch('https://example.invalid'), () => require('node:https').get('https://example.invalid'), () => require('node:net').connect(443, 'example.invalid')]) { try { attempt(); process.exit(2); } catch (error) { if (error.message !== 'OFFLINE_PROBE_NETWORK_DENIED') process.exit(3); } }"], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('invalid CLI input never echoes sensitive paths or arguments', () => {
  const result = spawnSync(process.execPath, [script, '--runtime', '/secret-private-path', '--bad-mode'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /secret-private-path/);
});
