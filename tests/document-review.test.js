'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  buildContract,
  validateDocumentStructure,
  validateEditScope,
  validateProtectedValues,
  validatePhrases,
  validateChangesMatchDiff,
  validateContract,
  requestSchema,
  resultSchema,
  documentSchema,
  schemaValidate,
  STATUSES,
} = require('../src/document-review');

const baseDoc = {
  document_id: 'doc-001',
  revision: '1.0.0',
  sections: [
    {
      id: 'sec-intro',
      title: 'Introduction',
      blocks: [
        { id: 'blk-1', type: 'paragraph', value: 'Hello world' },
        { id: 'blk-2', type: 'paragraph', value: 'This is a test' },
      ],
    },
    {
      id: 'sec-body',
      title: 'Body',
      blocks: [
        { id: 'blk-3', type: 'paragraph', value: 'Body text' },
        { id: 'blk-4', type: 'list', value: ['item 1', 'item 2'] },
      ],
    },
  ],
};

test('validateDocumentStructure accepts valid document', () => {
  const result = validateDocumentStructure(baseDoc);
  assert.equal(result.passed, true);
  assert.equal(result.errors.length, 0);
});

test('validateDocumentStructure rejects missing document_id', () => {
  const bad = { revision: '1.0.0', sections: baseDoc.sections };
  const result = validateDocumentStructure(bad);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(e => e.includes('document_id')));
});

test('validateDocumentStructure rejects duplicate section ids', () => {
  const bad = {
    document_id: 'doc-001',
    revision: '1.0.0',
    sections: [
      { id: 'sec-a', title: 'A', blocks: [] },
      { id: 'sec-a', title: 'A2', blocks: [] },
    ],
  };
  const result = validateDocumentStructure(bad);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(e => e.includes('Duplicate section id')));
});

test('validateDocumentStructure rejects duplicate block ids', () => {
  const bad = {
    document_id: 'doc-001',
    revision: '1.0.0',
    sections: [
      { id: 'sec-a', title: 'A', blocks: [
        { id: 'blk-x', type: 'paragraph', value: 'text' },
        { id: 'blk-x', type: 'paragraph', value: 'text2' },
      ] },
    ],
  };
  const result = validateDocumentStructure(bad);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(e => e.includes('Duplicate block id')));
});

test('buildContract produces contract with ID', () => {
  const req = {
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Update the intro paragraph',
    constraints: {
      allowed_operations: ['edit'],
      protected_values: { 'sec-intro.blk-1': 'Hello world' },
    },
    strategy: 'section',
  };
  const result = buildContract(req);
  assert.equal(result.contractId.length, 16);
  assert.equal(result.contract.contract_id, result.contractId);
  assert.equal(result.contract.schema_version, '1.0.0');
  assert.equal(result.contract.task, 'Update the intro paragraph');
  assert.equal(result.contract.strategy, 'section');
  assert.equal(result.allowedOps.length, 1);
  assert.equal(result.allowedOps[0], 'edit');
});

test('buildContract with no constraints allows all defaults', () => {
  const req = {
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Do something',
  };
  const result = buildContract(req);
  assert.equal(result.allowedOps.length, 1);
  assert.equal(result.allowedOps[0], 'edit');
  assert.equal(Object.keys(result.protectedValues).length, 0);
});

test('buildContract with allowed_section_ids scopes sections', () => {
  const req = {
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Edit intro',
    constraints: {
      allowed_section_ids: ['sec-intro'],
    },
  };
  const result = buildContract(req);
  assert.ok(result.sectionScope.has('sec-intro'));
  assert.ok(!result.sectionScope.has('sec-body'));
});

test('validateEditScope allows edits within scope', () => {
  const contract = buildContract({
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Edit',
    constraints: { allowed_section_ids: ['sec-intro'], allowed_operations: ['edit'] },
  });
  const changes = [
    { section_id: 'sec-intro', block_id: 'blk-1', operation: 'edit', explanation: 'update text' },
  ];
  const result = validateEditScope(changes, contract);
  assert.equal(result.passed, true);
});

test('validateEditScope rejects edits outside allowed scope', () => {
  const contract = buildContract({
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Edit',
    constraints: { allowed_section_ids: ['sec-intro'], allowed_operations: ['edit'] },
  });
  const changes = [
    { section_id: 'sec-body', block_id: 'blk-3', operation: 'edit', explanation: 'edit body' },
  ];
  const result = validateEditScope(changes, contract);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(e => e.includes('outside allowed scope')));
});

test('validateEditScope rejects disallowed operations', () => {
  const contract = buildContract({
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Edit',
    constraints: { allowed_operations: ['edit'] },
  });
  const changes = [
    { section_id: 'sec-intro', block_id: 'blk-1', operation: 'remove_section', explanation: 'remove' },
  ];
  const result = validateEditScope(changes, contract);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(e => e.includes('not allowed')));
});

test('validateEditScope rejects unknown section', () => {
  const contract = buildContract({
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Edit',
  });
  const changes = [
    { section_id: 'sec-unknown', block_id: 'blk-1', operation: 'edit', explanation: 'edit' },
  ];
  const result = validateEditScope(changes, contract);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(e => e.includes('unknown section')));
});

test('validateProtectedValues detects changed protected block', () => {
  const contract = buildContract({
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Edit',
    constraints: { protected_values: { 'sec-intro.blk-1': 'Hello world' } },
  });
  const resultDoc = {
    document_id: 'doc-001',
    revision: '1.0.1',
    sections: [
      {
        id: 'sec-intro',
        title: 'Introduction',
        blocks: [
          { id: 'blk-1', type: 'paragraph', value: 'Changed text' },
          { id: 'blk-2', type: 'paragraph', value: 'This is a test' },
        ],
      },
      baseDoc.sections[1],
    ],
  };
  const result = validateProtectedValues(resultDoc, contract, baseDoc);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(e => e.includes('Protected block')));
});

test('validateProtectedValues passes when protected values unchanged', () => {
  const contract = buildContract({
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Edit',
    constraints: { protected_values: { 'sec-intro.blk-1': 'Hello world' } },
  });
  const resultDoc = deepCloneDoc(baseDoc);
  const result = validateProtectedValues(resultDoc, contract, baseDoc);
  assert.equal(result.passed, true);
});

test('validatePhrases detects missing required phrase', () => {
  const contract = buildContract({
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Edit',
    constraints: { required_phrases: ['important'] },
  });
  const resultDoc = deepCloneDoc(baseDoc);
  const result = validatePhrases(resultDoc, contract);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(e => e.includes('Required phrase')));
});

test('validatePhrases detects forbidden phrase', () => {
  const contract = buildContract({
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Edit',
    constraints: { forbidden_phrases: ['confidential'] },
  });
  const resultDoc = {
    document_id: 'doc-001',
    revision: '1.0.1',
    sections: [
      {
        id: 'sec-intro',
        title: 'Introduction',
        blocks: [
          { id: 'blk-1', type: 'paragraph', value: 'This is confidential' },
        ],
      },
    ],
  };
  const result = validatePhrases(resultDoc, contract);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(e => e.includes('Forbidden phrase')));
});

test('validateChangesMatchDiff detects undeclared changes', () => {
  const contract = buildContract({
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Edit',
  });
  const resultDoc = {
    document_id: 'doc-001',
    revision: '1.0.1',
    sections: [
      {
        id: 'sec-intro',
        title: 'Introduction',
        blocks: [
          { id: 'blk-1', type: 'paragraph', value: 'Modified' },
          { id: 'blk-2', type: 'paragraph', value: 'This is a test' },
        ],
      },
      baseDoc.sections[1],
    ],
  };
  const result = validateChangesMatchDiff([], baseDoc, resultDoc);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(e => e.includes('No changes declared')));
});

test('validateChangesMatchDiff passes when changes match diff', () => {
  const contract = buildContract({
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Edit',
  });
  const resultDoc = deepCloneDoc(baseDoc);
  resultDoc.sections[0].blocks[0].value = 'Modified';
  const changes = [
    { section_id: 'sec-intro', block_id: 'blk-1', operation: 'edit', explanation: 'update' },
  ];
  const result = validateChangesMatchDiff(changes, baseDoc, resultDoc);
  assert.equal(result.passed, true);
});

test('validateContract full integration: valid edit passes', () => {
  const contract = buildContract({
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Update intro paragraph',
    constraints: { allowed_operations: ['edit'] },
  });
  const resultDoc = deepCloneDoc(baseDoc);
  resultDoc.sections[0].blocks[0].value = 'Updated hello';
  resultDoc.revision = '1.0.1';
  const changes = [
    { section_id: 'sec-intro', block_id: 'blk-1', operation: 'edit', explanation: 'update text' },
  ];
  const result = validateContract(
    { document: { document_id: 'doc-001', revision: '1.0.1', sections: resultDoc.sections } },
    baseDoc,
    contract
  );
  assert.equal(result.passed, true);
});

test('validateContract full integration: protected value violation fails', () => {
  const contract = buildContract({
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Update intro paragraph',
    constraints: {
      allowed_operations: ['edit'],
      protected_values: { 'sec-intro.blk-1': 'Hello world' },
    },
  });
  const resultDoc = deepCloneDoc(baseDoc);
  resultDoc.sections[0].blocks[0].value = 'Changed';
  resultDoc.revision = '1.0.1';
  const changes = [
    { section_id: 'sec-intro', block_id: 'blk-1', operation: 'edit', explanation: 'update text' },
  ];
  const result = validateContract(
    { document: { document_id: 'doc-001', revision: '1.0.1', sections: resultDoc.sections } },
    baseDoc,
    contract
  );
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(e => e.includes('Protected block')));
});

test('requestSchema validates correct request', () => {
  const req = {
    schema_version: '1.0.0',
    document: baseDoc,
    task: 'Update intro',
    strategy: 'section',
  };
  const errors = schemaValidate(requestSchema, req);
  assert.equal(errors.length, 0);
});

test('requestSchema rejects missing task', () => {
  const req = {
    schema_version: '1.0.0',
    document: baseDoc,
  };
  const errors = schemaValidate(requestSchema, req);
  assert.ok(errors.some(e => e.includes('task')));
});

test('requestSchema rejects unknown schema_version', () => {
  const req = {
    schema_version: '2.0.0',
    document: baseDoc,
    task: 'Update',
  };
  const errors = schemaValidate(requestSchema, req);
  assert.ok(errors.some(e => e.includes('schema_version')));
});

test('resultSchema validates correct result', () => {
  const res = {
    status: 'applied',
    document_id: 'doc-001',
    base_revision: '1.0.0',
    contract_id: 'abc123def4567890',
    document: baseDoc,
    changes: [{ section_id: 'sec-intro', block_id: 'blk-1', operation: 'edit', explanation: 'update' }],
    validation: { passed: true, errors: [], warnings: [] },
    execution: { strategy: 'section', attempts: 1, backend: 'llm' },
    warnings: [],
  };
  const errors = schemaValidate(resultSchema, res);
  assert.equal(errors.length, 0);
});

test('resultSchema rejects invalid status', () => {
  const res = {
    status: 'invalid_status',
    document_id: 'doc-001',
    base_revision: '1.0.0',
    contract_id: 'abc123def4567890',
    validation: { passed: true, errors: [], warnings: [] },
    execution: { strategy: 'section', attempts: 1, backend: 'llm' },
  };
  const errors = schemaValidate(resultSchema, res);
  assert.ok(errors.some(e => e.includes('status')));
});

test('deepCloneDoc preserves original', () => {
  const cloned = deepCloneDoc(baseDoc);
  cloned.sections[0].blocks[0].value = 'Mutated';
  assert.equal(baseDoc.sections[0].blocks[0].value, 'Hello world');
});

function deepCloneDoc(doc) {
  return JSON.parse(JSON.stringify(doc));
}