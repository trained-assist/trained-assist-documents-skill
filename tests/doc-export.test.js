'use strict';
// Wide-table → block-layout heuristic behind doc_export (moved from core's
// ba_export_client_doc test). Pure logic — pandoc/Chromium are not exercised in CI.
const test = require('node:test');
const assert = require('node:assert');
const { transformWideTables, slugify } = require('../src/doc-export/markdown-to-documents');

test('leaves a narrow table untouched', () => {
  const out = transformWideTables('| A | B |\n|---|---|\n| 1 | 2 |', 45);
  assert.match(out, /\| A \| B \|/);
  assert.doesNotMatch(out, /spec-block/);
});

test('converts a table with a long cell into one block-card per row', () => {
  const longText = 'Исследование К-Скай показало что выборка из 171 случая была достаточна для сравнения моделей';
  const out = transformWideTables(`| Пункт | Основание |\n|---|---|\n| Объём данных | ${longText} |\n| Короткое | ok |`, 45);
  assert.doesNotMatch(out, /\| Пункт \| Основание \|/);
  assert.equal((out.match(/class="spec-block"/g) || []).length, 2);
  assert.ok(out.includes('<em>Пункт:</em> Объём данных'));
  assert.ok(out.includes(longText));
  assert.ok(out.includes('<em>Основание:</em> ok'));
});

test('escapes HTML-sensitive characters in converted cells', () => {
  const out = transformWideTables(`| A | B |\n|---|---|\n| ${'x'.repeat(50)} <script>alert(1)</script> | y |`, 45);
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;/);
});

test('leaves non-table markdown untouched', () => {
  const md = '# Title\n\nSome paragraph with | a pipe | in it but not a table.\n';
  assert.equal(transformWideTables(md, 45), md);
});

test('slugify keeps file names safe', () => {
  assert.equal(slugify('Client Spec / v2'), 'client-spec-v2');
  assert.equal(slugify('ТЗ'), 'doc');
});
