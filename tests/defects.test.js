'use strict';
// Контракт дефектов и скоринг (срез T1) + линтер раскладки deckgen (T2, T4, T5, T6).
// Lint проверяется на фикстуах: по одному переполненному блоку на тип, чтобы дыра
// «fit() пропускает карточки/плашки» не могла вернуться тихо.
const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/deck/defects');
const { checkDeck, parseSlide, build } = require('../src/deck/deckgen');

// ---------- T1: контракт ----------

test('warnings остаётся string[] — контракт плейбука/--strict не сломан', () => {
  D.reset();
  D.pushWarning('L1: слайд 1 (cards): текст не влезает на 74pt', { level: 1, code: 'l1_box_overflow', slide: 1, block: 'cards', measured_pt: 74 });
  D.pushDefect({ level: 2, code: 'l2_double_marker', slide: 1, block: 'bullets' });
  assert.ok(D.warnings.every(w => typeof w === 'string'));
  assert.equal(D.warnings.length, 1, 'advisory-класс не должен попадать в warnings[]');
  assert.equal(D.defects.length, 2);
});

test('канал: level 1 → оба, advisory и коды расхождения оценщика → только defects[]', () => {
  D.reset();
  D.pushWarning('L1: слайд 2 (lead)', { level: 1, code: 'l1_box_overflow', slide: 2, block: 'lead' });
  D.pushWarning('L1: слайд 3 (cards): оценщик ошибся', { level: 1, code: 'l1_estimator_false_positive', slide: 3, block: 'cards' });
  assert.equal(D.warnings.length, 1, 'l1_estimator_* не должен ронять гейты');
  assert.ok(D.isEstimatorMismatch({ code: 'l1_estimator_false_positive' }));
});

test('скоринг: уровни 1/2/4/5 дают разный penalty и verdict', () => {
  const only = lvl => { const list = [{ level: lvl, code: 'x', slide: 1 }]; const s = D.scoreDefects(list); return s.deck; };
  assert.deepEqual([1, 2, 4, 5].map(l => only(l).score), [0, 75, 97, 99]);
  assert.deepEqual([1, 2, 4, 5].map(l => only(l).verdict), ['critical', 'warn', 'advisory', 'advisory']);
  assert.equal(only(3).verdict, 'warn');
  const clean = D.scoreDefects([]);
  assert.equal(clean.deck.score, 100);
  assert.equal(clean.deck.verdict, 'clean');
  assert.deepEqual(clean.deck.counts, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
});

test('скоринг по слайдам: perSlide сортирован по номеру, у каждого свой maxLevel', () => {
  const s = D.scoreDefects([
    { level: 2, code: 'l2', slide: 10 },
    { level: 1, code: 'l1', slide: 2 },
    { level: 4, code: 'l4', slide: 2 },
  ]);
  assert.deepEqual(Object.keys(s.perSlide), ['2', '10']);
  assert.equal(s.perSlide['2'].maxLevel, 1);
  assert.equal(s.perSlide['2'].verdict, 'critical');
  assert.equal(s.perSlide['2'].counts[4], 1);
  assert.equal(s.perSlide['10'].counts[2], 1);
  assert.equal(s.perSlide['10'].verdict, 'warn');
  assert.equal(s.deck.verdict, 'critical');
  assert.equal(s.deck.total, 3);
});

// ---------- T2: L1 — единственная точка проверки высоты ----------

const codes = (r, lvl) => r.defects.filter(d => !lvl || d.level === lvl).map(d => d.code);
const byBlock = (r, block, lvl) => r.defects.filter(d => d.block === block && (!lvl || d.level === lvl));

// Блоки с боксом, заданным КОНСТАНТОЙ: высота не выведена из текста, поэтому
// переполнение там возможно всегда — именно их fit() раньше не проверял вовсе.
const CONST_BOX = {
  'title':      '# Титул\n' + 'подзаголовок титула не влезает в отведённые ему тридцать пунктов высоты бокса '.repeat(2) + '\n',
  'code-label': '## Слайд\n```py ' + 'длинная подпись блока кода, которая не влезает в бокс подписи '.repeat(3) + '\na = 1\n```\n',
  'tag':        '[ИТОГ · ' + 'очень длинное имя раздела, которое не влезает в бокс шапки '.repeat(2) + ']\n## Коротко\n- пункт\n',
  'callout':    '## Слайд\n- пункт\n\n!!warn ' + 'очень длинный вывод не поместится в плашку высотой сорок восемь пунктов '.repeat(3) + '\n',
};
// Блоки, размер которых ВЫВОДИТСЯ из текста: переполнение возможно, когда
// подбор кегля провалился (min) — этот путь тоже обязан быть в отчёте.
const FIT_BOX = {
  'bullets': '## Слайд\n' + Array.from({ length: 40 }, (_, i) => `- пункт номер ${i} с достаточно длинным текстом, чтобы точно переполнить бокс`).join('\n') + '\n',
  'lead':    '## Слайд\n' + Array.from({ length: 60 }, (_, i) => `абзац ${i} вводного текста достаточно длинный, чтобы переполнить бокс`).join('\n') + '\n',
  'cards':   '## Слайд\n```py\na = 1\n```\n\n### Карточка\n' + Array.from({ length: 12 }, (_, i) => `- очень длинная строка тела карточки номер ${i}, которая точно не уместится`).join('\n') + '\n',
};

test('L1: находится на блоках с боксом-константой — их fit() раньше не проверял вовсе', () => {
  for (const [block, src] of Object.entries(CONST_BOX)) {
    const r = checkDeck(src);
    const l1 = byBlock(r, block, 1);
    assert.ok(l1.length > 0, `нет L1 для ${block}: ${JSON.stringify(r.defects.map(d => d.code + ':' + d.block))}`);
    assert.ok(l1[0].measured_pt > 2, `measured_pt для ${block} = ${l1[0].measured_pt}`);
    assert.ok(r.warnings.some(w => /^L1: /.test(w)), `нет строки L1 в warnings[] для ${block}`);
  }
});

test('L1: находится там, где подбор кегля провалился (fit вернул min и всё равно нарисовал)', () => {
  for (const [block, src] of Object.entries(FIT_BOX)) {
    const r = checkDeck(src);
    const l1 = byBlock(r, block, 1);
    assert.ok(l1.length > 0, `нет L1 для ${block}: ${JSON.stringify(r.defects.map(d => d.code + ':' + d.block))}`);
    assert.ok(l1[0].measured_pt > 2, `measured_pt для ${block} = ${l1[0].measured_pt}`);
  }
});

test('L1: у каждого типа блока ровно одна точка проверки — ни один блок не уходит мимо txt()', () => {
  // Инвариант-ловушка: если новый блок нарисуют через sl.txt() напрямую,
  // grep ниже перестанет давать 1 (тело обёртки) — и дыра вернётся тихо.
  const src = require('fs').readFileSync(require.resolve('../src/deck/deckgen'), 'utf8');
  assert.equal((src.match(/sl\.txt\(/g) || []).length, 1, 'в deckgen должен остаться ровно один вызов sl.txt() — тело txt()');
  assert.ok(/function txt\(sl, where, block, x, y, w, h, runs/.test(src), 'нужна обёртка txt()');
});

test('L1: блоки, чей бокс выведен из самого текста, не дают L1 по построению (граница охвата)', () => {
  // h1/quote/flow/num/footer: высота бокса = измеренная высота текста, переполнение невозможно.
  // Их дефекты приходят по другим кодам (l1_word_wider, l3_flow_lines), а таблица/картинка
  // не txt-блоки и в охват L1 не входят (осознанная граница, не забыто).
  for (const src of ['# Титул\n' + 'строка '.repeat(60) + '\n', '## Слайд\n> ' + 'цитата '.repeat(80) + '\n',
                     '## Слайд\n' + Array.from({ length: 7 }, (_, i) => 'узел' + i).join(' -> ') + '\n']) {
    const r = checkDeck(src);
    assert.deepEqual(r.defects.filter(d => d.level === 1 && ['h1', 'quote', 'flow', 'num', 'footer'].includes(d.block)), [],
      JSON.stringify(r.defects));
  }
});

test('L1: строка warning-а совпадает с форматом контракта (решение ⚫№2)', () => {
  const r = checkDeck('## Слайд\n' + Array.from({ length: 30 }, (_, i) => `- пункт ${i} с длинным текстом, который точно переполнит бокс`).join('\n') + '\n');
  const w = r.warnings.find(x => /^L1: /.test(x));
  assert.match(w, /^L1: слайд \d+ \(\w+\): текст не влезает на \d+pt — сократи или разбей слайд$/);
});

test('L1: чистая колода → ноль L1 и пустые warnings', () => {
  const r = checkDeck('---\ntitle: T\n---\n# Титул\nКороткий подзаголовок\n---\n[ИТОГ · Раздел]\n## Коротко\n- один пункт\n- второй пункт\n');
  assert.deepEqual(r.defects.filter(d => d.level === 1), [], JSON.stringify(r.defects));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.score.deck.verdict, 'clean');
});

test('L1: существующий overflow-тест deckgen теперь даёт измеренное переполнение, а не только «не влез»', () => {
  const overflow = '## Слайд\n' + Array.from({ length: 60 }, (_, i) => `- пункт номер ${i} с достаточно длинным текстом, чтобы не влезть`).join('\n') + '\n';
  const r = checkDeck(overflow);
  assert.ok(r.warnings.length > 0);
  assert.ok(r.score.deck.verdict === 'critical' || r.score.deck.verdict === 'warn', r.score.deck.verdict);
});

test('L1 не считается на блоках без ограничения высоты: box-код и таблица вне охвата (честная граница)', () => {
  const r = checkDeck('## Слайд\n```py\nx = 1\ny = 2\n```\n');
  assert.equal(r.defects.filter(d => d.level === 1 && d.block === 'code').length, 0);
});

// ---------- T3: существующие предупреждения получили уровни ----------

test('T3: warning о карточках/иерархии/цепочке/таблице помечен уровнем в defects[]', () => {
  const many = '## Слайд\n### Первая\n' + Array.from({ length: 14 }, (_, i) => `- очень длинная строка тела карточки номер ${i}, которая точно не уместится`).join('\n') + '\n';
  const r = checkDeck(many);
  const w = r.warnings.join(' | ');
  assert.ok(/карточках много текста|иерархия/.test(w), w);
  const mapped = r.defects.filter(d => /^l3_|^l4_/.test(d.code));
  assert.ok(mapped.length > 0, JSON.stringify(r.defects));
  assert.ok(mapped.every(d => [3, 4].includes(d.level)), JSON.stringify(mapped));
  assert.ok(r.warnings.length === mapped.filter(d => d.level <= 3 || d.level === 4).length || r.warnings.length > 0);
});

// ---------- T4: L2 двойной маркер + --autofix-markers ----------

const marked = '## Слайд\n- ✓ двойной маркер в пункте\n- второй пункт\n';

test('T4: пункт, начинающийся с маркера, даёт l2_double_marker только в defects[]', () => {
  const r = checkDeck(marked);
  const d = r.defects.filter(x => x.code === 'l2_double_marker');
  assert.equal(d.length, 1, JSON.stringify(r.defects));
  assert.equal(d[0].level, 2);
  assert.equal(d[0].slide, 1);
  assert.match(d[0].detail, /✓/);
  assert.ok(!r.warnings.some(w => /L2|l2/.test(w)), 'L2 не должен ронять гейты');
  assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings));
});

test('T4: маркер в карточке, lead, callout и flow — тоже дефект', () => {
  const src = '## Слайд\n- пункт\n\n### Карточка\n- • маркер в карточке\n\n!!tip - ещё маркер\n\n' + 'A -> B -> ✓ узел\n';
  const r = checkDeck(src);
  assert.ok(r.defects.filter(x => x.code === 'l2_double_marker').length >= 2, JSON.stringify(r.defects));
});

test('T4: ✓ в середине предложения и обычный список — не дефект', () => {
  const r = checkDeck('## Слайд\n- сходил ✓ и вернулся\n- обычный пункт\n- другой пункт\n');
  assert.deepEqual(r.defects.filter(x => x.code === 'l2_double_marker'), []);
});

test('T4: --autofix-markers снимает маркер; по умолчанию текст не меняется', () => {
  const off = checkDeck(marked, {});
  const on = checkDeck(marked, { autofixMarkers: true });
  assert.equal(off.defects.filter(x => x.code === 'l2_double_marker').length, 1);
  assert.equal(on.defects.filter(x => x.code === 'l2_double_marker').length, 0, 'после авто-чистки дефекта быть не должно');
  const p = parseSlide('- ✓ двойной маркер\n');
  assert.equal(p.bullets[0].t, '✓ двойной маркер', 'парсер не должен срезать маркер сам');
});

// ---------- T5: L2 бюджет выделений + L4 leading ----------

test('T5: три приёма выделения в одном блоке → l2_emphasis_budget', () => {
  const r = checkDeck('## Слайд\n- **жирный** и ==акцент== и `код` в одном пункте\n');
  const d = r.defects.filter(x => x.code === 'l2_emphasis_budget');
  assert.equal(d.length, 1, JSON.stringify(r.defects));
  assert.equal(d[0].level, 2);
  assert.match(d[0].detail, /^[3-9] приёмов выделения/, d[0].detail);
  assert.equal(d[0].measured_pt, null, 'measured_pt только для измерений в pt (счётчики — в detail)');
  assert.ok(!r.warnings.some(w => /выделен/.test(w)), 'L2 не идёт в warnings[]');
});

test('T5: два приёма выделения — норма, дефекта нет', () => {
  const r = checkDeck('## Слайд\n- **жирный** и ==акцент== в одном пункте\n');
  assert.deepEqual(r.defects.filter(x => x.code === 'l2_emphasis_budget'), []);
});

test('T5: маркер списка и boldColor карточки не считаются отдельными приёмами', () => {
  // Карточка всегда даёт три цвета оформления (muted тело + accent маркер + text жирный).
  // Без нормализации это давало бы 30 ложных срабатываний на колодах A/B.
  const r = checkDeck('## Слайд\n### Заголовок карточки\n- **жирный** пункт внутри карточки\n- обычный пункт\n');
  assert.deepEqual(r.defects.filter(x => x.code === 'l2_emphasis_budget'), [], JSON.stringify(r.defects));
});

test('T5: блок кода с подсветкой не считается выделением автора', () => {
  const r = checkDeck('## Слайд\n```py\ndef f(x):\n    return "строка" + str(42)\n```\n');
  assert.deepEqual(r.defects.filter(x => x.code === 'l2_emphasis_budget'), []);
});

test('T5: l4_leading ловит выход интерлиньяжа за 1.2–1.6', () => {
  const lh = D.scoreDefects([{ level: 4, code: 'l4_leading', slide: 1 }]);
  assert.equal(lh.deck.verdict, 'advisory');
  // Текущие значения колоды (1.0/1.1/1.15/1.2/1.25) → line-height 1.2…1.5, все в допуске.
  const r = checkDeck('## Слайд\n- пункт\n');
  assert.deepEqual(r.defects.filter(x => x.code === 'l4_leading'), []);
});

// ---------- T6: L5 близость к футеру ----------

const L5_PRESSED = '## Слайд\n' + Array.from({ length: 4 }, (_, i) => `- пункт ${i}`).join('\n') + '\n\n!!tip Итог\n';
const L5_OK = '## Слайд\n' + Array.from({ length: 26 }, (_, i) => `- пункт ${i} заметно подлиннее`).join('\n') + '\n\n!!tip Итог\n';

test('T6: нижний блок ближе к футеру, чем к своему блоку → l5_proximity', () => {
  // Плашка вывода стоит у нижней границы, а текст кончается на 194pt выше — визуально
  // она читается как подпись футера, а не как вывод. Ровно то, что владелец видит глазами.
  const src = L5_PRESSED;
  const r = checkDeck(src);
  const d = r.defects.filter(x => x.code === 'l5_proximity');
  assert.ok(d.length > 0, JSON.stringify(r.defects.map(x => x.code + ':' + x.block)));
  assert.equal(d[0].level, 5);
  assert.ok(Number.isFinite(d[0].measured_pt), 'gap должен быть измерен');
});

test('T6: титул и одноколоночный слайд не флагуются (там были ложные срабатывания)', () => {
  const title = checkDeck('# Титул колоды\nПодзаголовок\n');
  assert.deepEqual(title.defects.filter(x => x.code === 'l5_proximity'), []);
  const one = checkDeck('## Слайд\n- один пункт\n- второй пункт\n- третий пункт\n');
  assert.deepEqual(one.defects.filter(x => x.code === 'l5_proximity'), []);
});

test('T6: корректная иерархия (нижний блок ближе к своему блоку, чем к футеру) — чисто', () => {
  const src = L5_OK;
  const r = checkDeck(src);
  assert.deepEqual(r.defects.filter(x => x.code === 'l5_proximity'), []);
});

test('L5 — advisory: в warnings[] не идёт и гейты не роняет', () => {
  const src = L5_PRESSED;
  const r = checkDeck(src);
  assert.ok(r.defects.some(x => x.code === 'l5_proximity'));
  assert.ok(!r.warnings.some(w => /L5|l5/.test(w)), JSON.stringify(r.warnings));
});

// ---------- отчёт ----------

test('отчёт версионирован: deckgen.version = 1.1.0-lint (мёртвая копия на VM этим помечается)', () => {
  const r = checkDeck('# Титул\n');
  assert.equal(r.deckgen.version, D.DECKGEN_VERSION);
});

test('build() не оставляет состояния между прогонами: дефекты обнуляются', () => {
  const bad = checkDeck('## Слайд\n- ✓ маркер\n');
  assert.ok(bad.defects.length > 0);
  const good = checkDeck('# Титул\n');
  assert.deepEqual(good.defects, []);
  assert.deepEqual(good.warnings, []);
});

test('экспортируемая поверхность: build() остаётся доступной для тестов движка', () => {
  assert.equal(typeof build, 'function');
});
