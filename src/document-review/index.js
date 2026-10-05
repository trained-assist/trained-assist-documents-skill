'use strict';

const { buildContract, contractId, hashConstraints } = require('./contract');
const {
  validateDocumentStructure,
  validateEditScope,
  validateProtectedValues,
  validatePhrases,
  validateChangesMatchDiff,
  validateContract,
} = require('./validator');
const {
  documentSchema,
  requestSchema,
  resultSchema,
  validate: schemaValidate,
  BLOCK_TYPES,
  STRATEGIES,
  STATUSES,
} = require('./schemas');

module.exports = {
  buildContract,
  contractId,
  hashConstraints,
  validateDocumentStructure,
  validateEditScope,
  validateProtectedValues,
  validatePhrases,
  validateChangesMatchDiff,
  validateContract,
  documentSchema,
  requestSchema,
  resultSchema,
  schemaValidate,
  BLOCK_TYPES,
  STRATEGIES,
  STATUSES,
};