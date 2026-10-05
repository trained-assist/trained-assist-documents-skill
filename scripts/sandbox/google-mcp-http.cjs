'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { privatePath, childEnvironment, spawnDomain } = require('./google-mcp-host.cjs');
const versions = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);
const tools = new Set(['gdrive_create_spreadsheet', 'gdrive_read_sheet', 'gdrive_write_sheet']);
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const runUuid = /^run_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const safeErrors = new Set(['OWNER_TARGET_REQUIRED', 'TARGET_NOT_APPROVED', 'GOOGLE_TOOL_FAILED',
  'SHEETS_API_ERROR', 'SHEETS_FOLDER_UNAVAILABLE', 'SHEETS_INVALID_INPUT', 'SHEETS_OPERATION_CONFLICT',
  'SHEETS_OUTCOME_UNKNOWN', 'SHEETS_SOURCE_PROTECTED', 'SHEETS_TAB_NOT_FOUND', 'SHEETS_TARGET_EXISTS']);

function readBinding(runtime) {
  const file = path.join(runtime, 'http-binding.json');
  privatePath(file);
  const binding = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!runUuid.test(binding.runId || '') || !identifier.test(binding.userTaskId || '') || binding.profile !== 'sandbox-integrator-google' ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(binding.authToken || '') ||
      !Number.isFinite(Date.parse(binding.expiresAt)) || Date.parse(binding.expiresAt) <= Date.now() ||
      Date.parse(binding.expiresAt) > Date.now() + 86400000) throw new Error('INVALID_HTTP_BINDING');
  return binding;
}

function mintBinding({ runtime: runtimePath, runId, userTaskId, profile, expiresAt }) {
  privatePath(runtimePath, true);
  const runtime = fs.realpathSync(runtimePath);
  if (!runUuid.test(runId || '') || !identifier.test(userTaskId || '') || profile !== 'sandbox-integrator-google' ||
      !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now() ||
      Date.parse(expiresAt) > Date.now() + 86400000) throw new Error('INVALID_HTTP_BINDING');
  fs.writeFileSync(path.join(runtime, 'http-binding.json'), JSON.stringify({
    runId, userTaskId, profile, expiresAt, authToken: crypto.randomBytes(32).toString('base64url'),
  }) + '\n', { mode: 0o600, flag: 'wx' });
  return { runId, userTaskId, profile, expiresAt };
}

function equalToken(received, expected) {
  if (typeof received !== 'string' || received.length > 256) return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(received).digest(),
    crypto.createHash('sha256').update(`Bearer ${expected}`).digest());
}

function stdioRpc(child, timeoutMs = 30000, stopGraceMs = 250) {
  const pending = new Map();
  let sequence = 0;
  let buffer = '';
  let failed = false;
  let exited = false;
  let termination;
  function fail() {
    failed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('MCP_OUTCOME_UNKNOWN'));
    }
    pending.clear();
    if (!termination) {
      termination = new Promise((resolve, reject) => {
        if (exited) return resolve();
        let killTimer;
        let deadline;
        child.once('close', () => {
          clearTimeout(killTimer);
          clearTimeout(deadline);
          resolve();
        });
        child.kill('SIGTERM');
        if (exited) return resolve();
        killTimer = setTimeout(() => child.kill('SIGKILL'), stopGraceMs);
        deadline = setTimeout(() => reject(new Error('MCP_DOMAIN_STOP_FAILED')), stopGraceMs + 1000);
      });
      termination.catch(() => {});
    }
    return termination;
  }
  child.stderr.on('data', () => {});
  child.stdin.on('error', fail);
  child.on('error', fail);
  child.on('close', () => { exited = true; fail(); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) return fail();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const response = JSON.parse(line);
        const entry = pending.get(response.id);
        if (!entry || response.jsonrpc !== '2.0') return fail();
        pending.delete(response.id);
        clearTimeout(entry.timer);
        entry.resolve(response);
      } catch { return fail(); }
    }
  });
  return {
    call(method, params) {
      if (failed) return Promise.reject(new Error('MCP_UNAVAILABLE'));
      if (pending.size >= 8) return Promise.reject(new Error('MCP_BUSY'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(fail, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    close: fail,
  };
}

function jsonResponse(response, status, value) {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

async function requestBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 3 * 1024 * 1024) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function createHttpHost({ runtime: runtimePath, port = 0 }) {
  const env = childEnvironment(runtimePath, false);
  const runtime = env.GOOGLE_MCP_RUNTIME;
  const initial = readBinding(runtime);
  env.GOOGLE_MCP_RUN_ID = initial.runId;
  env.GOOGLE_MCP_USER_TASK_ID = initial.userTaskId;
  const rpc = stdioRpc(spawnDomain(env));
  try {
    const catalog = await rpc.call('tools/list', {});
    const names = catalog.result?.tools?.map(tool => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify([...tools].sort())) throw new Error();
  } catch { await rpc.close(); throw new Error('DOMAIN_NOT_READY'); }
  function authorize(request) {
    try {
      const binding = readBinding(runtime);
      if (binding.runId !== initial.runId || binding.userTaskId !== initial.userTaskId || binding.profile !== initial.profile ||
          !equalToken(request.headers.authorization, binding.authToken)) return { status: 401, error: 'AUTH_REQUIRED' };
      if (request.headers['x-mcp-run-id'] !== binding.runId || request.headers['x-mcp-profile'] !== binding.profile ||
          request.headers['x-mcp-user-task-id'] !== binding.userTaskId) return { status: 403, error: 'SCOPE_DENIED' };
      return null;
    } catch { return { status: 401, error: 'AUTH_REQUIRED' }; }
  }
  const server = http.createServer(async (request, response) => {
    try {
      const initialRefusal = authorize(request);
      if (initialRefusal) return jsonResponse(response, initialRefusal.status, { error: initialRefusal.error });
      const hosts = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
      if (request.headers.origin || !hosts.includes(request.headers.host)) {
        return jsonResponse(response, 403, { error: 'ORIGIN_DENIED' });
      }
      if (request.url !== '/mcp') return jsonResponse(response, 404, { error: 'NOT_FOUND' });
      if (request.method !== 'POST') return jsonResponse(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
        return jsonResponse(response, 415, { error: 'JSON_REQUIRED' });
      }
      if (!(request.headers.accept || '').includes('application/json')) {
        return jsonResponse(response, 406, { error: 'JSON_ACCEPT_REQUIRED' });
      }
      const version = request.headers['mcp-protocol-version'];
      if (version && !versions.has(version)) return jsonResponse(response, 400, { error: 'PROTOCOL_UNSUPPORTED' });
      let message;
      if (Number(request.headers['content-length']) > 3 * 1024 * 1024) {
        return jsonResponse(response, 413, { error: 'INVALID_MESSAGE' });
      }
      try { message = await requestBody(request); }
      catch (error) { return jsonResponse(response, error.message === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'INVALID_MESSAGE' }); }
      const dispatchRefusal = authorize(request);
      if (dispatchRefusal) return jsonResponse(response, dispatchRefusal.status, { error: dispatchRefusal.error });
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
          (message.id !== undefined && (typeof message.id !== 'number' && typeof message.id !== 'string')) ||
          (typeof message.id === 'number' && !Number.isFinite(message.id)) ||
          (typeof message.id === 'string' && message.id.length > 128)) {
        return jsonResponse(response, 400, { error: 'INVALID_MESSAGE' });
      }
      if (message.id === undefined) {
        if (!['notifications/initialized', 'notifications/cancelled'].includes(message.method)) {
          return jsonResponse(response, 400, { error: 'INVALID_NOTIFICATION' });
        }
        return jsonResponse(response, 202);
      }
      const refusal = { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'METHOD_NOT_ALLOWED' } };
      if (!['initialize', 'tools/list', 'tools/call', 'ping'].includes(message.method)) return jsonResponse(response, 200, refusal);
      if (message.method === 'tools/call' && !tools.has(message.params?.name)) return jsonResponse(response, 200, refusal);
      let result;
      if (message.method === 'ping') result = { result: {} };
      else {
        try { result = await rpc.call(message.method, message.params); }
        catch (error) {
          const code = error.message === 'MCP_BUSY' ? 'MCP_BUSY' : error.message === 'MCP_UNAVAILABLE' ? 'MCP_UNAVAILABLE' : 'MCP_OUTCOME_UNKNOWN';
          return jsonResponse(response, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: code } });
        }
      }
      if (result.error) {
        return jsonResponse(response, 200, { jsonrpc: '2.0', id: message.id, error: {
          code: -32603, message: safeErrors.has(result.error.message) ? result.error.message : 'GOOGLE_TOOL_FAILED',
        } });
      }
      if (message.method === 'initialize') result.result.protocolVersion = versions.has(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-03-26';
      return jsonResponse(response, 200, { jsonrpc: '2.0', id: message.id, result: result.result });
    } catch { return jsonResponse(response, 401, { error: 'AUTH_REQUIRED' }); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxConnections = 32;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch { await rpc.close(); throw new Error('HTTP_START_FAILED'); }
  return { server, close: async () => {
    const stopped = rpc.close();
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await Promise.all([closed, stopped]);
  } };
}

module.exports = { createHttpHost, readBinding, mintBinding, equalToken, stdioRpc };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--runtime' || args[2] !== '--port' || !/^\d{1,5}$/.test(args[3]) || Number(args[3]) > 65535) {
    process.stderr.write('Invalid isolated HTTP host arguments.\n');
    process.exitCode = 1;
  } else createHttpHost({ runtime: args[1], port: Number(args[3]) }).then(host => {
    process.stdout.write(JSON.stringify({ listening: true, port: host.server.address().port }) + '\n');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      host.close().catch(() => {
        process.stderr.write('Isolated domain shutdown could not be confirmed.\n');
        process.exitCode = 1;
      });
    });
  }).catch(() => {
    process.stderr.write('Isolated HTTP host failed; check private binding.\n');
    process.exitCode = 1;
  });
}
