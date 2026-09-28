'use strict';
// deckgen layout + render without a browser (pdf:false): pptx/html are written,
// overflowing text is reported as warnings, --strict turns warnings into exit 2.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkDeck, renderDeck, splitSlides, parseSlide, build } = require('../src/deck/deckgen');
const { lineWidth, widestTokenEm } = require('../src/deck/text-widths');

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

// Схема-цепочка: подпись печатается жирным по центру узла. Раньше кегль выбирался
// только по высоте, и слово шире узла рвалось посреди («ДОСТАВЛЕ/НО»).
const flowSlide = '## Схема\nВ ОЧЕРЕДИ -> ДОСТАВЛЕНО -> ОБРАБОТКА -> РЕЗУЛЬТАТ СОХРАНЁН -> ACK\n';

function flowLabels(src) {
  const slides = build(splitSlides(src).map(parseSlide), {});
  return slides[0].items
    .filter(i => i.k === 'txt' && i.o.align === 'center' && i.o.bold)
    .map(i => ({ text: i.runs.map(r => r.t).join(''), size: i.o.size, w: i.w }));
}

test('flow labels are sized so no word breaks mid-way', () => {
  const labels = flowLabels(flowSlide);
  assert.equal(labels.length, 5, 'все пять узлов отрисованы');
  for (const l of labels) {
    assert.ok(l.text.length, 'подпись не пустая');
    assert.ok(widestTokenEm(l.text, true) * l.size <= l.w + 0.5,
      `«${l.text}» при ${l.size}pt шире узла ${l.w}pt — слово перенесётся посреди`);
  }
  assert.deepEqual(checkDeck('---\ntitle: T\n---\n' + flowSlide).warnings, []);
});

test('a word wider than the node is reported instead of silently broken', () => {
  const long = 'AAAAAAAAAAAAAAAAAAAAAAAA';
  const src = '---\ntitle: T\n---\n## Схема\nВ ОЧЕРЕДИ -> ' + long + ' -> X -> Y -> Z\n';
  const r = checkDeck(src);
  assert.ok(r.warnings.some(w => w.includes('слово шире колонки')),
    'должно быть предупреждение о слишком длинном слове, got: ' + JSON.stringify(r.warnings));
});

test('measured widths beat the old «average 0.55» heuristic', () => {
  // старая оценка: 10 заглавных кириллических букв считала 10*0.55 = 5.5em,
  // реально ДОСТАВЛЕНО жирным занимает заметно больше — на этом ломались узлы
  assert.ok(lineWidth('ДОСТАВЛЕНО', true) > 6.5);
  // разные буквы — разная ширина, а не один средний коэффициент
  assert.ok(lineWidth('Ж', true) > lineWidth('I', true) * 2);
});

// ---------- бенчмарк типографики (слайды докладчика: иерархия + одна строка в цепочке) ----------
// Жадный перенос по измеренным ширинам — независимая реализация для проверки.
function lines(text, w, size, bold = false) {
  const space = lineWidth(' ', bold) * size;
  let total = 0;
  for (const para of String(text).split('\n')) {
    let n = 1, cur = 0;
    for (const word of para.split(/\s+/)) {
      const ww = lineWidth(word, bold) * size;
      if (cur === 0) cur = ww;
      else if (cur + space + ww <= w) cur += space + ww;
      else { n++; cur = ww; }
    }
    total += n;
  }
  return total;
}

test('card subtitle is a clear level below its heading (hierarchy ≥ 1.3)', () => {
  const src = '---\ntitle: T\n---\n## Карточки\n### Владельцы {orange}\nза данные и решения отвечают разные команды\n### Системы {blue}\nHR, Finance, Docs, почта, календарь\n';
  const items = build(splitSlides(src).map(parseSlide), {})[1].items.filter(i => i.k === 'txt');
  const text = i => i.runs.map(r => r.t).join('');
  const head = items.find(i => text(i) === 'Владельцы');
  const body = items.find(i => text(i).startsWith('за данные'));
  assert.ok(head && body, 'заголовок и подзаголовок карточки отрисованы');
  assert.ok(body.o.size <= Math.floor(head.o.size * 0.66),
    `подзаголовок ${body.o.size}pt должен быть ≤0.66 заголовка ${head.o.size}pt`);
  assert.ok(head.o.size / body.o.size >= 1.3, 'иерархия заголовок/подзаголовок ≥ 1.3');
  assert.ok(lines(text(body), body.w, body.o.size) <= 4, 'подзаголовок не переезжает на 5+ строк');
  assert.deepEqual(checkDeck(src).warnings, [], 'замер иерархии не должен ругаться');
});

test('flow node labels are rendered on a single line', () => {
  const labels = flowLabels(flowSlide);
  assert.equal(labels.length, 5);
  for (const l of labels) {
    assert.equal(lines(l.text, l.w, l.size, true), 1,
      `«${l.text}» при ${l.size}pt занимает больше одной строки в узле ${l.w}pt`);
  }
});

test('a blank line ends a card — the next paragraph belongs to the slide', () => {
  const p = parseSlide('## Слайд\n### Карточка {green}\n- пункт\n\nабзац про слайд\n');
  assert.equal(p.cards.length, 1);
  assert.equal(p.cards[0].body.length, 1, 'в карточке только её пункт');
  assert.ok(p.lead.some(x => x.t.includes('абзац')), 'абзац после пустой строки — текст слайда');
});
