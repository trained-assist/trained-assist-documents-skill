'use strict';
// Sandbox-цикл для lint'а дефектов колод (plan 77dff113, срезы T1–T8).
// Одна команда, детерминированный pass/fail, без сети и прод-кредов.
//
// Проходит СЦЕНАРИЙ пользователя end-to-end через реальные функциональные блоки:
//   1. агент пишет deck.md и зовёт `deckgen --report` → в отчёте defects[] + score;
//   2. L1 (переполнение бокса) видно БЕЗ рендера — в warnings[] и defects[];
//   3. L1 подтверждается наземной правдой в Chromium (scrollHeight/clientHeight);
//   4. L2 (двойной маркер, бюджет выделений) — только defects[], гейты не роняет;
//   5. починенная колода → defects[] пуст, warnings[] пуст, score clean;
//   6. контракт отчёта версионирован (deckgen.version).
//
// ПОКА ФИЧИ НЕТ — цикл КРАСНЫЙ (defects[]/score/render-smoke.js отсутствуют).
// Зелёный до изменений = песочница ничего не проверяет.
//
// Запуск: bash scripts/sandbox/deck-defect-lint.sh   (он же ставит короткий TMPDIR для Chrome)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'src', 'deck', 'deckgen.js');
const SMOKE = path.join(ROOT, 'src', 'deck', 'render-smoke.js');
const DEMO = path.join(ROOT, 'examples', 'demo-deck.md');

// Чистая колода: ни дефектов, ни предупреждений.
const CLEAN = [
  '---', 'title: Sandbox clean', '---',
  '# Титул', 'Короткий подзаголовок',
  '---', '[ИТОГ · Раздел]', '## Коротко', '- один пункт', '- второй пункт', '',
].join('\n');

// Колода с заведомо известными дефектами:
//   слайд 1 — длинный подзаголовок титула в боксе-константе 30pt → L1 (без рендера молчит — это баг);
//   слайд 2 — пункт с ✓ (двойной маркер) и пункт с 3 приёмами выделения → L2 (только defects[]).
const DEFECTS = [
  '---', 'title: Sandbox defects', '---',
  '# Титул колоды',
  'Очень длинный подзаголовок, который точно не влезает в отведённые ему тридцать пунктов высоты бокса и переносится на несколько строк подряд',
  '---', '[ПРОТОТИП · Проверка]', '## Слайд с дефектами',
  '- ✓ двойной маркер в пункте списка',
  '- **жирный** и ==акцент== и `код` в одном пункте — три приёма выделения', '',
].join('\n');

const checks = [];
function check(name, fn) {
  try { fn(); checks.push({ name, ok: true }); }
  catch (e) { checks.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertArray(v, what) { assert(Array.isArray(v), `${what} отсутствует или не массив — фича не реализована`); }

// Рекурсивно собираем все дефекты из отчёта (структура отчёта может отличаться:
// defects[] верхнего уровня, smoke.defects[] и т.п.).
function collectDefects(node, out = []) {
  if (Array.isArray(node)) { for (const x of node) collectDefects(x, out); return out; }
  if (node && typeof node === 'object') {
    if (typeof node.code === 'string' && node.code.startsWith('l')) out.push(node);
    for (const v of Object.values(node)) collectDefects(v, out);
  }
  return out;
}

function runCli(deckPath, outDir, extra = []) {
  fs.mkdirSync(outDir, { recursive: true });
  const report = path.join(outDir, 'report.json');
  const r = spawnSync(process.execPath,
    [CLI, deckPath, '--out', outDir, '--no-pdf', '--report', report, ...extra],
    { encoding: 'utf8' });
  assert(r.status === 0 || r.status === 2, `deckgen упал (status ${r.status}): ${r.stderr || r.stdout}`);
  return JSON.parse(fs.readFileSync(report, 'utf8'));
}

function writeDeck(dir, name, src) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, src);
  return f;
}

function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lint-'));
  const cleanDir = path.join(work, 'clean');
  const defectsDir = path.join(work, 'defects');
  const smokeDir = path.join(work, 'smoke');

  const cleanDeck = writeDeck(work, 'clean.md', CLEAN);
  const defectsDeck = writeDeck(work, 'defects.md', DEFECTS);

  // --- шаг 1: контракт отчёта (defects[] + score + версия) -------------------
  const clean = runCli(cleanDeck, cleanDir);
  const defects = runCli(defectsDeck, defectsDir);

  check('отчёт содержит defects[] и score (контракт отчёта)', () => {
    assertArray(clean.defects, 'clean.defects');
    assertArray(defects.defects, 'defects.defects');
    assert(defects.score && typeof defects.score === 'object', 'score отсутствует');
    assert(defects.score.deck && typeof defects.score.deck.verdict === 'string',
      'score.deck.verdict отсутствует');
  });

  check('warnings[] остаётся массивом строк (контракт плейбука/--strict не сломан)', () => {
    assertArray(clean.warnings, 'clean.warnings');
    assert(clean.warnings.every(w => typeof w === 'string'), 'warnings должен быть string[]');
  });

  check('отчёт версионирован (deckgen.version = 1.1.0-lint)', () => {
    const v = (defects.deckgen && defects.deckgen.version) || '';
    assert(/1\.1\.0-lint/.test(v), `deckgen.version = "${v}" — ожидалось 1.1.0-lint`);
  });

  // --- шаг 2: L1 видно без рендера ------------------------------------------
  check('L1: переполнение бокса-константы (титул) найдено без рендера, measured_pt > 2', () => {
    const l1 = defects.defects.filter(d => d.code === 'l1_box_overflow');
    assert(l1.length > 0, `нет l1_box_overflow в defects[]: ${JSON.stringify(defects.defects)}`);
    assert(l1.some(d => d.level === 1 && Number(d.measured_pt) > 2),
      `L1 без measured_pt > 2: ${JSON.stringify(l1)}`);
  });

  check('L1 идёт и в warnings[] (гейты плейбука честно краснеют)', () => {
    assert(defects.warnings.some(w => /L1/.test(w)),
      `warnings[] не содержит строки L1: ${JSON.stringify(defects.warnings)}`);
  });

  // --- шаг 4: L2 — только defects[], гейты не роняет ------------------------
  check('L2: двойной маркер найден', () => {
    assert(defects.defects.some(d => d.code === 'l2_double_marker'),
      `нет l2_double_marker: ${JSON.stringify(defects.defects.map(d => d.code))}`);
  });

  check('L2: бюджет выделений (>2 приёмов в блоке) найден', () => {
    assert(defects.defects.some(d => d.code === 'l2_emphasis_budget'),
      `нет l2_emphasis_budget: ${JSON.stringify(defects.defects.map(d => d.code))}`);
  });

  check('L2 не попадает в warnings[] (advisory-канал)', () => {
    assert(!defects.warnings.some(w => /l2|L2/.test(w)),
      `warnings[] содержит L2: ${JSON.stringify(defects.warnings)}`);
  });

  // --- шаг 5: починенная колода чиста ---------------------------------------
  check('чистая колода → defects[] пуст, warnings[] пуст, verdict clean', () => {
    assert(clean.defects.length === 0, `clean.defects не пуст: ${JSON.stringify(clean.defects)}`);
    assert(clean.warnings.length === 0, `clean.warnings не пуст: ${JSON.stringify(clean.warnings)}`);
    assert(clean.score.deck.verdict === 'clean', `verdict = ${clean.score.deck.verdict}`);
  });

  check('колода с L1 → verdict critical', () => {
    assert(defects.score.deck.verdict === 'critical',
      `verdict = ${defects.score.deck.verdict}, ожидалось critical`);
  });

  // --- шаг 3: наземная правда в Chromium ------------------------------------
  check('L1 подтверждается рендером в Chromium (наземная правда)', () => {
    assert(fs.existsSync(SMOKE), `нет ${path.relative(ROOT, SMOKE)} — смоук не реализован`);
    const rep = path.join(smokeDir, 'smoke.json');
    const r = spawnSync(process.execPath, [SMOKE, defectsDeck, '--smoke-report', rep],
      { encoding: 'utf8' });
    assert(r.status === 0, `render-smoke упал: ${r.stderr || r.stdout}`);
    const smoke = JSON.parse(fs.readFileSync(rep, 'utf8'));
    const l1 = collectDefects(smoke).filter(d => d.code.startsWith('l1_'));
    assert(l1.some(d => Number(d.measured_pt) > 2),
      `рендер не подтвердил L1: ${JSON.stringify(collectDefects(smoke).map(d => d.code))}`);
  });

  check('чистая колода (demo-deck) → ноль L1 в рендере', () => {
    if (!fs.existsSync(SMOKE)) throw new Error('нет render-smoke.js — смоук не реализован');
    const rep = path.join(smokeDir, 'demo.json');
    const r = spawnSync(process.execPath, [SMOKE, DEMO, '--smoke-report', rep], { encoding: 'utf8' });
    assert(r.status === 0, `render-smoke упал на demo-deck: ${r.stderr || r.stdout}`);
    const l1 = collectDefects(JSON.parse(fs.readFileSync(rep, 'utf8'))).filter(d => d.code.startsWith('l1_'));
    assert(l1.length === 0, `demo-deck дал ложный L1: ${JSON.stringify(l1)}`);
  });

  // --- итог ------------------------------------------------------------------
  fs.rmSync(work, { recursive: true, force: true });
  const failed = checks.filter(c => !c.ok);
  for (const c of checks) console.log(`${c.ok ? '  ok  ' : ' FAIL '} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
  console.log('');
  console.log(`Sandbox: ${checks.length - failed.length}/${checks.length} проверок зелёные`);
  if (failed.length) {
    console.log(`\nSandbox RED: ${failed.length} проверок красные — фича ещё не реализована (это ожидаемо до срезов T1–T8).`);
    process.exit(1);
  }
  console.log('\nSandbox GREEN: сценарий lint\'а дефектов проходит end-to-end.');
}

main();
