'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const auth = require('../src/gdrive/google-auth');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

async function redirectFixture(context, status) {
  const state = { initial: [], forwarded: [] };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const captured = { method: request.method, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() };
    if (request.url === '/redirect') {
      state.initial.push(captured);
      response.writeHead(status, { Location: '/receiver' });
      response.end();
    } else {
      state.forwarded.push(captured);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'synthetic-forwarded-token', values: [], id: 'redirect-created-sheet', name: 'Offline redirect test' }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { state, url: `http://127.0.0.1:${server.address().port}/redirect` };
}

function loadTools(context) {
  context.mock.method(auth, 'readServiceAccount', () => ({ client_email: 'offline@example.invalid' }));
  context.mock.method(auth, 'getAccessToken', async () => 'synthetic-offline-token');
  const modulePath = require.resolve('../src/mcp-skills/tools/50-gdrive');
  delete require.cache[modulePath];
  context.after(() => { delete require.cache[modulePath]; });
  return require(modulePath).tools;
}

for (const status of [307, 308]) {
  test(`OAuth ${status} refuses redirect without replaying the signed JWT`, async context => {
    const fixture = await redirectFixture(context, status);
    const nativeFetch = globalThis.fetch;
    let calls = 0;
    context.mock.method(globalThis, 'fetch', (url, options) => {
      calls += 1;
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(options.redirect, 'error');
      return nativeFetch(fixture.url, options);
    });
    await assert.rejects(auth.getAccessToken({
      client_email: `redirect-${status}@example.invalid`,
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }), TypeError);
    assert.equal(calls, 1);
    assert.equal(fixture.state.initial.length, 1);
    assert.equal(fixture.state.initial[0].method, 'POST');
    assert.match(fixture.state.initial[0].body, /assertion=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    assert.deepEqual(fixture.state.forwarded, []);
  });

  for (const operation of ['read', 'write']) {
    test(`Sheets ${operation} ${status} refuses redirect without forwarding bearer or body`, async context => {
      const fixture = await redirectFixture(context, status);
      const nativeFetch = globalThis.fetch;
      const tools = loadTools(context);
      let redirectedCalls = 0;
      context.mock.method(globalThis, 'fetch', (url, options) => {
        assert.equal(new URL(url).origin, 'https://sheets.googleapis.com');
        assert.equal(options.redirect, 'error');
        if (operation === 'write' && options.method === 'GET') {
          return Promise.resolve({ ok: true, json: async () => ({ sheets: [{ properties: { title: 'Results', sheetId: 1 } }] }) });
        }
        redirectedCalls += 1;
        return nativeFetch(fixture.url, options);
      });
      const pending = operation === 'read'
        ? tools.gdrive_read_sheet.handler({ spreadsheet_id: 'offline-sheet', sheet_name: 'Results' })
        : tools.gdrive_write_sheet.handler({ spreadsheet_id: 'offline-sheet', sheet_name: 'Results', rows: [['offline', 1]], clear_first: false });
      await assert.rejects(pending, TypeError);
      assert.equal(redirectedCalls, 1);
      assert.equal(fixture.state.initial.length, 1);
      assert.equal(fixture.state.initial[0].authorization, 'Bearer synthetic-offline-token');
      assert.equal(fixture.state.initial[0].method, operation === 'read' ? 'GET' : 'PUT');
      assert.equal(fixture.state.initial[0].body, operation === 'read' ? '' : JSON.stringify({ values: [['offline', 1]] }));
      assert.deepEqual(fixture.state.forwarded, []);
    });
  }

  for (const boundary of ['folder', 'creation']) {
    test(`Drive spreadsheet ${boundary} ${status} refuses redirect without replay or false created success`, async context => {
      const fixture = await redirectFixture(context, status);
      const nativeFetch = globalThis.fetch;
      const tools = loadTools(context);
      let calls = 0;
      let redirectedCalls = 0;
      context.mock.method(globalThis, 'fetch', (url, options) => {
        calls += 1;
        const address = new URL(url);
        assert.equal(address.origin, 'https://www.googleapis.com');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers.Authorization, 'Bearer synthetic-offline-token');
        if (boundary === 'creation' && options.method === 'GET') {
          assert.equal(address.pathname, '/drive/v3/files/approved-folder');
          return Promise.resolve({ ok: true, json: async () => ({
            mimeType: 'application/vnd.google-apps.folder', driveId: 'offline-shared-drive', capabilities: { canAddChildren: true },
          }) });
        }
        redirectedCalls += 1;
        assert.equal(address.pathname, boundary === 'folder' ? '/drive/v3/files/approved-folder' : '/drive/v3/files');
        return nativeFetch(fixture.url, options);
      });
      await assert.rejects(tools.gdrive_create_spreadsheet.handler({ title: 'Offline redirect test', folder_id: 'approved-folder' }), TypeError);
      assert.equal(calls, boundary === 'folder' ? 1 : 2);
      assert.equal(redirectedCalls, 1);
      assert.equal(fixture.state.initial.length, 1);
      const initial = fixture.state.initial[0];
      assert.equal(initial.authorization, 'Bearer synthetic-offline-token');
      assert.equal(initial.method, boundary === 'folder' ? 'GET' : 'POST');
      assert.equal(initial.body, boundary === 'folder' ? '' : JSON.stringify({
        name: 'Offline redirect test', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['approved-folder'],
      }));
      assert.deepEqual(fixture.state.forwarded, []);
    });
  }
}
