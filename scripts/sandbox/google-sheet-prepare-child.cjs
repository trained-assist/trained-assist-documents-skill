'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fixture = require('../fixtures/google-expenses-v1.json');
const { expectedAccount } = require('./google-provider-verify-child.cjs');

const spreadsheetId = '1KTYuKw-hzM5bJCHbhnm-TG63oApHX_KhuuGT2CeWaxg';
const operationId = 'google-expenses-v1:source';
const digest = value => createHash('sha256').update(value).digest('hex');
const operationHash = digest(operationId);
const payloadHash = digest(JSON.stringify({ spreadsheet_id: spreadsheetId, sheet_name: fixture.source_sheet_name, values: fixture.rows }));
const sourceSheetId = parseInt(operationHash.slice(0, 8), 16) & 0x7fffffff;
const rowsSha256 = digest(JSON.stringify(fixture.rows));
const sheetsBase = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
const oauthUrl = 'https://oauth2.googleapis.com/token';
const aboutUrl = 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)';
const driveUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?supportsAllDrives=true&fields=id,mimeType,trashed,capabilities(canEdit)`;
const gridUrl = `${sheetsBase}?fields=spreadsheetId,sheets(properties,data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue))),developerMetadata),developerMetadata`;
const fixtureReads = [
  `${sheetsBase}?fields=sheets(properties,developerMetadata),developerMetadata`,
  `${sheetsBase}/values/${encodeURIComponent("'Expenses'!A1:D9")}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
];

async function boundedJson(response) {
  assert.ok(response.body && Number(response.headers.get('content-length') ?? 0) <= 4194304);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
        assert.ok(body && typeof body === 'object' && !Array.isArray(body));
        return body;
      }
      size += chunk.value.byteLength;
      assert.ok(size <= 4194304);
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

function guardedFetch(mode, fetchImpl) {
  let requests = 0;
  let mutations = 0;
  let tokens = 0;
  const guarded = async (input, options = {}) => {
    const url = String(input);
    const method = options.method ?? 'GET';
    assert.ok(++requests <= 25);
    if (url === oauthUrl) {
      assert.equal(method, 'POST');
      assert.equal(++tokens, 1);
    } else if (mode === 'inspect') {
      assert.equal(method, 'GET');
      assert.ok([aboutUrl, driveUrl, gridUrl].includes(url));
    } else if (url === `${sheetsBase}:batchUpdate`) {
      assert.equal(mode, 'seed');
      assert.equal(method, 'POST');
      assert.equal(++mutations, 1);
      assert.deepEqual(JSON.parse(options.body), { requests: [
        { addSheet: { properties: { sheetId: sourceSheetId, title: fixture.source_sheet_name,
          gridProperties: { rowCount: fixture.rows.length, columnCount: fixture.rows[0].length } } } },
        { updateCells: { start: { sheetId: sourceSheetId, rowIndex: 0, columnIndex: 0 },
          rows: fixture.rows.map(row => ({ values: row.map(value => ({ userEnteredValue: {
            [typeof value === 'number' ? 'numberValue' : 'stringValue']: value,
          } })) })), fields: 'userEnteredValue' } },
        { createDeveloperMetadata: { developerMetadata: { metadataKey: 'trained_assist_sheet_operation_v1',
          metadataValue: JSON.stringify({ operationHash, payloadHash }), location: { sheetId: sourceSheetId }, visibility: 'DOCUMENT' } } },
      ] });
    } else {
      assert.equal(mode, 'seed');
      assert.equal(method, 'GET');
      assert.ok(fixtureReads.includes(url));
    }
    const response = await fetchImpl(input, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    return Response.json(await boundedJson(response), { status: response.status });
  };
  guarded.tokenCalls = () => tokens;
  return guarded;
}

function nonemptyCells(sheet) {
  const cells = new Map();
  assert.ok(sheet.data === undefined || Array.isArray(sheet.data));
  for (const block of sheet.data ?? []) {
    const startRow = block.startRow ?? 0;
    const startColumn = block.startColumn ?? 0;
    assert.ok(Number.isSafeInteger(startRow) && startRow >= 0 && Number.isSafeInteger(startColumn) && startColumn >= 0);
    assert.ok(block.rowData === undefined || Array.isArray(block.rowData));
    (block.rowData ?? []).forEach((row, rowIndex) => {
      assert.ok(row.values === undefined || Array.isArray(row.values));
      (row.values ?? []).forEach((cell, columnIndex) => {
        const entered = cell.userEnteredValue ?? {};
        const effective = cell.effectiveValue ?? {};
        if (!Object.keys(entered).length && !Object.keys(effective).length) return;
        const key = `${startRow + rowIndex}:${startColumn + columnIndex}`;
        assert.ok(!cells.has(key));
        cells.set(key, { entered, effective });
      });
    });
  }
  return cells;
}

function inspectGrid(grid) {
  assert.equal(grid.spreadsheetId, spreadsheetId);
  assert.ok(Array.isArray(grid.sheets) && grid.sheets.length > 0 && grid.sheets.length <= 50);
  const sheets = [];
  const ids = new Set();
  const titles = new Set();
  for (const sheet of grid.sheets) {
    const props = sheet.properties;
    assert.ok(props && Number.isSafeInteger(props.sheetId) && props.sheetId >= 0 && !ids.has(props.sheetId));
    assert.ok(typeof props.title === 'string' && props.title.length > 0 && props.title.length <= 100 && !titles.has(props.title));
    assert.equal(props.sheetType, 'GRID');
    assert.ok(Number.isSafeInteger(props.gridProperties?.rowCount) && props.gridProperties.rowCount > 0
      && Number.isSafeInteger(props.gridProperties?.columnCount) && props.gridProperties.columnCount > 0);
    ids.add(props.sheetId);
    titles.add(props.title);
    sheets.push({ sheetId: props.sheetId, title: props.title, rowCount: props.gridProperties.rowCount,
      columnCount: props.gridProperties.columnCount, blank: nonemptyCells(sheet).size === 0 });
  }
  const source = grid.sheets.find(sheet => sheet.properties.title === fixture.source_sheet_name);
  let seed = null;
  if (source) {
    assert.equal(source.properties.sheetId, sourceSheetId);
    const receipts = [...(grid.developerMetadata ?? []), ...grid.sheets.flatMap(sheet => sheet.developerMetadata ?? [])]
      .filter(entry => entry.metadataKey === 'trained_assist_sheet_operation_v1')
      .map(entry => ({ entry, value: JSON.parse(entry.metadataValue) }))
      .filter(receipt => receipt.value.operationHash === operationHash);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].value.payloadHash, payloadHash);
    assert.equal(receipts[0].entry.location?.sheetId, sourceSheetId);
    const cells = nonemptyCells(source);
    assert.equal(cells.size, fixture.rows.length * fixture.rows[0].length);
    const actualRows = fixture.rows.map((row, rowIndex) => row.map((value, columnIndex) => {
      const cell = cells.get(`${rowIndex}:${columnIndex}`);
      const typed = { [typeof value === 'number' ? 'numberValue' : 'stringValue']: value };
      assert.deepEqual(cell?.entered, typed);
      assert.deepEqual(cell?.effective, typed);
      return cell.effective[typeof value === 'number' ? 'numberValue' : 'stringValue'];
    }));
    seed = { sheetId: sourceSheetId, rowsSha256: digest(JSON.stringify(actualRows)), receiptVerified: true, rowsVerified: true };
  }
  return { sheets, seed };
}

async function inspect({ expectedEmail, auth, fetchImpl = global.fetch }) {
  const originalFetch = global.fetch;
  try {
    assert.ok(expectedAccount(expectedEmail));
    const account = auth.readServiceAccount('sandbox-integrator-google');
    assert.equal(account?.client_email, expectedEmail);
    global.fetch = guardedFetch('inspect', fetchImpl);
    const token = await auth.getAccessToken(account);
    assert.ok(typeof token === 'string' && token.trim() && global.fetch.tokenCalls() === 1);
    const get = async url => (await global.fetch(url, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal((await get(aboutUrl)).user?.emailAddress, expectedEmail);
    const drive = await get(driveUrl);
    assert.equal(drive.id, spreadsheetId);
    assert.equal(drive.mimeType, 'application/vnd.google-apps.spreadsheet');
    assert.equal(drive.trashed, false);
    assert.equal(drive.capabilities?.canEdit, true);
    return { schemaVersion: 'google-sheet-inspection-v1', spreadsheetId, exactAccountVerified: true, canEdit: true,
      ...inspectGrid(await get(gridUrl)) };
  } finally { global.fetch = originalFetch; }
}

module.exports = { spreadsheetId, operationId, operationHash, payloadHash, sourceSheetId, rowsSha256, inspect, inspectGrid, guardedFetch };
if (require.main === module) {
  (async () => {
    const [mode, expectedEmail] = process.argv.slice(2);
    assert.ok(['inspect', 'seed'].includes(mode) && expectedAccount(expectedEmail));
    assert.equal(process.env.USER_ID, 'sandbox-integrator-google');
    const auth = require('../../src/gdrive/google-auth.js');
    if (mode === 'inspect') return inspect({ expectedEmail, auth });
    assert.equal(auth.readServiceAccount('sandbox-integrator-google')?.client_email, expectedEmail);
    global.fetch = guardedFetch('seed', global.fetch);
    const fixturePath = require.resolve('./google-expenses-fixture.cjs');
    process.argv = [process.execPath, fixturePath, '--seed', '--profile', 'sandbox-integrator-google',
      '--tokens-dir', process.env.AGENT_TOKENS_DIR, '--confirm-isolated-binding', 'sandbox-integrator-google', '--spreadsheet-id', spreadsheetId];
    require(fixturePath);
    return null;
  })().then(report => { if (report) process.stdout.write(JSON.stringify(report) + '\n'); }).catch(() => {
    process.stderr.write('Google sheet preparation child refused.\n');
    process.exitCode = 1;
  });
}
