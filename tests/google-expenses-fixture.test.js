'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fixture = require('../scripts/fixtures/google-expenses-v1.json');
const script = path.join(__dirname, '../scripts/sandbox/google-expenses-fixture.cjs');

test('fixture expectations match independent deduplication and category/month sums', () => {
  const seen = new Set();
  const duplicateRows = [];
  const categories = new Map();
  const months = new Map();
  let rawTotal = 0;
  let total = 0;
  for (const [index, row] of fixture.rows.slice(1).entries()) {
    rawTotal += row[2];
    const key = JSON.stringify(row);
    if (seen.has(key)) { duplicateRows.push(index + 2); continue; }
    seen.add(key);
    total += row[2];
    categories.set(row[1], (categories.get(row[1]) || 0) + row[2]);
    const month = row[0].slice(0, 7);
    months.set(month, (months.get(month) || 0) + row[2]);
  }
  assert.deepEqual(duplicateRows, fixture.expected.duplicate_sheet_rows);
  assert.equal(duplicateRows.length, fixture.expected.duplicates_removed);
  assert.equal(seen.size, fixture.expected.unique_expenses);
  assert.equal(rawTotal, fixture.expected.raw_total);
  assert.equal(total, fixture.expected.deduplicated_total);
  assert.deepEqual([['category', 'total'], ...[...categories].sort()], fixture.expected.category_rows);
  assert.deepEqual([['month', 'total'], ...[...months].sort()], fixture.expected.monthly_rows);
});

test('fixture defaults to offline output even with unusable credential roots', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, AGENT_TOKENS_DIR: '/nonexistent/never-read', USER_ID: 'private-never-read' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), fixture);
});

test('live fixture refuses implicit binding and does not echo sensitive arguments', () => {
  const result = spawnSync(process.execPath, [script, '--create', '--profile', 'private-never-read', '--folder-id', 'test-folder'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /private-never-read/);
});
