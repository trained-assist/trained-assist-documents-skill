'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { buildContract, contractId } = require('../../document-review/contract');
const {
  validateDocumentStructure,
  validateContract,
} = require('../../document-review/validator');
const {
  requestSchema,
  resultSchema,
  validate: schemaValidate,
  STATUSES,
} = require('../../document-review/schemas');

const execFileAsync = promisify(execFile);

const LLM_COMMAND = process.env.LLM_COMMAND || '';
const LLM_TIMEOUT = parseInt(process.env.LLM_TIMEOUT || '30000', 10);
const MAX_REPAIR_ATTEMPTS = 1;

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function applyOperation(doc, change) {
  const { section_id, block_id, operation, value } = change;
  const section = doc.sections.find(s => s.id === section_id);
  if (!section) return doc;

  if (operation === 'edit') {
    const block = section.blocks.find(b => b.id === block_id);
    if (block) {
      block.value = value;
    }
  } else if (operation === 'add') {
    section.blocks.push({ id: block_id, type: change.block_type, value });
  } else if (operation === 'remove') {
    section.blocks = section.blocks.filter(b => b.id !== block_id);
  } else if (operation === 'add_section') {
    doc.sections.push({ id: section_id, title: change.title || '', blocks: [] });
  } else if (operation === 'remove_section') {
    doc.sections = doc.sections.filter(s => s.id !== section_id);
  } else if (operation === 'reorder') {
    const order = change.order;
    if (Array.isArray(order)) {
      section.blocks.sort((a, b) => {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
      });
    }
  }

  return doc;
}

function buildPrompt(document, task, constraints, contract) {
  const lines = [];
  lines.push('You are a document editor. Make the requested changes to the document.');
  lines.push('');
  lines.push(`Task: ${task}`);
  lines.push('');
  lines.push('Document structure (IDs must be preserved unless explicitly allowed to change):');
  for (const section of document.sections) {
    lines.push(`  Section: ${section.id} — "${section.title}"`);
    for (const block of section.blocks) {
      lines.push(`    Block: ${block.id} [${block.type}] = ${JSON.stringify(block.value).slice(0, 200)}`);
    }
  }
  lines.push('');

  if (constraints) {
    if (constraints.protected_values) {
      lines.push('PROTECTED values (must not change):');
      for (const [key, val] of Object.entries(constraints.protected_values)) {
        lines.push(`  ${key} = ${val}`);
      }
    }
    if (constraints.required_phrases?.length) {
      lines.push('REQUIRED phrases (must appear in result):');
      for (const p of constraints.required_phrases) lines.push(`  - "${p}"`);
    }
    if (constraints.forbidden_phrases?.length) {
      lines.push('FORBIDDEN phrases (must not appear):');
      for (const p of constraints.forbidden_phrases) lines.push(`  - "${p}"`);
    }
    if (constraints.allowed_operations) {
      lines.push(`Allowed operations: ${constraints.allowed_operations.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('Return ONLY a JSON object with this exact shape:');
  lines.push('{');
  lines.push('  "changes": [');
  lines.push('    {"section_id": "...", "block_id": "...", "operation": "edit|add|remove|reorder", "value": "...", "explanation": "..."}');
  lines.push('  ]');
  lines.push('}');
  lines.push('');
  lines.push('Do NOT modify any protected values. Do NOT add or remove sections or blocks unless explicitly allowed.');
  lines.push('If no changes are needed, return {"changes": []}.');

  return lines.join('\n');
}

async function callLLM(prompt) {
  if (!LLM_COMMAND) {
    throw new Error('LLM_COMMAND environment variable not configured');
  }
  const result = await execFileAsync(LLM_COMMAND, [], {
    input: prompt,
    timeout: LLM_TIMEOUT,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

function parseLLMResponse(text) {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}') + 1;
  if (start === -1 || end === 0) {
    throw new Error('LLM response does not contain a JSON object');
  }
  const json = trimmed.slice(start, end);
  return JSON.parse(json);
}

async function executeReview(request) {
  const { schema_version, document, task, constraints, strategy } = request;

  const contract = buildContract(request);
  const baseDoc = deepClone(document);

  const effectiveStrategy = strategy ?? contract.contract.strategy;
  const sections = effectiveStrategy === 'section'
    ? contract.sectionScope
      ? document.sections.filter(s => contract.sectionScope.has(s.id))
      : document.sections
    : [document];

  let allChanges = [];
  let attempts = 0;
  let resultDoc = deepClone(document);
  let lastViolations = [];

  for (attempts = 1; attempts <= 1 + MAX_REPAIR_ATTEMPTS; attempts++) {
    try {
      const prompt = buildPrompt(
        attempts === 1 ? document : resultDoc,
        task,
        constraints,
        contract
      );

      const response = await callLLM(prompt);
      const parsed = parseLLMResponse(response);
      const changes = parsed.changes || [];

      resultDoc = deepClone(document);
      for (const change of changes) {
        resultDoc = applyOperation(resultDoc, change);
      }

      resultDoc.revision = `${document.revision}.r${attempts}`;

      const validation = validateContract(
        { document_id: document.document_id, revision: resultDoc.revision, sections: resultDoc.sections },
        baseDoc,
        contract
      );

      if (validation.passed) {
        return {
          status: STATUSES.applied,
          document_id: document.document_id,
          base_revision: document.revision,
          contract_id: contract.contractId,
          document: { document_id: resultDoc.document_id, revision: resultDoc.revision, sections: resultDoc.sections },
          changes,
          validation,
          execution: {
            strategy: effectiveStrategy,
            attempts,
            backend: 'llm',
          },
          warnings: validation.warnings,
        };
      }

      lastViolations = validation.errors;
      if (attempts >= 1 + MAX_REPAIR_ATTEMPTS) {
        return {
          status: STATUSES.failed,
          document_id: document.document_id,
          base_revision: document.revision,
          contract_id: contract.contractId,
          document: undefined,
          changes: [],
          validation,
          execution: {
            strategy: effectiveStrategy,
            attempts,
            backend: 'llm',
          },
          warnings: ['Max repair attempts exhausted'],
        };
      }
    } catch (e) {
      if (attempts >= 1 + MAX_REPAIR_ATTEMPTS) {
        return {
          status: STATUSES.failed,
          document_id: document.document_id,
          base_revision: document.revision,
          contract_id: contract.contractId,
          document: undefined,
          changes: [],
          validation: { passed: false, errors: [e.message], warnings: [] },
          execution: {
            strategy: effectiveStrategy,
            attempts,
            backend: 'llm',
          },
          warnings: ['LLM call failed'],
        };
      }
      lastViolations = [e.message];
    }
  }

  return {
    status: STATUSES.failed,
    document_id: document.document_id,
    base_revision: document.revision,
    contract_id: contract.contractId,
    document: undefined,
    changes: [],
    validation: { passed: false, errors: lastViolations, warnings: [] },
    execution: {
      strategy: effectiveStrategy,
      attempts,
      backend: 'llm',
    },
    warnings: ['Review failed'],
  };
}

function isAvailable() {
  return true;
}

module.exports = {
  isReady: isAvailable,
  tools: {
    document_content_review: {
      description: [
        'Правка содержимого структурированного документа по строгому контракту.',
        'Принимает JSON-документ с адресуемыми разделами и блоками, задачу и ограничения.',
        'Возвращает проверенный кандидат результата с детальным отчётом изменений и валидацией.',
        'Contract checking — код, не ответ LLM. Исполнитель не может ослабить контракт.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['document', 'task'],
        properties: {
          schema_version: {
            type: 'string',
            enum: ['1.0.0'],
            description: 'Версия контракта. Только "1.0.0" поддерживается.',
          },
          document: {
            type: 'object',
            description: 'Структурированный документ с document_id, revision, sections[].',
            properties: {
              document_id: { type: 'string', description: 'Уникальный идентификатор документа.' },
              revision: { type: 'string', description: 'Текущая ревизия документа.' },
              sections: {
                type: 'array',
                description: 'Разделы документа с адресуемыми блоками.',
                items: {
                  type: 'object',
                  required: ['id', 'title', 'blocks'],
                  properties: {
                    id: { type: 'string', description: 'Уникальный идентификатор раздела.' },
                    title: { type: 'string', description: 'Заголовок раздела.' },
                    blocks: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['id', 'type', 'value'],
                        properties: {
                          id: { type: 'string', description: 'Уникальный идентификатор блока.' },
                          type: {
                            type: 'string',
                            enum: ['paragraph', 'list', 'table', 'image_ref'],
                            description: 'Тип блока.',
                          },
                          value: {
                            description: 'Значение блока (строка, массив или объект в зависимости от типа).',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          task: {
            type: 'string',
            description: 'Свободная формулировка задачи на правку.',
          },
          constraints: {
            type: 'object',
            description: 'Ограничения на допустимые изменения.',
            properties: {
              allowed_section_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Разрешённые IDs разделов для изменения.',
              },
              allowed_block_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Разрешённые IDs блоков для изменения.',
              },
              allowed_operations: {
                type: 'array',
                items: { type: 'string', enum: ['edit', 'add_section', 'remove_section', 'reorder'] },
                description: 'Разрешённые типы операций.',
              },
              protected_values: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'Защищённые значения в формате "sectionId.blockId": "значение".',
              },
              required_phrases: {
                type: 'array',
                items: { type: 'string' },
                description: 'Обязательные формулировки, которые должны присутствовать в результате.',
              },
              forbidden_phrases: {
                type: 'array',
                items: { type: 'string' },
                description: 'Запрещённые формулировки в результате.',
              },
            },
          },
          strategy: {
            type: 'string',
            enum: ['auto', 'section', 'full'],
            description: 'Стратегия выполнения: auto (выбор по умолчанию), section (по разделам), full (весь документ).',
          },
        },
      },
      handler: async (args) => {
        const request = args;
        if (!request.document) {
          throw new Error('Нужен document: структурированный JSON-документ с document_id, revision, sections[]');
        }
        if (!request.task) {
          throw new Error('Нужна task: описание правки');
        }

        const schemaErrors = schemaValidate(requestSchema, request);
        if (schemaErrors.length > 0) {
          throw new Error(`Invalid request: ${schemaErrors.join('; ')}`);
        }

        const result = await executeReview(request);

        const resultErrors = schemaValidate(resultSchema, result);
        if (resultErrors.length > 0) {
          throw new Error(`Internal result validation failed: ${resultErrors.join('; ')}`);
        }

        return result;
      },
    },
  },
};