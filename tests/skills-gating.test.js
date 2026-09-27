'use strict';
// Profile skills gating (trained-assist-agent #1537): modules of switched-off catalog
// sections arrive in SKILLS_RESOLVED as 'documents-skills/<file>' and are not registered.
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

test('hidden documents-skills modules are not registered; others stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'documents-gating-'));
  const file = path.join(dir, 'effective.json');
  fs.writeFileSync(file, JSON.stringify({ hidden: { modules: ['documents-skills/10-deck.js', '20-doc-export.js'] } }));
  const all = toolNames({ HOME: dir });
  const gated = toolNames({ HOME: dir, SKILLS_RESOLVED: file });
  assert.ok(all.includes('deck_render'));
  assert.ok(!gated.includes('deck_render'), 'module of a switched-off section is hidden');
  assert.ok(gated.includes('doc_export'), 'a bare core module name never hides a sibling module');
  assert.ok(gated.includes('gdrive_setup'), 'setup tools stay visible before Drive is connected');
});

test('unreadable SKILLS_RESOLVED → nothing hidden', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'documents-gating-'));
  assert.deepEqual(toolNames({ HOME: dir, SKILLS_RESOLVED: path.join(dir, 'missing.json') }), toolNames({ HOME: dir }));
});
