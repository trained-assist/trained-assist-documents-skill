'use strict';

const crypto = require('crypto');
const { documentSchema, constraintsSchema } = require('./schemas');

function contractId(documentId, revision, constraintsHash) {
  const h = crypto.createHash('sha256');
  h.update(`${documentId}:${revision}:${constraintsHash}`);
  return h.digest('hex').slice(0, 16);
}

function hashConstraints(constraints) {
  if (!constraints) return 'none';
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(constraints));
  return h.digest('hex').slice(0, 12);
}

function buildContract(request) {
  const { schema_version, document, task, constraints, strategy } = request;

  const constraintsHash = hashConstraints(constraints);
  const cid = contractId(document.document_id, document.revision, constraintsHash);

  const allowedSectionIds = constraints?.allowed_section_ids ?? null;
  const allowedBlockIds = constraints?.allowed_block_ids ?? null;
  const allowedOps = constraints?.allowed_operations ?? ['edit'];
  const protectedValues = constraints?.protected_values ?? {};
  const requiredPhrases = constraints?.required_phrases ?? [];
  const forbiddenPhrases = constraints?.forbidden_phrases ?? [];

  const sectionScope = allowedSectionIds
    ? new Set(allowedSectionIds)
    : null;
  const blockScope = allowedBlockIds
    ? new Set(allowedBlockIds)
    : null;

  const structuralContract = {
    contract_id: cid,
    schema_version,
    document_id: document.document_id,
    base_revision: document.revision,
    task,
    strategy: strategy ?? 'auto',
    section_structure: document.sections.map(s => ({
      id: s.id,
      title: s.title,
      block_ids: s.blocks.map(b => b.id),
      block_types: Object.fromEntries(s.blocks.map(b => [b.id, b.type])),
    })),
    allowed_section_ids: allowedSectionIds,
    allowed_block_ids: allowedBlockIds,
    allowed_operations: allowedOps,
    protected_values: protectedValues,
    required_phrases: requiredPhrases,
    forbidden_phrases: forbiddenPhrases,
  };

  return {
    contract: structuralContract,
    contractId: cid,
    sectionScope,
    blockScope,
    allowedOps,
    protectedValues,
    requiredPhrases,
    forbiddenPhrases,
  };
}

module.exports = { buildContract, contractId, hashConstraints };