'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../scripts/sandbox/google-sheet-prepare.cjs');
const { inspect, inspectGrid, guardedFetch, spreadsheetId, operationHash, payloadHash, sourceSheetId, rowsSha256 } = require('../scripts/sandbox/google-sheet-prepare-child.cjs');
const fixture = require('../scripts/fixtures/google-expenses-v1.json');
const expectedEmail = 'isolated@fixture-project.iam.gserviceaccount.com';

function blankSheet(sheetId = 1056899445, title = 'Sheet1') {
  return { properties: { sheetId, title, sheetType: 'GRID', gridProperties: { rowCount: 1000, columnCount: 26 } }, data: [] };
}

function seededGrid() {
  const source = blankSheet(sourceSheetId, 'Expenses');
  source.properties.gridProperties = { rowCount: fixture.rows.length, columnCount: fixture.rows[0].length };
  source.data = [{ rowData: fixture.rows.map(row => ({ values: row.map(value => {
    const typed = { [typeof value === 'number' ? 'numberValue' : 'stringValue']: value };
    return { userEnteredValue: typed, effectiveValue: typed };
  }) })) }];
  source.developerMetadata = [{ metadataKey: 'trained_assist_sheet_operation_v1',
    metadataValue: JSON.stringify({ operationHash, payloadHash }), location: { sheetId: sourceSheetId } }];
  return { spreadsheetId, sheets: [blankSheet(), source] };
}

function operator(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'google-sheet-prepare-'));
  fs.chmodSync(directory, 0o700);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const metadataFile = path.join(directory, 'metadata.json');
  const checkpoint = path.join(directory, 'checkpoint.json');
  const sourceOut = path.join(directory, 'source.json');
  const metadata = { schemaVersion: 'google-sheet-preparation-v1', spreadsheetId, expectedSaEmail: expectedEmail,
    baselineSheetId: 1056899445, baselineSheetName: 'Sheet1' };
  const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  save(metadataFile, metadata);
  const args = mode => [mode, '--runtime', path.join(directory, 'runtime'), '--metadata', metadataFile,
    '--checkpoint', checkpoint, '--source-out', sourceOut];
  const state = { calls: [], grid: { spreadsheetId, sheets: [blankSheet()] }, loseSeedAck: false, failBeforeSeed: false };
  const dependencies = {
    childEnvironment(runtime, probe) {
      assert.equal(runtime, path.join(directory, 'runtime'));
      assert.equal(probe, false);
      return { USER_ID: 'sandbox-integrator-google', AGENT_DATA_DIR: directory, CRED_ENCRYPTION_KEY: 'private fixture sentinel' };
    },
    execFileSync(executable, childArgs, options) {
      assert.equal(executable, process.execPath);
      assert.equal(path.basename(childArgs[0]), 'google-sheet-prepare-child.cjs');
      assert.equal(childArgs[2], expectedEmail);
      assert.equal(options.cwd, directory);
      assert.deepEqual(Object.keys(options.env).sort(), ['AGENT_DATA_DIR', 'CRED_ENCRYPTION_KEY', 'USER_ID']);
      assert.equal(options.timeout, 120000);
      assert.equal(options.maxBuffer, 65536);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      state.calls.push(childArgs[1]);
      if (childArgs[1] === 'inspect') return Buffer.from(JSON.stringify({ schemaVersion: 'google-sheet-inspection-v1',
        spreadsheetId, exactAccountVerified: true, canEdit: true, ...inspectGrid(state.grid) }));
      assert.equal(childArgs[1], 'seed');
      const durable = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
      assert.equal(durable.phase, 'seed_attempted');
      assert.equal(durable.operationId, 'google-expenses-v1:source');
      assert.equal(durable.baseline[0].sheetId, 1056899445);
      assert.equal(durable.baseline[0].title, 'Sheet1');
      if (state.failBeforeSeed) throw new Error('private uncommitted seed sentinel');
      state.grid = seededGrid();
      if (state.loseSeedAck) throw new Error('private committed seed ACK sentinel');
      return Buffer.from('captured existing fixture stdout; never forwarded');
    },
  };
  return { args, dependencies, state, metadata, metadataFile, checkpoint, sourceOut, save };
}

test('preflight is read-only, preserves blank baseline gid/title, and writes no source input', context => {
  const data = operator(context);
  const result = main(data.args('preflight'), data.dependencies);
  assert.equal(result.passed, true);
  assert.equal(result.report.phase, 'preflight_passed');
  assert.deepEqual(data.state.calls, ['inspect']);
  assert.equal(result.report.baseline[0].sheetId, data.metadata.baselineSheetId);
  assert.equal(result.report.baseline[0].title, data.metadata.baselineSheetName);
  assert.equal(fs.existsSync(data.sourceOut), false);
  assert.equal(fs.statSync(data.checkpoint).mode & 0o777, 0o600);
});

test('directory sync failure during initial checkpoint refuses provider work even when checkpoint exists', context => {
  const data = operator(context);
  const fsyncSync = fs.fsyncSync;
  context.mock.method(fs, 'fsyncSync', descriptor => {
    if (fs.fstatSync(descriptor).isDirectory()) throw new Error('private directory sync sentinel');
    return fsyncSync(descriptor);
  });
  const result = main(data.args('preflight'), data.dependencies);
  assert.equal(result.passed, false);
  assert.ok(fs.existsSync(data.checkpoint));
  assert.equal(data.state.calls.length, 0);
  assert.ok(!JSON.stringify(result.report).includes('private directory sync sentinel'));
});

test('directory sync failure after seed intent publication refuses mutation even when checkpoint exists', context => {
  const data = operator(context);
  assert.equal(main(data.args('preflight'), data.dependencies).passed, true);
  const fsyncSync = fs.fsyncSync;
  context.mock.method(fs, 'fsyncSync', descriptor => {
    if (fs.fstatSync(descriptor).isDirectory()) throw new Error('private intent sync sentinel');
    return fsyncSync(descriptor);
  });
  const result = main(data.args('seed'), data.dependencies);
  assert.equal(result.passed, false);
  const durable = JSON.parse(fs.readFileSync(data.checkpoint, 'utf8'));
  assert.equal(durable.phase, 'seed_attempted');
  assert.equal(data.state.calls.filter(call => call === 'seed').length, 0);
  assert.equal(fs.existsSync(data.sourceOut), false);
  assert.ok(!JSON.stringify(result.report).includes('private intent sync sentinel'));
});

test('private directory sync follows publication and completes before seed launch and source acknowledgment', context => {
  const data = operator(context);
  const synced = [];
  const fsyncSync = fs.fsyncSync;
  context.mock.method(fs, 'fsyncSync', descriptor => {
    const stat = fs.fstatSync(descriptor);
    if (stat.isDirectory()) {
      assert.equal(stat.mode & 0o777, 0o700);
      assert.equal(stat.uid, process.getuid());
      synced.push({ phase: JSON.parse(fs.readFileSync(data.checkpoint, 'utf8')).phase, sourcePublished: fs.existsSync(data.sourceOut) });
    }
    return fsyncSync(descriptor);
  });
  const execFileSync = data.dependencies.execFileSync;
  data.dependencies.execFileSync = (executable, args, options) => {
    if (args[1] === 'seed') assert.equal(synced.at(-1).phase, 'seed_attempted');
    return execFileSync(executable, args, options);
  };
  assert.equal(main(data.args('preflight'), data.dependencies).passed, true);
  assert.equal(main(data.args('seed'), data.dependencies).passed, true);
  assert.ok(synced.some(entry => entry.sourcePublished && entry.phase === 'seed_attempted'));
  assert.equal(synced.at(-1).phase, 'seed_verified');
});

test('seed requires checkpoint, refreshes baseline, captures child output and emits only actual source metadata', context => {
  const data = operator(context);
  assert.equal(main(data.args('seed'), data.dependencies).passed, false);
  assert.equal(data.state.calls.length, 0);
  assert.equal(main(data.args('preflight'), data.dependencies).passed, true);
  const result = main(data.args('seed'), data.dependencies);
  assert.equal(result.passed, true);
  assert.equal(result.report.verified, true);
  assert.equal(result.report.googleSheetsAcceptance, false);
  assert.deepEqual(data.state.calls, ['inspect', 'inspect', 'seed', 'inspect']);
  const source = JSON.parse(fs.readFileSync(data.sourceOut, 'utf8'));
  assert.deepEqual(source, { schemaVersion: 'google-sheet-source-v1', spreadsheetId,
    sourceSheetId, sourceSheetName: 'Expenses', sourceRange: 'A1:D1000' });
  assert.notEqual(source.sourceSheetId, data.metadata.baselineSheetId);
  assert.ok(!JSON.stringify(source).includes('expected') && !JSON.stringify(source).includes('private fixture sentinel'));
  assert.equal(fs.statSync(data.sourceOut).mode & 0o777, 0o600);
  assert.equal(main(data.args('seed'), data.dependencies).passed, false);
  assert.equal(data.state.calls.filter(call => call === 'seed').length, 1);
});

for (const refusal of ['nonblank', 'wrong-gid', 'renamed', 'added-tab']) test(`changed ${refusal} baseline refuses before seed`, context => {
  const data = operator(context);
  main(data.args('preflight'), data.dependencies);
  if (refusal === 'nonblank') data.state.grid.sheets[0].data = [{ startRow: 999, startColumn: 25,
    rowData: [{ values: [{ userEnteredValue: { formulaValue: '=1' } }] }] }];
  if (refusal === 'wrong-gid') data.state.grid.sheets[0].properties.sheetId++;
  if (refusal === 'renamed') data.state.grid.sheets[0].properties.title = 'Other';
  if (refusal === 'added-tab') data.state.grid.sheets.push(blankSheet(7, 'Other'));
  assert.equal(main(data.args('seed'), data.dependencies).passed, false);
  assert.ok(!data.state.calls.includes('seed'));
});

test('first seed refuses every nonblank existing tab, including cells outside the source rectangle', context => {
  const data = operator(context);
  const other = blankSheet(7, 'Far data');
  other.data = [{ startRow: 3000, startColumn: 100, rowData: [{ values: [{ effectiveValue: { numberValue: 0 } }] }] }];
  data.state.grid.sheets.push(other);
  assert.equal(main(data.args('preflight'), data.dependencies).passed, false);
  assert.ok(!data.state.calls.includes('seed'));
});

test('lost seed ACK cannot retry a mutation; explicit read-only reconcile verifies the same receipt and exports source', context => {
  const data = operator(context);
  main(data.args('preflight'), data.dependencies);
  data.state.loseSeedAck = true;
  const failed = main(data.args('seed'), data.dependencies);
  assert.equal(failed.passed, false);
  assert.equal(failed.report.phase, 'seed_attempted');
  assert.ok(!JSON.stringify(failed.report).includes('private committed seed ACK sentinel'));
  assert.equal(fs.existsSync(data.sourceOut), false);
  assert.equal(main(data.args('seed'), data.dependencies).passed, false);
  const before = data.state.calls.length;
  assert.equal(main(data.args('reconcile'), data.dependencies).passed, true);
  assert.deepEqual(data.state.calls.slice(before), ['inspect']);
  assert.equal(data.state.calls.filter(call => call === 'seed').length, 1);
  const original = fs.readFileSync(data.sourceOut, 'utf8');
  assert.equal(main(data.args('reconcile'), data.dependencies).passed, true);
  assert.equal(fs.readFileSync(data.sourceOut, 'utf8'), original);
});

test('uncommitted ambiguous timeout stays unresolved without blind replay or another tab', context => {
  const data = operator(context);
  main(data.args('preflight'), data.dependencies);
  data.state.failBeforeSeed = true;
  assert.equal(main(data.args('seed'), data.dependencies).passed, false);
  assert.equal(main(data.args('reconcile'), data.dependencies).passed, false);
  assert.equal(main(data.args('seed'), data.dependencies).passed, false);
  assert.equal(data.state.calls.filter(call => call === 'seed').length, 1);
  assert.equal(fs.existsSync(data.sourceOut), false);
});

for (const mismatch of ['metadata', 'fixture-hash', 'source-output', 'held-lock']) test(`${mismatch} mismatch refuses without new provider work`, context => {
  const data = operator(context);
  main(data.args('preflight'), data.dependencies);
  if (mismatch === 'metadata') { data.metadata.baselineSheetName = 'Other'; data.save(data.metadataFile, data.metadata); }
  if (mismatch === 'fixture-hash') {
    const record = JSON.parse(fs.readFileSync(data.checkpoint, 'utf8'));
    record.rowsSha256 = '0'.repeat(64);
    data.save(data.checkpoint, record);
  }
  if (mismatch === 'source-output') data.save(data.sourceOut, { existing: true });
  if (mismatch === 'held-lock') data.save(`${data.checkpoint}.lock`, {});
  const before = data.state.calls.length;
  assert.equal(main(data.args('seed'), data.dependencies).passed, false);
  assert.equal(data.state.calls.length, before);
});

test('wrong spreadsheet, invalid account and unsafe private files refuse before any child', context => {
  const data = operator(context);
  for (const change of [{ spreadsheetId: 'other' }, { expectedSaEmail: 'forged@example.com' }]) {
    data.save(data.metadataFile, { ...data.metadata, ...change });
    assert.equal(main(data.args('preflight'), data.dependencies).passed, false);
  }
  data.save(data.metadataFile, data.metadata);
  fs.chmodSync(data.metadataFile, 0o644);
  assert.equal(main(data.args('preflight'), data.dependencies).passed, false);
  assert.equal(data.state.calls.length, 0);
});

test('inspection authenticates fresh exact SA and reads only about, edit capability and full-grid selected fields', async () => {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'private token sentinel' });
    assert.equal(options.headers.authorization, 'Bearer private token sentinel');
    if (url.pathname.endsWith('/about')) return Response.json({ user: { emailAddress: expectedEmail } });
    if (url.hostname === 'www.googleapis.com') return Response.json({ id: spreadsheetId, mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false, capabilities: { canEdit: true } });
    assert.equal(url.pathname, `/v4/spreadsheets/${spreadsheetId}`);
    assert.equal(url.searchParams.has('ranges'), false);
    assert.ok(url.searchParams.get('fields').includes('rowData(values(userEnteredValue,effectiveValue))'));
    return Response.json({ spreadsheetId, sheets: [blankSheet()] });
  };
  const auth = { readServiceAccount: () => ({ client_email: expectedEmail }), getAccessToken: async () =>
    (await (await global.fetch('https://oauth2.googleapis.com/token', { method: 'POST' })).json()).access_token };
  const original = global.fetch;
  const result = await inspect({ expectedEmail, auth, fetchImpl });
  assert.equal(global.fetch, original);
  assert.equal(result.exactAccountVerified, true);
  assert.equal(result.canEdit, true);
  assert.equal(calls.length, 4);
  assert.ok(!JSON.stringify(result).includes('private token sentinel'));
});

for (const refusal of ['wrong-account', 'wrong-about', 'no-edit', 'wrong-file', 'trashed', 'sheets-403', 'redirect', 'oversize']) {
  test(`provider ${refusal} refusal is read-only and cannot seed`, async () => {
    const auth = { readServiceAccount: () => ({ client_email: refusal === 'wrong-account' ? 'other@fixture.iam.gserviceaccount.com' : expectedEmail }),
      getAccessToken: async () => (await (await global.fetch('https://oauth2.googleapis.com/token', { method: 'POST' })).json()).access_token };
    let mutations = 0;
    await assert.rejects(inspect({ expectedEmail, auth, fetchImpl: async (input, options) => {
      const url = new URL(input);
      if (options.method === 'POST' && url.hostname !== 'oauth2.googleapis.com') mutations++;
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic' });
      if (url.pathname.endsWith('/about')) return Response.json({ user: { emailAddress: refusal === 'wrong-about' ? 'other' : expectedEmail } });
      if (url.hostname === 'www.googleapis.com') return Response.json({ id: refusal === 'wrong-file' ? 'other' : spreadsheetId,
        mimeType: 'application/vnd.google-apps.spreadsheet', trashed: refusal === 'trashed', capabilities: { canEdit: refusal !== 'no-edit' } });
      if (refusal === 'sheets-403') return Response.json({ error: { message: 'secret sentinel' } }, { status: 403 });
      if (refusal === 'redirect') return new Response(null, { status: 302 });
      if (refusal === 'oversize') return new Response('x', { headers: { 'content-length': '4194305' } });
      return Response.json({ spreadsheetId, sheets: [blankSheet()] });
    } }));
    assert.equal(mutations, 0);
  });
}

for (const conflict of ['receipt-missing', 'receipt-payload', 'source-gid', 'source-value', 'extra-cell', 'formula']) {
  test(`seed ${conflict} readback refuses to claim verified source`, () => {
    const grid = seededGrid();
    const source = grid.sheets[1];
    if (conflict === 'receipt-missing') source.developerMetadata = [];
    if (conflict === 'receipt-payload') source.developerMetadata[0].metadataValue = JSON.stringify({ operationHash, payloadHash: 'wrong' });
    if (conflict === 'source-gid') source.properties.sheetId++;
    if (conflict === 'source-value') source.data[0].rowData[1].values[2].effectiveValue.numberValue++;
    if (conflict === 'extra-cell') source.data.push({ startRow: 1000, rowData: [{ values: [{ userEnteredValue: { stringValue: 'extra' } }] }] });
    if (conflict === 'formula') source.data[0].rowData[1].values[2].userEnteredValue = { formulaValue: '=120' };
    assert.throws(() => inspectGrid(grid));
  });
}

test('actual fixture operation handler passes strict one-batch guard; legacy edits and foreign resources fail before fetch', async context => {
  const auth = require('../src/gdrive/google-auth.js');
  context.mock.method(auth, 'readServiceAccount', () => ({ client_email: expectedEmail }));
  context.mock.method(auth, 'getAccessToken', async () => 'synthetic');
  const modulePath = require.resolve('../src/mcp-skills/tools/50-gdrive.js');
  delete require.cache[modulePath];
  context.after(() => { delete require.cache[modulePath]; });
  const { tools } = require(modulePath);
  let committed = false;
  let mutations = 0;
  const guarded = guardedFetch('seed', async (input, options) => {
    if (options.method === 'POST') { committed = true; mutations++; return Response.json({}); }
    if (String(input).includes('/values/')) return Response.json({ values: fixture.rows });
    const grid = committed ? seededGrid() : { spreadsheetId, sheets: [blankSheet()] };
    return Response.json(grid);
  });
  context.mock.method(global, 'fetch', guarded);
  const result = await tools.gdrive_write_sheet.handler({ spreadsheet_id: spreadsheetId, sheet_name: 'Expenses',
    rows: fixture.rows, operationId: 'google-expenses-v1:source' });
  assert.equal(result.verified, true);
  assert.equal(mutations, 1);
  assert.equal(inspectGrid(seededGrid()).seed.rowsSha256, rowsSha256);
  for (const [url, options] of [
    [`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: [{ deleteSheet: { sheetId: 1056899445 } }] }) }],
    [`https://sheets.googleapis.com/v4/spreadsheets/other:batchUpdate`, { method: 'POST', body: '{}' }],
    ['https://www.googleapis.com/drive/v3/files', { method: 'POST', body: '{}' }],
  ]) await assert.rejects(guardedFetch('seed', async () => { assert.fail('forbidden request must not reach provider'); })(url, options));
});
