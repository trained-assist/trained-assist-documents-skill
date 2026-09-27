'use strict';
// The presentation-creation playbook: valid against core's Playbook v1 schema
// (when core is checked out next to the repo or in .core, as in CI), and its
// deterministic command_exit_zero checks pass on good files and fail on bad ones.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const playbook = require('../playbooks/presentation-creation.json');
const steps = playbook.stages.flatMap(s => s.steps);
const step = (title) => steps.find(s => s.title === title);

const schemaPath = [path.join(root, '.core'), path.join(root, '..', 'trained-assist-agent')]
  .map(d => path.join(d, 'contracts', 'playbook.schema.json'))
  .find(f => fs.existsSync(f));

test('valid Playbook v1 (core schema)', { skip: !schemaPath && 'core checkout not found' }, () => {
  const Ajv = require('ajv');
  const validate = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true }).compile(require(schemaPath));
  assert.ok(validate(playbook), JSON.stringify(validate.errors));
  assert.equal(playbook.scope, 'system');
});

test('no host-specific absolute paths', () => {
  assert.doesNotMatch(JSON.stringify(playbook), /\/home\/|\/Users\//);
});

function passes(title, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  try { execSync(step(title).validation.command_exit_zero.command, { cwd: dir, stdio: 'pipe' }); return true; }
  catch { return false; }
}

test('research must cite sources', () => {
  assert.ok(passes('Исследование темы', { 'deck/research.md': 'факт — https://example.com/a' }));
  assert.ok(!passes('Исследование темы', { 'deck/research.md': 'факт без источника' }));
});

test('draft must be deckgen markup (slides + headings)', () => {
  assert.ok(passes('Черновик колоды в разметке deckgen', { 'deck/content.md': '# Титул\n---\n## Слайд\n- пункт\n' }));
  assert.ok(!passes('Черновик колоды в разметке deckgen', { 'deck/content.md': 'просто текст' }));
});

test('rewrites must be in the target language', () => {
  const ru = 'Агенты берут на себя рутину, а люди решают, что важно.\n---\n## Итог\n- Работает `deck_render`';
  const en = 'Agents take over the routine; people decide what matters.\n---\n## Summary\n- Works';
  assert.ok(passes('Литературная редактура (русский)', { 'deck/deck.ru.md': ru }));
  assert.ok(!passes('Литературная редактура (русский)', { 'deck/deck.ru.md': en }));
  assert.ok(passes('Литературная редактура (английский)', { 'deck/deck.en.md': en }));
  assert.ok(!passes('Литературная редактура (английский)', { 'deck/deck.en.md': ru }));
});

test('render step fails while deckgen reports warnings', () => {
  const t = 'Рендер и подгонка (русская версия)';
  assert.equal(step(t).validation.file_exists, 'output/ru/presentation-ru.pdf');
  assert.ok(passes(t, { 'output/ru/presentation-ru.deckgen.json': '{"warnings":[]}' }));
  assert.ok(!passes(t, { 'output/ru/presentation-ru.deckgen.json': '{"warnings":["слайд 3: не влезает"]}' }));
  assert.ok(!passes(t, {}));
});
