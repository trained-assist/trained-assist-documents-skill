'use strict';
const { readPdf } = require('../../pdf/pdf-reader');
module.exports = {
  isReady: () => true,
  tools: {
    pdf_read: {
      description: 'Чтение PDF с текстовым слоем, страницы и текст через Poppler, без LLM/OCR. Скан возвращает needs_ocr. Разрешён только локальный PDF_READ_ROOT или WORK_DIR.',
      inputSchema: { type: 'object', required: ['path'], additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Путь к PDF внутри разрешённой директории' },
          start_page: { type: 'integer', minimum: 1 },
          end_page: { type: 'integer', minimum: 1 },
          max_pages: { type: 'integer', minimum: 1, maximum: 50 },
        } },
      handler: readPdf,
    },
  },
};
