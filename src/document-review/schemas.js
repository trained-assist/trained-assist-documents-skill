'use strict';

const BLOCK_TYPES = Object.freeze(['paragraph', 'list', 'table', 'image_ref']);
const STRATEGIES = Object.freeze(['auto', 'section', 'full']);
const STATUSES = Object.freeze(['applied', 'unchanged', 'needs_input', 'failed']);

const blockSchema = {
  type: 'object',
  required: ['id', 'type', 'value'],
  properties: {
    id: { type: 'string', minLength: 1 },
    type: { type: 'string', enum: BLOCK_TYPES },
    value: {},
  },
  additionalProperties: false,
};

const sectionSchema = {
  type: 'object',
  required: ['id', 'title', 'blocks'],
  properties: {
    id: { type: 'string', minLength: 1 },
    title: { type: 'string' },
    blocks: {
      type: 'array',
      items: blockSchema,
      minItems: 0,
    },
  },
  additionalProperties: false,
};

const documentSchema = {
  type: 'object',
  required: ['document_id', 'revision', 'sections'],
  properties: {
    document_id: { type: 'string', minLength: 1 },
    revision: { type: 'string', minLength: 1 },
    sections: {
      type: 'array',
      items: sectionSchema,
      minItems: 1,
    },
  },
  additionalProperties: false,
};

const constraintsSchema = {
  type: 'object',
  properties: {
    allowed_section_ids: {
      type: 'array',
      items: { type: 'string' },
    },
    allowed_block_ids: {
      type: 'array',
      items: { type: 'string' },
    },
    allowed_operations: {
      type: 'array',
      items: { type: 'string', enum: ['edit', 'add_section', 'remove_section', 'reorder'] },
    },
    protected_values: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    required_phrases: {
      type: 'array',
      items: { type: 'string' },
    },
    forbidden_phrases: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  additionalProperties: false,
};

const requestSchema = {
  type: 'object',
  required: ['schema_version', 'document', 'task'],
  properties: {
    schema_version: { type: 'string', enum: ['1.0.0'] },
    document: documentSchema,
    task: { type: 'string', minLength: 1 },
    constraints: constraintsSchema,
    strategy: { type: 'string', enum: STRATEGIES },
  },
  additionalProperties: false,
};

const changeEntrySchema = {
  type: 'object',
  required: ['section_id', 'block_id', 'operation', 'explanation'],
  properties: {
    section_id: { type: 'string' },
    block_id: { type: 'string' },
    operation: { type: 'string', enum: ['edit', 'add', 'remove', 'reorder'] },
    explanation: { type: 'string' },
  },
  additionalProperties: false,
};

const validationResultSchema = {
  type: 'object',
  required: ['passed'],
  properties: {
    passed: { type: 'boolean' },
    errors: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

const executionInfoSchema = {
  type: 'object',
  required: ['strategy', 'attempts', 'backend'],
  properties: {
    strategy: { type: 'string', enum: STRATEGIES },
    attempts: { type: 'integer', minimum: 1 },
    backend: { type: 'string' },
  },
  additionalProperties: false,
};

const resultSchema = {
  type: 'object',
  required: ['status', 'document_id', 'base_revision', 'contract_id', 'validation', 'execution'],
  properties: {
    status: { type: 'string', enum: STATUSES },
    document_id: { type: 'string' },
    base_revision: { type: 'string' },
    contract_id: { type: 'string' },
    document: documentSchema,
    changes: {
      type: 'array',
      items: changeEntrySchema,
    },
    validation: validationResultSchema,
    execution: executionInfoSchema,
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  additionalProperties: false,
};

function validate(schema, data) {
  const errors = [];
  const walk = (schemaNode, dataNode, path) => {
    if (schemaNode.type === 'object' && dataNode !== null && typeof dataNode === 'object' && !Array.isArray(dataNode)) {
      for (const key of Object.keys(schemaNode.properties || {})) {
        if (schemaNode.required && schemaNode.required.includes(key) && !(key in dataNode)) {
          errors.push(`Missing required property at ${path}.${key}`);
        }
      }
      for (const key of Object.keys(dataNode)) {
        if (schemaNode.additionalProperties === false && !schemaNode.properties?.[key]) {
          errors.push(`Unexpected property at ${path}.${key}`);
        } else if (schemaNode.properties?.[key]) {
          walk(schemaNode.properties[key], dataNode[key], `${path}.${key}`);
        }
      }
    } else if (schemaNode.type === 'array' && Array.isArray(dataNode)) {
      const itemSchema = schemaNode.items;
      if (itemSchema) {
        dataNode.forEach((item, i) => walk(itemSchema, item, `${path}[${i}]`));
      }
    } else if (schemaNode.enum && !schemaNode.enum.includes(dataNode)) {
      errors.push(`Value at ${path} must be one of ${schemaNode.enum.join(', ')}`);
    } else if (schemaNode.type === 'string' && typeof dataNode !== 'string') {
      errors.push(`Value at ${path} must be a string`);
    } else if (schemaNode.type === 'integer' && (!Number.isInteger(dataNode) || typeof dataNode !== 'number')) {
      errors.push(`Value at ${path} must be an integer`);
    } else if (schemaNode.minLength !== undefined && typeof dataNode === 'string' && dataNode.length < schemaNode.minLength) {
      errors.push(`Value at ${path} must have minLength ${schemaNode.minLength}`);
    }
  };
  walk(schema, data, '$');
  return errors;
}

module.exports = {
  BLOCK_TYPES,
  STRATEGIES,
  STATUSES,
  documentSchema,
  requestSchema,
  resultSchema,
  constraintsSchema,
  validate,
};