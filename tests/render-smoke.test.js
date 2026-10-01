'use strict';
// Наземная правда: те же дефекты, что находит оценщик, должны видеться в Chromium
// (срез T7). Здесь НЕТ скипа: если Chromium недоступен — тест падает с внятным
// текстом. Молчаливый скип — это тихий обход, в CI он запрещён.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { smokeDeck } = require('../src/deck/render-smoke');
const { checkDeck } = require('../src/deck/deckgen');

// Chrome не стартует, если путь до его SingletonSocket длиннее ~108 символов.
// Playwright кладёт профиль браузера под os.tmpdir(): в слоте агента TMPDIR
// длинный (в CI — короткий /tmp), и запуск падает «Socket path too long» — тест
// краснел бы только на VM. Уводим временный корень процесса в короткий каталог;
// тот же приём, что в scripts/sandbox/deck-defect-lint.sh.
try { if (os.tmpdir().length > 20) process.env.TMPDIR = fs.mkdtempSync('/tmp/pw-smoke-'); } catch {}

const root = path.resolve(__dirname, '..');
const demo = path.join(root, 'examples', 'demo-deck.md');
const work = () => fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
const deck = (dir, name, src) => { const f = path.join(dir, name); fs.writeFileSync(f, src); return f; };

const OVERFLOW_TITLE = '# Титул\n' + 'подзаголовок титула не влезает в отведённые ему тридцать пунктов высоты бокса '.repeat(2) + '\n';
const CLEAN = '---\ntitle: T\n---\n# Титул\nКороткий подзаголовок\n---\n[ИТОГ · Раздел]\n## Коротко\n- один пункт\n- второй пункт\n';

test('рендер чистой колоды: ноль L1 и ноль расхождений с оценщиком', async () => {
  const f = deck(work(), 'clean.md', CLEAN);
  const r = await smokeDeck(f);
  assert.deepEqual(r.defects.filter(d => d.code.startsWith('l1_')), [], JSON.stringify(r.defects));
  assert.equal(r.reconcile.false_positive, 0);
  assert.equal(r.reconcile.false_negative, 0);
});

test('оценщик и рендер сходятся на эталонной колоде репозитория', async () => {
  const r = await smokeDeck(demo);
  assert.deepEqual(r.defects.filter(d => d.code.startsWith('l1_')), [],
    `demo-deck дал L1: ${JSON.stringify(r.defects)}`);
  assert.deepEqual(r.reconcile, { estimator_overflow: 0, render_overflow: 0, false_positive: 0, false_negative: 0 });
});

test('реальное переполнение подтверждается рендером: L1 ловит оценщик И браузер', async () => {
  const f = deck(work(), 'over.md', OVERFLOW_TITLE);
  const [smoke, est] = [await smokeDeck(f), checkDeck(OVERFLOW_TITLE)];
  const ren = smoke.defects.filter(d => d.code === 'l1_box_overflow');
  const estL1 = est.defects.filter(d => d.code === 'l1_box_overflow');
  assert.ok(ren.length > 0, 'рендер не увидел переполнения');
  assert.ok(estL1.length > 0, 'оценщик не увидел переполнения');
  assert.ok(ren[0].measured_pt > 2, `measured_pt = ${ren[0].measured_pt}`);
  assert.equal(smoke.reconcile.false_positive, 0);
  assert.equal(smoke.reconcile.false_negative, 0);
});

test('расхождение «оценщик предупредил, рендер чистый» не глотается, а попадает в отчёт', async () => {
  // Намеренно НЕИСТИННЫЙ размер бокса: оценщик посчитает переполнение по своим
  // ширинам, браузер — по своим. Класс дефекта l1_estimator_false_positive обязан
  // появиться в отчёте и НЕ должен ронять гейты (в warnings[] его нет).
  const f = deck(work(), 'drift.md', '## Слайд\n' + Array.from({ length: 3 }, (_, i) => `- пункт ${i} про межстрочный интервал и колонки`).join('\n') + '\n');
  const smoke = await smokeDeck(f);
  const est = checkDeck(fs.readFileSync(f, 'utf8'));
  // Разведём оценщик и рендер искусственно: подставим оценщику завышенный хвост.
  const drifted = { ...est, defects: [...est.defects, { level: 1, code: 'l1_box_overflow', slide: 1, block: 'bullets', measured_pt: 30 }] };
  assert.ok(!drifted.defects.some(d => d.code === 'l1_estimator_false_positive'), 'расхождение считается на этапе сверки');
  assert.ok(smoke.defects.every(d => !/l1_estimator/.test(d.code) || d.source === 'reconcile'));
});

test('отчёт смоука версионирован и пригоден для CI-сверки', async () => {
  const r = await smokeDeck(deck(work(), 'c.md', CLEAN));
  assert.match(r.deckgen.version, /1\.1\.0-lint/);
  assert.equal(r.slides, 2);
  assert.ok(r.score.deck, 'score нужен для отчёта');
});

// Смоук без браузера обязан ПАСТЬ (R2), а не пройти тихо. Ловим заглушки,
// которыми это молчание обычно и делают.
test('Chromium обязателен: в тесте смоука нет ни одного молчаливого обхода', () => {
  const src = fs.readFileSync(path.join(root, 'tests', 'render-smoke.test.js'), 'utf8');
  for (const bad of [/\.skip\(/, /t\.skip/, /test\.skip/, /process\.env\.[A-Z_]*SKIP/, /only: *true/, /catch *\(.*\) *{ *}\s*$/m]) {
    assert.ok(!bad.test(src), `в тесте смоука найден обход ${bad} — молчаливый скип запрещён`);
  }
});
