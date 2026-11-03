'use strict';

const path = require('path');
const mammoth = require('mammoth');

const baseDir = () => process.env.WORK_DIR || process.cwd();
const resolvePath = (p) => (p ? path.resolve(baseDir(), p) : null);

module.exports = {
  isReady: () => true,
  
  tools: {
    docx_read: {
      description: [
        'Прочитать DOCX файл: извлечь текст, таблицы и structural metadata.',
        'Возвращает: { text, paragraphs, tables, metadata }',
        'Поддерживает markdown-подобные результаты для дальнейшей обработки.'
      ],
      inputSchema: {
        type: 'object',
        required: ['input'],
        properties: {
          input: { type: 'string', description: 'Путь к .docx файлу (относительно рабочей директории)' },
          include_formatting: { type: 'boolean', description: 'Включить базовую структуру форматирования (по умолчанию true)' },
        },
      },
      handler: async ({ input, include_formatting = true }) => {
        const docxPath = resolvePath(input);
        const result = await mammoth.extractRawText({ path: docxPath });
        const htmlResult = include_formatting ? await mammoth.convertToHtml({ path: docxPath }) : null;
        
        return {
          success: true,
          text: result.value,
          warnings: result.warnings,
          html: htmlResult?.value || null,
          metadata: htmlResult?.metadata || {},
          path: docxPath,
          timestamp: new Date().toISOString(),
        };
      },
    },
  },
};