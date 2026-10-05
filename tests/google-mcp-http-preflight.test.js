'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('synthetic real-socket preflight proves refusal paths without provider requests or leaked bindings', () => {
  const script = path.join(__dirname, '../scripts/sandbox/google-mcp-http-preflight.cjs');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, AGENT_SECRET: 'synthetic-root-marker', GOOGLE_DOCUMENTS_MCP_TOKEN: 'synthetic-root-token-marker' } });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-root-marker|synthetic-root-token-marker|authToken|Authorization|private_key/);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.passed, true);
  assert.equal(evidence.realHttpSocket, true);
  assert.equal(evidence.realStdioChild, true);
  assert.equal(evidence.networkGuardActive, true);
  assert.equal(evidence.blockedNetworkAttempts, 0);
  assert.equal(evidence.domainExited, true);
  assert.equal(evidence.ephemeralRuntimeRemoved, true);
  assert.equal(evidence.probes.length, 11);
});
