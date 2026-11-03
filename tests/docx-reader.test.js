'use strict';
// docx_read tool: module loads, schema valid, error paths.
const test = require('node:test');
const assert = require('node:assert');
const tool = require('../src/mcp-skills/tools/10-docx-reader.js');

test('docx-reader module exports isReady and tools', () => {
  assert.strictEqual(typeof tool.isReady, 'function');
  assert.strictEqual(tool.isReady(), true);
  assert.ok(tool.tools.docx_read, 'docx_read tool must be exported');
});

test('docx_read inputSchema has required input field', () => {
  const schema = tool.tools.docx_read.inputSchema;
  assert.strictEqual(schema.type, 'object');
  assert.deepStrictEqual(schema.required, ['input']);
  assert.ok(schema.properties.input, 'input property must exist');
  assert.strictEqual(schema.properties.input.type, 'string');
});

test('docx_read handler throws on missing input', async () => {
  const handler = tool.tools.docx_read.handler;
  await assert.rejects(
    handler({}),
    /Could not find file|Cannot read DOCX/
  );
});

test('docx_read handler throws on nonexistent file', async () => {
  const handler = tool.tools.docx_read.handler;
  await assert.rejects(
    handler({ input: 'nonexistent-file.docx' }),
    /ENOENT|not found|Cannot read DOCX/
  );
});