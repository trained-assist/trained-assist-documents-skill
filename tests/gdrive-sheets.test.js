'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../src/gdrive/google-auth');

function loadTools(context, connected = true) {
  context.mock.method(auth, 'readServiceAccount', () => connected ? { client_email: 'sandbox@example.invalid' } : null);
  context.mock.method(auth, 'getAccessToken', async () => 'synthetic-offline-token');
  const modulePath = require.resolve('../src/mcp-skills/tools/50-gdrive');
  delete require.cache[modulePath];
  context.after(() => { delete require.cache[modulePath]; });
  return require(modulePath);
}

function fakeGoogle(context) {
  const state = {
    sheets: [{ properties: { sheetId: 0, title: 'Expenses' }, values: [['source', 100]], developerMetadata: [] }],
    calls: [], folder: { mimeType: 'application/vnd.google-apps.folder', driveId: 'isolated-drive', capabilities: { canAddChildren: true } },
    loseBeforeCommit: false, loseAfterCommit: false, failReadback: false, rejectWrite: null,
  };
  const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(data) });
  const parseRange = (path) => {
    const match = path.match(/\/values\/('(?:[^']|'')*')(?:!(.*))?$/);
    assert.ok(match, `quoted tab range: ${path}`);
    const title = match[1].slice(1, -1).replace(/''/g, "'");
    const sheet = state.sheets.find(entry => entry.properties.title === title);
    assert.ok(sheet, `tab exists: ${title}`);
    return { sheet, range: match[2] };
  };
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    const address = new URL(url);
    const path = decodeURIComponent(address.pathname);
    const body = options.body ? JSON.parse(options.body) : null;
    state.calls.push({ path, method: options.method, query: address.searchParams, body });
    assert.ok(options.signal, 'every provider call has a deadline');
    if (path.startsWith('/drive/v3/files/') && options.method === 'GET') return response(state.folder);
    if (path === '/drive/v3/files' && options.method === 'POST') return response({ id: 'test-spreadsheet', name: body.name });
    if (path.includes('/values/')) {
      const { sheet, range } = parseRange(path.replace(/:clear$/, ''));
      if (options.method === 'GET') {
        if (state.failReadback) throw new Error('offline read failure');
        const match = range.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
        const column = (name) => [...name].reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0);
        const values = sheet.values.slice(Number(match[2]) - 1, Number(match[4] || match[2])).map(row => {
          const cells = row.slice(column(match[1]) - 1, column(match[3] || match[1]));
          while (cells[cells.length - 1] === '') cells.pop();
          return cells;
        });
        while (values.length && !values[values.length - 1].length) values.pop();
        return response({ range: `${sheet.properties.title}!${range}`, values });
      }
      if (options.method === 'POST') { sheet.values = []; return response({}); }
      sheet.values = structuredClone(body.values);
      return response({ updatedRows: body.values.length });
    }
    if (options.method === 'GET') {
      assert.match(address.searchParams.get('fields'), /sheets/);
      return response({ sheets: state.sheets.map(({ properties, developerMetadata }) => ({ properties, developerMetadata })) });
    }
    assert.ok(path.endsWith(':batchUpdate'));
    if (state.rejectWrite) return response({ error: { message: 'provider rejected write' } }, state.rejectWrite);
    if (state.loseBeforeCommit) { state.loseBeforeCommit = false; throw new Error('lost request'); }
    const properties = body.requests[0].addSheet.properties;
    if (state.sheets.some(sheet => sheet.properties.title === properties.title || (properties.sheetId !== undefined && sheet.properties.sheetId === properties.sheetId))) {
      return response({ error: { message: 'tab already exists' } }, 400);
    }
    const sheet = { properties: { sheetId: properties.sheetId ?? 123, ...properties }, values: [], developerMetadata: [] };
    for (const request of body.requests.slice(1)) {
      if (request.updateCells) {
        assert.equal(request.updateCells.start.sheetId, sheet.properties.sheetId);
        assert.equal(request.updateCells.fields, 'userEnteredValue');
        sheet.values = request.updateCells.rows.map(row => row.values.map(cell => Object.values(cell.userEnteredValue)[0]));
      } else {
        assert.equal(request.createDeveloperMetadata.developerMetadata.location.sheetId, sheet.properties.sheetId);
        sheet.developerMetadata.push(request.createDeveloperMetadata.developerMetadata);
      }
    }
    state.sheets.push(sheet);
    if (state.loseAfterCommit) { state.loseAfterCommit = false; throw new Error('lost response'); }
    return response({ replies: [{ addSheet: { properties: sheet.properties } }] });
  });
  return state;
}

const writeRequest = (extra = {}) => ({
  spreadsheet_id: 'test-spreadsheet', sheet_name: 'Results',
  rows: [['Category', 'Amount', 'Confirmed'], ['Food', 125, true]],
  operationId: 'task-140:category-result', source_sheet_name: 'Expenses', ...extra,
});
const mutations = (state) => state.calls.filter(call => call.method !== 'GET');

test('create spreadsheet checks Shared Drive capability and creates native Sheets in that folder', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  const result = await tools.gdrive_create_spreadsheet.handler({ title: 'Sandbox expenses', folder_id: 'test-folder' });
  assert.equal(result.spreadsheet_id, 'test-spreadsheet');
  assert.equal(result.created, true);
  assert.deepEqual(mutations(state)[0].body, { name: 'Sandbox expenses', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['test-folder'] });
  assert.equal(mutations(state)[0].query.get('supportsAllDrives'), 'true');
});

test('creation refuses personal Drive and unwritable folders before mutation', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  delete state.folder.driveId;
  await assert.rejects(tools.gdrive_create_spreadsheet.handler({ title: 'Test', folder_id: 'test-folder' }), { code: 'SHEETS_FOLDER_UNAVAILABLE' });
  state.folder.driveId = 'test-drive';
  state.folder.capabilities.canAddChildren = false;
  await assert.rejects(tools.gdrive_create_spreadsheet.handler({ title: 'Test', folder_id: 'test-folder' }), { code: 'SHEETS_FOLDER_UNAVAILABLE' });
  assert.equal(mutations(state).length, 0);
});

test('new tools retain service-account readiness gating and fail closed without credentials', async (context) => {
  const module = loadTools(context, false);
  const state = fakeGoogle(context);
  assert.equal(module.isReady(), false);
  assert.ok(!module.setupTools.includes('gdrive_read_sheet'));
  assert.ok(!module.setupTools.includes('gdrive_create_spreadsheet'));
  await assert.rejects(module.tools.gdrive_read_sheet.handler({ spreadsheet_id: 'test-spreadsheet', sheet_name: 'Expenses' }), /Google Drive не настроен/);
  await assert.rejects(module.tools.gdrive_create_spreadsheet.handler({ title: 'Test', folder_id: 'test-folder' }), /Google Drive не настроен/);
  assert.equal(state.calls.length, 0);
});

test('private readback quotes apostrophes and reads the requested tab rectangle', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  state.sheets.push({ properties: { sheetId: 9, title: "Owner's results" }, values: [['ignore'], ['ignore', 'Food', 125], ['ignore', 'Travel', 40]] });
  const result = await tools.gdrive_read_sheet.handler({ spreadsheet_id: 'test-spreadsheet', sheet_name: "Owner's results", range: 'B2:C3' });
  assert.deepEqual(result.values, [['Food', 125], ['Travel', 40]]);
  assert.equal(result.row_count, 2);
  assert.match(state.calls[0].path, /'Owner''s results'!B2:C3$/);
  assert.equal(state.calls[0].query.get('valueRenderOption'), 'UNFORMATTED_VALUE');
  assert.equal(mutations(state).length, 0);
});

test('readback rejects unbounded, reversed and injected ranges before network access', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  for (const range of ['A:Z', 'Other!A1:B2', 'C3:A1', 'A1:Z99999', 'A0:B2']) {
    await assert.rejects(tools.gdrive_read_sheet.handler({ spreadsheet_id: 'test-spreadsheet', sheet_name: 'Expenses', range }), { code: 'SHEETS_INVALID_INPUT' });
  }
  assert.equal(state.calls.length, 0);
});

test('private readback handles a single cell and empty ranges', async (context) => {
  const { tools } = loadTools(context);
  fakeGoogle(context);
  assert.deepEqual((await tools.gdrive_read_sheet.handler({ spreadsheet_id: 'test-spreadsheet', sheet_name: 'Expenses', range: 'B1' })).values, [[100]]);
  assert.deepEqual((await tools.gdrive_read_sheet.handler({ spreadsheet_id: 'test-spreadsheet', sheet_name: 'Expenses', range: 'B9:C10' })).values, []);
});

test('default readback fits a newly created small result grid', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  await tools.gdrive_write_sheet.handler(writeRequest());
  const result = await tools.gdrive_read_sheet.handler({ spreadsheet_id: 'test-spreadsheet', sheet_name: 'Results' });
  assert.deepEqual(result.values, writeRequest().rows);
  assert.match(state.calls[state.calls.length - 1].path, /'Results'!A1:C2$/);
});

test('operation write commits tab, literal cells and receipt together, then verifies and preserves source', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  const result = await tools.gdrive_write_sheet.handler(writeRequest({ rows: [['=literal', null, true], ['Food', 125]] }));
  assert.equal(result.verified, true);
  assert.equal(result.deduplicated, false);
  assert.equal(mutations(state).length, 1);
  assert.equal(mutations(state)[0].body.requests.length, 3);
  assert.deepEqual(mutations(state)[0].body.requests[0].addSheet.properties.gridProperties, { rowCount: 2, columnCount: 3 });
  assert.deepEqual(state.sheets[0].values, [['source', 100]]);
  assert.deepEqual(state.sheets[1].values, [['=literal', '', true], ['Food', 125, '']]);
  assert.doesNotMatch(JSON.stringify(state.sheets[1].developerMetadata), /task-140:category-result/);
  assert.ok(state.calls.some(call => call.method === 'GET' && call.path.includes('/values/')));
});

test('lost commit response is reconciled, and a fresh module replays without another mutation', async (context) => {
  let module = loadTools(context);
  const state = fakeGoogle(context);
  state.loseAfterCommit = true;
  const recovered = await module.tools.gdrive_write_sheet.handler(writeRequest());
  assert.equal(recovered.deduplicated, true);
  delete require.cache[require.resolve('../src/mcp-skills/tools/50-gdrive')];
  module = require('../src/mcp-skills/tools/50-gdrive');
  const repeated = await module.tools.gdrive_write_sheet.handler(writeRequest());
  assert.equal(repeated.verified, true);
  assert.equal(repeated.deduplicated, true);
  assert.equal(mutations(state).length, 1);
});

test('unknown write outcome never blindly retries; explicit same-operation retry can recover', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  state.loseBeforeCommit = true;
  await assert.rejects(tools.gdrive_write_sheet.handler(writeRequest()), { code: 'SHEETS_OUTCOME_UNKNOWN' });
  assert.equal(mutations(state).length, 1);
  assert.equal(state.sheets.length, 1);
  const result = await tools.gdrive_write_sheet.handler(writeRequest());
  assert.equal(result.verified, true);
  assert.equal(state.sheets.length, 2);
});

test('same-operation changed rows or target conflict without mutation', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  await tools.gdrive_write_sheet.handler(writeRequest());
  await assert.rejects(tools.gdrive_write_sheet.handler(writeRequest({ rows: [['changed']] })), { code: 'SHEETS_OPERATION_CONFLICT' });
  await assert.rejects(tools.gdrive_write_sheet.handler(writeRequest({ sheet_name: 'Monthly results' })), { code: 'SHEETS_OPERATION_CONFLICT' });
  assert.equal(mutations(state).length, 1);
});

test('existing source/unowned tabs cannot be cleared by an operation, even with clear_first true', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  await assert.rejects(tools.gdrive_write_sheet.handler(writeRequest({ sheet_name: 'Expenses', source_sheet_name: undefined })), { code: 'SHEETS_TARGET_EXISTS' });
  await assert.rejects(tools.gdrive_write_sheet.handler(writeRequest({ sheet_name: 'Expenses', operationId: undefined })), { code: 'SHEETS_SOURCE_PROTECTED' });
  assert.equal(mutations(state).length, 0);
  assert.deepEqual(state.sheets[0].values, [['source', 100]]);
});

test('concurrent duplicate operations leave one tab and both return verified results', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  const results = await Promise.all([tools.gdrive_write_sheet.handler(writeRequest()), tools.gdrive_write_sheet.handler(writeRequest())]);
  assert.ok(results.every(result => result.verified));
  assert.ok(results.some(result => result.deduplicated));
  assert.equal(state.sheets.length, 2);
  assert.equal(state.sheets[1].developerMetadata.length, 1);
});

test('concurrent differing payloads with the same operation cannot both commit', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  const results = await Promise.allSettled([tools.gdrive_write_sheet.handler(writeRequest()), tools.gdrive_write_sheet.handler(writeRequest({ sheet_name: 'Different target' }))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'SHEETS_OPERATION_CONFLICT');
  assert.equal(state.sheets.length, 2);
});

test('changed committed cells are reported as conflict instead of rewritten', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  await tools.gdrive_write_sheet.handler(writeRequest());
  state.sheets[1].values[1][1] = 999;
  await assert.rejects(tools.gdrive_write_sheet.handler(writeRequest()), { code: 'SHEETS_OPERATION_CONFLICT' });
  assert.equal(mutations(state).length, 1);
  assert.equal(state.sheets[1].values[1][1], 999);
});

test('failed reconciliation never reports success or repeats the mutation', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  state.loseAfterCommit = true;
  state.failReadback = true;
  await assert.rejects(tools.gdrive_write_sheet.handler(writeRequest()), { code: 'SHEETS_OUTCOME_UNKNOWN' });
  assert.equal(mutations(state).length, 1);
  state.failReadback = false;
  assert.equal((await tools.gdrive_write_sheet.handler(writeRequest())).deduplicated, true);
  assert.equal(mutations(state).length, 1);
});

test('successful write with unreadable verification returns unknown and can be reconciled later', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  state.failReadback = true;
  await assert.rejects(tools.gdrive_write_sheet.handler(writeRequest()), { code: 'SHEETS_OUTCOME_UNKNOWN' });
  assert.equal(mutations(state).length, 1);
  state.failReadback = false;
  assert.equal((await tools.gdrive_write_sheet.handler(writeRequest())).deduplicated, true);
  assert.equal(mutations(state).length, 1);
});

test('known provider refusal preserves status and does not retry or create a tab', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  state.rejectWrite = 403;
  await assert.rejects(tools.gdrive_write_sheet.handler(writeRequest()), { code: 'SHEETS_API_ERROR', status: 403 });
  assert.equal(mutations(state).length, 1);
  assert.equal(state.sheets.length, 1);
});

test('invalid operation and cell data do not reach Sheets', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  for (const extra of [{ operationId: '' }, { rows: [['x', {}]] }, { rows: [[NaN]] }, { rows: [[]] }, { rows: [['x'.repeat(2_000_001)]] }]) {
    await assert.rejects(tools.gdrive_write_sheet.handler(writeRequest(extra)), { code: 'SHEETS_INVALID_INPUT' });
  }
  assert.equal(state.calls.length, 0);
});

test('legacy writes preserve clearing and USER_ENTERED defaults; clear_first false still opts out', async (context) => {
  const { tools } = loadTools(context);
  const state = fakeGoogle(context);
  const request = { spreadsheet_id: 'test-spreadsheet', sheet_name: 'Expenses', rows: [['legacy', '=1+1']] };
  const result = await tools.gdrive_write_sheet.handler(request);
  assert.deepEqual(result, { written: true, spreadsheet_id: 'test-spreadsheet', sheet_name: 'Expenses', rows_written: 1, tab_created: false, url: 'https://docs.google.com/spreadsheets/d/test-spreadsheet' });
  assert.equal(mutations(state)[0].method, 'POST');
  assert.equal(mutations(state)[1].query.get('valueInputOption'), 'USER_ENTERED');
  await tools.gdrive_write_sheet.handler({ ...request, clear_first: false });
  assert.equal(mutations(state).filter(call => call.path.endsWith(':clear')).length, 1);
});
