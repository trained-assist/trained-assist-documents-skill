'use strict';

const { documentSchema, validate: schemaValidate } = require('./schemas');

function validateDocumentStructure(document) {
  const errors = schemaValidate(documentSchema, document);
  if (errors.length > 0) {
    return { passed: false, errors, warnings: [] };
  }

  const warnings = [];
  const sectionIds = new Set();
  const blockIds = new Set();

  for (const section of document.sections) {
    if (sectionIds.has(section.id)) {
      errors.push(`Duplicate section id: ${section.id}`);
    }
    sectionIds.add(section.id);

    for (const block of section.blocks) {
      if (blockIds.has(block.id)) {
        errors.push(`Duplicate block id: ${block.id}`);
      }
      blockIds.add(block.id);
    }
  }

  return { passed: errors.length === 0, errors, warnings };
}

function validateEditScope(changes, contract) {
  const errors = [];
  const warnings = [];

  const sectionStructure = Object.fromEntries(
    contract.contract.section_structure.map(s => [s.id, s])
  );

  for (const change of changes) {
    const { section_id, block_id, operation } = change;

    if (!sectionStructure[section_id]) {
      errors.push(`Change references unknown section: ${section_id}`);
      continue;
    }

    if (!contract.allowedOps.includes(operation)) {
      errors.push(`Operation "${operation}" is not allowed by constraints`);
      continue;
    }

    if (contract.sectionScope && !contract.sectionScope.has(section_id)) {
      errors.push(`Change targets section outside allowed scope: ${section_id}`);
      continue;
    }

    if (operation !== 'add_section' && !contract.blockScope?.has(block_id)) {
      if (block_id && !sectionStructure[section_id]?.block_ids.includes(block_id)) {
        errors.push(`Change targets unknown block ${block_id} in section ${section_id}`);
        continue;
      }
    }

    if (operation === 'remove_section' && !contract.allowedOps.includes('remove_section')) {
      errors.push(`Removing section ${section_id} is not allowed by constraints`);
      continue;
    }
  }

  return { passed: errors.length === 0, errors, warnings };
}

function validateProtectedValues(resultDoc, contract, baseDoc) {
  const errors = [];
  const warnings = [];

  for (const [key, expectedValue] of Object.entries(contract.protectedValues)) {
    const [sectionId, blockId] = key.split('.');
    const section = resultDoc.sections.find(s => s.id === sectionId);
    if (!section) {
      if (baseDoc.sections.some(s => s.id === sectionId)) {
        errors.push(`Protected section ${sectionId} was removed`);
      }
      continue;
    }
    const block = section.blocks.find(b => b.id === blockId);
    if (!block) {
      const baseSection = baseDoc.sections.find(s => s.id === sectionId);
      if (baseSection?.blocks.some(b => b.id === blockId)) {
        errors.push(`Protected block ${blockId} in section ${sectionId} was removed`);
      }
      continue;
    }
    const actualValue = typeof block.value === 'string' ? block.value : JSON.stringify(block.value);
    if (actualValue !== expectedValue) {
      errors.push(`Protected block ${sectionId}.${blockId} value was changed`);
    }
  }

  return { passed: errors.length === 0, errors, warnings };
}

function validatePhrases(resultDoc, contract) {
  const errors = [];
  const warnings = [];
  const text = JSON.stringify(resultDoc);

  for (const phrase of contract.requiredPhrases) {
    if (!text.includes(phrase)) {
      errors.push(`Required phrase missing: "${phrase}"`);
    }
  }

  for (const phrase of contract.forbiddenPhrases) {
    if (text.includes(phrase)) {
      errors.push(`Forbidden phrase found: "${phrase}"`);
    }
  }

  return { passed: errors.length === 0, errors, warnings };
}

function validateChangesMatchDiff(changes, baseDoc, resultDoc) {
  const errors = [];
  const warnings = [];

  if (!changes || changes.length === 0) {
    if (JSON.stringify(baseDoc) !== JSON.stringify(resultDoc)) {
      errors.push('No changes declared but document differs from base');
    }
    return { passed: errors.length === 0, errors, warnings };
  }

  const changeKeys = new Set(changes.map(c => `${c.section_id}:${c.block_id}:${c.operation}`));

  for (const change of changes) {
    const { section_id, block_id, operation } = change;
    if (operation === 'remove' || operation === 'remove_section') {
      continue;
    }
    const section = resultDoc.sections.find(s => s.id === section_id);
    if (!section && operation !== 'add_section') {
      errors.push(`Change declares ${operation} for missing section ${section_id}`);
      continue;
    }
    if (section && operation !== 'add_section') {
      const block = section.blocks.find(b => b.id === block_id);
      if (!block && operation !== 'add') {
        errors.push(`Change declares ${operation} for missing block ${block_id}`);
      }
    }
  }

  return { passed: errors.length === 0, errors, warnings };
}

function validateContract(result, baseDoc, contract) {
  const doc = result.document ?? result;
  const allErrors = [];
  const allWarnings = [];

  const structResult = validateDocumentStructure(doc);
  if (!structResult.passed) {
    allErrors.push(...structResult.errors);
  }
  allWarnings.push(...structResult.warnings);

  if (doc.document_id !== baseDoc.document_id) {
    allErrors.push(`document_id changed: ${baseDoc.document_id} → ${doc.document_id}`);
  }
  if (doc.revision === baseDoc.revision) {
    allWarnings.push('Revision unchanged despite edits');
  }

  if (result.changes) {
    const scopeResult = validateEditScope(result.changes, contract);
    if (!scopeResult.passed) allErrors.push(...scopeResult.errors);
    allWarnings.push(...scopeResult.warnings);

    const diffResult = validateChangesMatchDiff(result.changes, baseDoc, doc);
    if (!diffResult.passed) allErrors.push(...diffResult.errors);
    allWarnings.push(...diffResult.warnings);
  }

  const protectedResult = validateProtectedValues(doc, contract, baseDoc);
  if (!protectedResult.passed) allErrors.push(...protectedResult.errors);
  allWarnings.push(...protectedResult.warnings);

  const phrasesResult = validatePhrases(doc, contract);
  if (!phrasesResult.passed) allErrors.push(...phrasesResult.errors);
  allWarnings.push(...phrasesResult.warnings);

  return {
    passed: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

module.exports = {
  validateDocumentStructure,
  validateEditScope,
  validateProtectedValues,
  validatePhrases,
  validateChangesMatchDiff,
  validateContract,
};