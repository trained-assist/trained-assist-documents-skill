'use strict';

// Markdown document → HTML + PDF + DOCX (reports, client specs, one-pagers).

const path = require('path');
const { exportMarkdownDocument, slugify } = require('../../doc-export/markdown-to-documents');

const baseDir = () => process.env.WORK_DIR || process.cwd();

module.exports = {
  isReady: () => true,

  tools: {
    doc_export: {
      description: [
        'Собрать документ из markdown в HTML + PDF (A4) + DOCX с проверенной вёрсткой — отчёты, ТЗ, коммерческие предложения.',
        'DOCX и PDF собираются из одного HTML-источника; в PDF нет задвоенного заголовка и служебного file://-пути в футере;',
        'таблицы не рвутся посередине страницы, а таблицы с длинным текстом в ячейках автоматически становятся блоками «заголовок + пункты».',
        'Для слайдов используй deck_render, не этот инструмент.',
        'После вызова визуально проверь и PDF, и DOCX — фикс в одном формате не гарантирует фикс в другом.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['markdown', 'title', 'slug'],
        properties: {
          markdown:   { type: 'string', description: 'Полный текст документа в markdown (пайп-таблицы поддерживаются).' },
          title:      { type: 'string', description: 'Заголовок документа (<title> и метаданные PDF/DOCX).' },
          slug:       { type: 'string', description: 'Короткий идентификатор для имени файлов и папки вывода.' },
          output_dir: { type: 'string', description: 'Куда сохранить файлы. По умолчанию ./documents/<slug> в рабочей директории.' },
          footer_signature: { type: 'string', description: 'Подпись в футере PDF (например, "Компания / Имя"). Пусто = только номер страницы.' },
          wide_table_char_threshold: { type: 'number', description: 'Порог длины текста в ячейке, после которого таблица становится блоками. По умолчанию 45.' },
        },
      },
      handler: async ({ markdown, title, slug, output_dir, footer_signature = '', wide_table_char_threshold = 45 }) => {
        const outDir = output_dir
          ? path.resolve(baseDir(), output_dir)
          : path.join(baseDir(), 'documents', slugify(slug));
        const files = await exportMarkdownDocument({
          markdown, title, slug, outDir,
          footerSignature: footer_signature,
          wideTableCharThreshold: wide_table_char_threshold,
        });
        return {
          ...files,
          checklist: [
            'Открой PDF — проверь: один заголовок (не задвоен), таблицы/блоки не рвутся между страницами, в футере нет file://-пути.',
            'Открой DOCX ОТДЕЛЬНО (не только PDF) — узкие таблицы и переносы там проверяются самостоятельно, конвертер не гарантирует идентичный результат.',
          ],
        };
      },
    },
  },
};
