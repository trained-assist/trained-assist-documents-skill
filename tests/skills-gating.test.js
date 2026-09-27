'use strict';
// Profile skills gating (trained-assist-agent #1537): modules of switched-off catalog
// sections arrive in SKILLS_RESOLVED as 'sales-skills/<file>' and are not registered.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
function toolNames(env) {
  const r = spawnSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./src/mcp-skills/registry.js').listTools().map(t=>t.name)))"],
    { cwd: root, encoding: 'utf8', env: { ...process.env, USER_ID: 'u1', ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('hidden sales-skills modules are not registered; others stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-gating-'));
  const file = path.join(dir, 'effective.json');
  fs.writeFileSync(file, JSON.stringify({ hidden: { modules: ['sales-skills/85-expo.js', '30-weeek.js'] } }));
  const all = toolNames({ HOME: dir });
  const gated = toolNames({ HOME: dir, SKILLS_RESOLVED: file });
  assert.ok(all.includes('expo_enable'));
  assert.ok(!gated.includes('expo_enable'), 'module of a switched-off section is hidden');
  assert.ok(gated.includes('weeek_status'), 'a bare core module name never hides a sibling module');
});

test('unreadable SKILLS_RESOLVED → nothing hidden', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-gating-'));
  assert.deepEqual(toolNames({ HOME: dir, SKILLS_RESOLVED: path.join(dir, 'missing.json') }), toolNames({ HOME: dir }));
});
