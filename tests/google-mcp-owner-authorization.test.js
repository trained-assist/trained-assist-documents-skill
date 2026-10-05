'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { mintBinding, readBinding, createHttpHost } = require('../scripts/sandbox/google-mcp-http.cjs');
const { approvedTarget } = require('../scripts/sandbox/google-mcp-tools/google');
const stdioHost = require('../scripts/sandbox/google-mcp-host.cjs');

function fixture(context) {
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'google-owner-authorization-')));
  fs.chmodSync(runtime, 0o700);
  context.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const input = { runtime, runId: `run_${crypto.randomUUID()}`, userTaskId: 'approved-task', expectedActorProfile: 'integration-v1', credentialProfile: 'sandbox-integrator-google', expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const authorization = { profile: 'integration-v1', userTaskId: input.userTaskId, ownerApproved: true, spreadsheetId: 'approved-sheet', folderId: 'approved-folder' };
  const authorizationFile = path.join(runtime, 'owner-authorization.json');
  const targetFile = path.join(runtime, 'owner-target.json');
  const bindingFile = path.join(runtime, 'http-binding.json');
  return { runtime, input, authorization, authorizationFile, targetFile, bindingFile };
}

function writePrivate(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

test('trusted approval publishes exact canonical target before binding without reading credentials', context => {
  const { runtime, input, authorization, authorizationFile, targetFile, bindingFile } = fixture(context);
  writePrivate(authorizationFile, authorization);
  const originalLink = fs.linkSync;
  const publication = [];
  fs.linkSync = (source, destination) => {
    if (destination === bindingFile) {
      assert.deepEqual(JSON.parse(fs.readFileSync(targetFile, 'utf8')), { ...authorization, runId: input.runId });
      assert.equal(fs.existsSync(bindingFile), false);
    }
    originalLink(source, destination);
    publication.push(path.basename(destination));
  };
  let metadata;
  try { metadata = mintBinding(input); } finally { fs.linkSync = originalLink; }
  assert.deepEqual(publication, ['owner-target.json', 'http-binding.json']);
  assert.deepEqual(metadata, { runId: input.runId, userTaskId: input.userTaskId, profile: input.expectedActorProfile, credentialProfile: input.credentialProfile, expiresAt: input.expiresAt });
  assert.equal(fs.existsSync(path.join(runtime, '.host-encryption-key')), false);
  assert.equal(fs.existsSync(path.join(runtime, 'tokens')), false);
  for (const file of [authorizationFile, targetFile, bindingFile]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const before = fs.readFileSync(bindingFile, 'utf8');
  const binding = readBinding(runtime);
  assert.equal(binding.ownerAuthorizationRequired, true);
  assert.equal(binding.runId, input.runId);
  assert.equal(binding.authToken.length, 43);
  assert.equal(fs.readFileSync(bindingFile, 'utf8'), before);
  assert.throws(() => mintBinding(input), /HTTP_BINDING_EXISTS/);
  assert.equal(fs.readFileSync(bindingFile, 'utf8'), before);
  assert.equal(fs.readdirSync(runtime).some(name => name.endsWith('.tmp')), false);
});

for (const [label, change] of [
  ['wrong actor', { profile: 'sandbox-integrator-google' }], ['wrong task', { userTaskId: 'other-task' }],
  ['unapproved', { ownerApproved: false }], ['approval string', { ownerApproved: 'true' }],
  ['guessed run', { runId: `run_${crypto.randomUUID()}` }], ['bare run', { runId: crypto.randomUUID() }],
  ['missing targets', { spreadsheetId: undefined, folderId: undefined }], ['wildcard sheet', { spreadsheetId: '*' }],
  ['URL target', { folderId: 'https://example.invalid/folder' }], ['target array', { spreadsheetId: ['approved-sheet'] }],
  ['model secret field', { authToken: 'synthetic-forbidden' }],
]) {
  test(`authorization refuses ${label} before target or binding publication`, context => {
    const { input, authorization, authorizationFile, targetFile, bindingFile } = fixture(context);
    writePrivate(authorizationFile, { ...authorization, ...change });
    assert.throws(() => mintBinding(input), /INVALID_OWNER_AUTHORIZATION/);
    assert.equal(fs.existsSync(targetFile), false);
    assert.equal(fs.existsSync(bindingFile), false);
  });
}

test('canonical input refusal precedes approved target publication', context => {
  const { input, authorization, authorizationFile, targetFile, bindingFile } = fixture(context);
  writePrivate(authorizationFile, authorization);
  for (const runId of [input.runId.slice(4), 'run_guessed', input.runId.toUpperCase()]) {
    assert.throws(() => mintBinding({ ...input, runId }), /INVALID_HTTP_BINDING/);
    assert.equal(fs.existsSync(targetFile), false);
    assert.equal(fs.existsSync(bindingFile), false);
  }
});

test('missing authorization remains discovery-only and never creates an approved target', context => {
  const { runtime, input, targetFile } = fixture(context);
  mintBinding(input);
  assert.equal(readBinding(runtime).ownerAuthorizationRequired, undefined);
  assert.equal(fs.existsSync(targetFile), false);
});

test('unsafe approval permissions, symlink and oversized metadata refuse without publication', context => {
  const { runtime, input, authorization, authorizationFile, targetFile, bindingFile } = fixture(context);
  writePrivate(authorizationFile, authorization);
  fs.chmodSync(authorizationFile, 0o644);
  assert.throws(() => mintBinding(input), /INVALID_OWNER_AUTHORIZATION/);
  fs.chmodSync(authorizationFile, 0o600);
  fs.renameSync(authorizationFile, path.join(runtime, 'private-copy.json'));
  fs.symlinkSync(path.join(runtime, 'private-copy.json'), authorizationFile);
  assert.throws(() => mintBinding(input), /INVALID_OWNER_AUTHORIZATION/);
  fs.unlinkSync(authorizationFile);
  fs.writeFileSync(authorizationFile, 'x'.repeat(8193), { mode: 0o600 });
  assert.throws(() => mintBinding(input), /INVALID_OWNER_AUTHORIZATION/);
  assert.equal(fs.existsSync(targetFile), false);
  assert.equal(fs.existsSync(bindingFile), false);
});

test('existing target, including same scope and dangling symlink, is never overwritten', context => {
  const { runtime, input, authorization, authorizationFile, targetFile, bindingFile } = fixture(context);
  writePrivate(authorizationFile, authorization);
  const target = { ...authorization, runId: input.runId };
  writePrivate(targetFile, target);
  const before = fs.readFileSync(targetFile, 'utf8');
  assert.throws(() => mintBinding(input), /OWNER_TARGET_CONFLICT/);
  assert.equal(fs.readFileSync(targetFile, 'utf8'), before);
  fs.unlinkSync(targetFile);
  fs.symlinkSync(path.join(runtime, 'absent-target'), targetFile);
  assert.throws(() => mintBinding(input), /OWNER_TARGET_CONFLICT/);
  assert.equal(fs.existsSync(bindingFile), false);
});

test('publication failure leaves an unbound target for operator review, not an automatic retry', context => {
  const { runtime, input, authorization, authorizationFile, targetFile, bindingFile } = fixture(context);
  writePrivate(authorizationFile, authorization);
  const originalLink = fs.linkSync;
  fs.linkSync = (source, destination) => {
    if (destination === bindingFile) throw new Error('SYNTHETIC_PUBLICATION_FAILURE');
    originalLink(source, destination);
  };
  try { assert.throws(() => mintBinding(input), /SYNTHETIC_PUBLICATION_FAILURE/); }
  finally { fs.linkSync = originalLink; }
  assert.equal(fs.existsSync(bindingFile), false);
  assert.equal(fs.existsSync(targetFile), true);
  assert.equal(fs.readdirSync(runtime).some(name => name.endsWith('.tmp')), false);
  assert.throws(() => mintBinding(input), /OWNER_TARGET_CONFLICT/);
});

test('a competing target publication is not overwritten and never yields a binding', context => {
  const { input, authorization, authorizationFile, targetFile, bindingFile } = fixture(context);
  writePrivate(authorizationFile, authorization);
  const competing = { ...authorization, runId: `run_${crypto.randomUUID()}` };
  const originalLink = fs.linkSync;
  fs.linkSync = (source, destination) => {
    if (destination === targetFile) writePrivate(targetFile, competing);
    originalLink(source, destination);
  };
  try { assert.throws(() => mintBinding(input), { code: 'EEXIST' }); }
  finally { fs.linkSync = originalLink; }
  assert.deepEqual(JSON.parse(fs.readFileSync(targetFile, 'utf8')), competing);
  assert.equal(fs.existsSync(bindingFile), false);
});

test('target restoration rejects unsafe permissions and symlinks without touching binding', context => {
  const { runtime, input, authorization, authorizationFile, targetFile, bindingFile } = fixture(context);
  writePrivate(authorizationFile, authorization);
  mintBinding(input);
  const binding = fs.readFileSync(bindingFile, 'utf8');
  fs.chmodSync(targetFile, 0o644);
  assert.throws(() => readBinding(runtime), /OWNER_TARGET_CONFLICT/);
  fs.chmodSync(targetFile, 0o600);
  fs.renameSync(targetFile, path.join(runtime, 'target-copy.json'));
  fs.symlinkSync(path.join(runtime, 'target-copy.json'), targetFile);
  assert.throws(() => readBinding(runtime), /OWNER_TARGET_CONFLICT/);
  assert.equal(fs.readFileSync(bindingFile, 'utf8'), binding);
});

for (const target of [{ spreadsheetId: 'approved-sheet' }, { folderId: 'approved-folder' }]) {
  test(`approval permits a singleton ${Object.keys(target)[0]} without approving another tool destination`, context => {
    const { runtime, input, authorizationFile, targetFile } = fixture(context);
    const authorization = { profile: input.expectedActorProfile, userTaskId: input.userTaskId, ownerApproved: true, ...target };
    writePrivate(authorizationFile, authorization);
    mintBinding(input);
    assert.deepEqual(JSON.parse(fs.readFileSync(targetFile, 'utf8')), { ...authorization, runId: input.runId });
    assert.equal(readBinding(runtime).runId, input.runId);
  });
}

for (const [label, change] of [
  ['actor', { profile: 'sandbox-integrator-google' }], ['task', { userTaskId: 'other-task' }],
  ['run', { runId: `run_${crypto.randomUUID()}` }], ['bare run', { runId: crypto.randomUUID() }],
  ['sheet', { spreadsheetId: 'other-sheet' }], ['folder', { folderId: 'other-folder' }], ['approval', { ownerApproved: false }],
]) {
  test(`restoration refuses substituted ${label} without remint or repair`, context => {
    const { runtime, input, authorization, authorizationFile, targetFile, bindingFile } = fixture(context);
    writePrivate(authorizationFile, authorization);
    mintBinding(input);
    const binding = fs.readFileSync(bindingFile, 'utf8');
    writePrivate(targetFile, { ...authorization, runId: input.runId, ...change });
    const target = fs.readFileSync(targetFile, 'utf8');
    assert.throws(() => readBinding(runtime), /OWNER_TARGET_CONFLICT/);
    assert.equal(fs.readFileSync(bindingFile, 'utf8'), binding);
    assert.equal(fs.readFileSync(targetFile, 'utf8'), target);
  });
}

test('removal of authorization or target revokes a template-backed binding without recreating files', context => {
  const { runtime, input, authorization, authorizationFile, targetFile, bindingFile } = fixture(context);
  writePrivate(authorizationFile, authorization);
  mintBinding(input);
  const binding = fs.readFileSync(bindingFile, 'utf8');
  fs.unlinkSync(targetFile);
  assert.throws(() => readBinding(runtime), /OWNER_TARGET_CONFLICT/);
  assert.equal(fs.existsSync(targetFile), false);
  fs.unlinkSync(authorizationFile);
  assert.throws(() => readBinding(runtime), /INVALID_OWNER_AUTHORIZATION/);
  assert.equal(fs.existsSync(authorizationFile), false);
  assert.equal(fs.readFileSync(bindingFile, 'utf8'), binding);
});

test('existing target guard permits only the explicitly approved singleton targets', context => {
  const { runtime, input, authorization, authorizationFile } = fixture(context);
  writePrivate(authorizationFile, authorization);
  mintBinding(input);
  const values = { GOOGLE_MCP_RUNTIME: runtime, GOOGLE_MCP_PROBE_ONLY: '0', USER_ID: input.credentialProfile,
    GOOGLE_MCP_ACTOR_PROFILE: input.expectedActorProfile, GOOGLE_MCP_USER_TASK_ID: input.userTaskId, GOOGLE_MCP_RUN_ID: input.runId };
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  context.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  for (const name of ['gdrive_read_sheet', 'gdrive_write_sheet']) {
    assert.equal(approvedTarget(name, { spreadsheet_id: authorization.spreadsheetId }), null);
    assert.equal(approvedTarget(name, { spreadsheet_id: 'other-sheet' }), 'TARGET_NOT_APPROVED');
  }
  assert.equal(approvedTarget('gdrive_create_spreadsheet', { folder_id: authorization.folderId }), null);
  assert.equal(approvedTarget('gdrive_create_spreadsheet', { folder_id: 'other-folder' }), 'TARGET_NOT_APPROVED');
});

test('startup refuses a missing exact target before spawning any domain child', async context => {
  const { runtime, input, authorization, authorizationFile, targetFile } = fixture(context);
  writePrivate(authorizationFile, authorization);
  mintBinding(input);
  fs.unlinkSync(targetFile);
  const originalSpawn = stdioHost.spawnDomain;
  let spawns = 0;
  stdioHost.spawnDomain = () => { spawns++; throw new Error('UNEXPECTED_DOMAIN_SPAWN'); };
  try { await assert.rejects(createHttpHost({ runtime }), /OWNER_TARGET_CONFLICT/); }
  finally { stdioHost.spawnDomain = originalSpawn; }
  assert.equal(spawns, 0);
});
