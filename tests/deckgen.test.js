'use strict';
// deckgen layout + render without a browser (pdf:false): pptx/html are written,
// overflowing text is reported as warnings, --strict turns warnings into exit 2.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkDeck, renderDeck, splitSlides } = require('../src/deck/deckgen');

const root = path.resolve(__dirname, '..');
const demo = path.join(root, 'examples', 'demo-deck.md');
const overflow = '# Титул\n---\n## Слайд\n' + Array.from({ length: 60 }, (_, i) => `- пункт номер ${i} с достаточно длинным текстом, чтобы не влезть`).join('\n') + '\n';

const short = '---\ntitle: T\n---\n# Титул\nПодзаголовок\n---\n[ИТОГ · Раздел]\n## Коротко\n- один пункт\n- второй пункт\n---\n## Карточки\n### Да {green}\n- ок\n### Нет {red}\n- нет\n';

test('a short deck fits without warnings', () => {
  const r = checkDeck(short);
  assert.equal(r.slides, 3);
  assert.deepEqual(r.warnings, []);
});

test('overflowing text is reported, and warnings reset between runs', () => {
  assert.ok(checkDeck(overflow).warnings.length > 0);
  assert.deepEqual(checkDeck(short).warnings, []);
});

test('--- inside a code block does not split slides', () => {
  assert.equal(splitSlides('## A\n```yaml\n---\nk: v\n```\n---\n## B').length, 2);
});

test('renderDeck writes pptx + html (no pdf) into a new dir', async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-')), 'nested', 'ru');
  const r = await renderDeck({ input: demo, outDir: out, name: 'p', pdf: false });
  assert.ok(fs.statSync(r.pptx).size > 0);
  assert.ok(fs.readFileSync(r.html, 'utf8').includes('<body>'));
  assert.equal(r.pdf, null);
});

test('CLI --strict exits 2 on warnings and --report creates its directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cli-'));
  fs.writeFileSync(path.join(dir, 'deck.md'), overflow);
  const report = path.join(dir, 'out', 'report', 'deckgen.json');
  const r = spawnSync(process.execPath, [path.join(root, 'src/deck/deckgen.js'), 'deck.md', '--out', 'out', '--no-pdf', '--report', report, '--strict'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.ok(JSON.parse(fs.readFileSync(report, 'utf8')).warnings.length > 0);
});
