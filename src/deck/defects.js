'use strict';

// Схема дефектов слайдов и скоринг (plan 77dff113, срезы T1+).
// Единственная точка контракта: deckgen НЕ знает про уровни — он зовёт эти функции.
//
// Два канала, разведённые намеренно (deck/defect-contract-decision.md, решение ⚫№2):
//   warnings[] — string[], его читают гейты плейбука, --strict и MCP-тулы. ТИП НЕ МЕНЯЕМ.
//   defects[]  — машиночитаемые дефекты с уровнем 1..5.
// Правило канала: level === 1 → оба канала, КРОМЕ кодов расхождения оценщик/рендер
// (l1_estimator_*) — это дефект инструмента, а не слайда, гейты они не роняют.

const DECKGEN_VERSION = '1.1.0-lint';

// Severity points, НЕ проценты качества: 100 — чисто, 0 — переполнение/наложение.
const PENALTY = { 1: 100, 2: 25, 3: 8, 4: 3, 5: 1 };

// Накопители текущего рендера. Обнуляются в renderDeck()/checkDeck() там же,
// где раньше обнулялся один warnings[]. Никаких новых синглтонов.
const warnings = [];
const defects = [];

function reset() { warnings.length = 0; defects.length = 0; }

const isEstimatorMismatch = d => /^l1_estimator_/.test(d.code || '');

// L1 и существующие гейтовые строки: строка в warnings[] И запись в defects[].
// Исключение — коды расхождения оценщик/рендер: это дефект инструмента, гейты не роняют.
function pushWarning(msg, defect) {
  if (defect && isEstimatorMismatch(defect)) { pushDefect(defect); return String(msg); }
  warnings.push(String(msg));
  if (defect) pushDefect(defect);
  return msg;
}

// Advisory-классы (L2/L4/L5) и коды расхождения: только defects[].
function pushDefect(defect) {
  if (!defect || !defect.code) return null;
  const d = {
    level: defect.level || 5,
    code: String(defect.code),
    slide: defect.slide ?? null,
    block: defect.block ?? null,
    detail: defect.detail || '',
    measured_pt: defect.measured_pt ?? null,
    source: defect.source || 'estimate',
  };
  defects.push(d);
  return d;
}

function verdictFor(maxLevel) {
  if (!maxLevel) return 'clean';
  if (maxLevel <= 1) return 'critical';
  if (maxLevel <= 3) return 'warn';
  return 'advisory';
}

function countBy(list) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const d of list) counts[d.level] = (counts[d.level] || 0) + 1;
  return counts;
}

// Скоринг по слайдам и по колоде. Один и тот же список дефектов на входе.
function scoreDefects(list) {
  const bySlide = new Map();
  for (const d of list) {
    const key = String(d.slide ?? 0);
    if (!bySlide.has(key)) bySlide.set(key, []);
    bySlide.get(key).push(d);
  }
  const perSlide = {};
  for (const [key, ds] of [...bySlide.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const maxLevel = Math.min(...ds.map(d => d.level));
    const penalty = ds.reduce((s, d) => s + (PENALTY[d.level] || 0), 0);
    perSlide[key] = {
      score: Math.max(0, 100 - penalty),
      maxLevel,
      verdict: verdictFor(maxLevel),
      counts: countBy(ds),
    };
  }
  const maxLevel = list.length ? Math.min(...list.map(d => d.level)) : 0;
  const penalty = list.reduce((s, d) => s + (PENALTY[d.level] || 0), 0);
  return {
    perSlide,
    deck: {
      score: Math.max(0, 100 - penalty),
      maxLevel,
      verdict: verdictFor(maxLevel),
      counts: countBy(list),
      total: list.length,
    },
  };
}

module.exports = {
  DECKGEN_VERSION, PENALTY, warnings, defects,
  reset, pushWarning, pushDefect, scoreDefects, verdictFor, isEstimatorMismatch,
};
