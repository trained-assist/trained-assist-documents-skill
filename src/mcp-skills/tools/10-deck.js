'use strict';

// Presentations: markdown deck (deckgen markup) → .pptx + .html + .pdf, no LLM.
// The LLM only writes the markdown; layout, font sizes, colours and code
// highlighting are computed by src/deck/deckgen.js.

const fs = require('fs');
const path = require('path');
const { renderDeck, checkDeck } = require('../../deck/deckgen');

const FORMAT_GUIDE = path.join(__dirname, '..', '..', 'deck', 'deckgen-markdown-format.md');

// Relative paths resolve against the session's working directory.
const baseDir = () => process.env.WORK_DIR || process.cwd();
const resolvePath = (p) => (p ? path.resolve(baseDir(), p) : null);

module.exports = {
  isReady: () => true,

  tools: {
    deck_markup_guide: {
      description: 'Справка по разметке презентаций (deckgen markdown): шапка, разделение слайдов, теги, карточки, код, схемы, таблицы, заметки докладчика. ' +
        'Вызови ПЕРЕД тем как писать или править deck.md — генератор понимает только эту разметку.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => fs.readFileSync(FORMAT_GUIDE, 'utf8'),
    },

    deck_check: {
      description: 'Быстро (без рендера и без файлов) проверить, влезает ли текст колоды на слайды. Возвращает {slides, warnings, defects, score}; ' +
        'warnings пустой = всё влезает. defects[] — дефекты с уровнем 1–5 (1: текст не влез/налезает, 2: двойной маркер или перебор выделений, ' +
        '3: переполненный блок, 4: интерлиньяж/иерархия, 5: блок прижат к футеру) и score с verdict; уровни 2–5 — подсказки, гейты они не роняют. ' +
        'Используй в цикле правки: поправил слайды из warnings → deck_check снова → затем deck_render.',
      inputSchema: {
        type: 'object',
        properties: {
          input:    { type: 'string', description: 'Путь к deck.md (относительно рабочей директории)' },
          markdown: { type: 'string', description: 'Либо сам текст колоды вместо файла' },
        },
      },
      handler: async ({ input, markdown } = {}) => {
        if (!input && !markdown) throw new Error('Нужен input (путь к deck.md) или markdown');
        return checkDeck(markdown != null ? markdown : fs.readFileSync(resolvePath(input), 'utf8'));
      },
    },

    deck_render: {
      description: 'Отрендерить колоду deck.md в .pptx (редактируемый, открывается в PowerPoint/Keynote) + .html + .pdf. ' +
        'Возвращает пути к файлам, warnings — где текст не влез (разбей слайд или сократи и отрендерь снова), defects[] с уровнями 1–5 и score; ' +
        'тот же отчёт пишется в <name>.deckgen.json рядом с файлами. ~5 с на 10 слайдов.',
      inputSchema: {
        type: 'object',
        required: ['input'],
        properties: {
          input:   { type: 'string', description: 'Путь к deck.md (относительно рабочей директории)' },
          out_dir: { type: 'string', description: 'Каталог для файлов (по умолчанию — рядом с deck.md)' },
          name:    { type: 'string', description: 'Имя файлов без расширения (по умолчанию — из шапки file: или имени deck.md)' },
          theme:   { type: 'string', enum: ['dark', 'light'], description: 'Тема (по умолчанию из шапки, иначе dark)' },
          accent:  { type: 'string', description: 'Акцентный цвет HEX, напр. 2FD07A' },
          pdf:     { type: 'boolean', description: 'Рендерить PDF (по умолчанию true)' },
          png:     { type: 'boolean', description: 'Дополнительно PNG-превью слайдов (по умолчанию false)' },
        },
      },
      handler: async ({ input, out_dir, name, theme, accent, pdf = true, png = false }) => {
        const result = await renderDeck({
          input: resolvePath(input),
          outDir: resolvePath(out_dir),
          name, theme, accent, pdf, png,
        });
        // Machine-readable report next to the files: playbook steps check
        // `warnings` with a plain command instead of asking a model.
        const report = result.pptx.replace(/\.pptx$/, '.deckgen.json');
        fs.writeFileSync(report, JSON.stringify(result, null, 2) + '\n');
        return { ...result, report };
      },
    },
  },
};
