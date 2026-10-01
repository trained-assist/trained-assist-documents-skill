#!/usr/bin/env node
// Наземная правда для lint'а дефектов: измеряет ТЕКСТ в реальном браузере и сверяет
// с оценщиком deckgen (план 77dff113, срез T7).
//
// Оценщик (defects.js + txt() в deckgen) работает по приближению измеренных ширин
// глифов. Chromium меряет факт: scrollHeight/clientHeight бокса и попарные
// прямоугольники строк. Расхождение — громкий дефект ИНСТРУМЕНТА
// (l1_estimator_false_positive / _false_negative), а не тихий.
//
// CLI: node src/deck/render-smoke.js deck.md [--smoke-report out.json]
'use strict';
const fs = require('fs');
const path = require('path');
const { withChromium } = require('../render/chromium');
const D = require('./defects');

const PT = 0.75;            // 1pt = 4/3 CSS-px
const TOL = 2 * 4 / 3;      // тот же допуск 2pt, что и у оценщика (scrollHeight - clientHeight > 2)
const ALIGN_TOL = 3 * 4 / 3;

const { build, splitSlides, parseSlide, parseFront, checkDeck } = require('./deckgen');
const { toHtml, setTheme, C } = require('./engine');

function sourceOf(file) {
  const { meta, body } = parseFront(fs.readFileSync(file, 'utf8'));
  meta._dir = path.dirname(path.resolve(file));
  setTheme(meta.theme || 'dark');
  C.accent = (meta.accent || C.green).replace('#', '');
  return { meta, slides: build(splitSlides(body).map(parseSlide), meta) };
}

// Всё измерение — одним заходом в страницу: rect'ы собираются браузером,
// а не вычисляются на стороне Node.
const MEASURE = ({ blockNames, TOL, ALIGN_TOL }) => {
  const out = [];
  const px = list => [...list].map(x => ({ l: x.left, t: x.top, r: x.right, b: x.bottom, w: x.width, h: x.height }));
  document.querySelectorAll('.s').forEach((s, si) => {
    const ts = [...s.querySelectorAll('.t')];
    const info = ts.map((el, i) => {
      const over = el.scrollHeight - el.clientHeight;
      const range = document.createRange();
      range.selectNodeContents(el.querySelector('div') || el);
      return {
        i, block: blockNames[si] && blockNames[si][i] || null,
        over, rects: px(range.getClientRects()),
        clientH: el.clientHeight, scrollH: el.scrollHeight,
      };
    });
    for (const a of info) {
      if (a.over > TOL) out.push({ kind: 'overflow', slide: si + 1, block: a.block, over: a.over });
    }
    // Наложение: попарные прямоугольники строк РАЗНЫХ блоков. Внутри одного блока
    // строки не сравниваются, предок/потомок исключается по построению.
    for (let i = 0; i < info.length; i++) {
      for (let j = i + 1; j < info.length; j++) {
        let hit = null;
        for (const x of info[i].rects) {
          for (const y of info[j].rects) {
            const w = Math.min(x.r, y.r) - Math.max(x.l, y.l);
            const h = Math.min(x.b, y.b) - Math.max(x.t, y.t);
            if (w > TOL && h > TOL) { hit = { w, h }; break; }
          }
          if (hit) break;
        }
        if (hit) out.push({ kind: 'overlap', slide: si + 1, block: info[i].block, other: info[j].block, ...hit });
      }
    }
    // L4: выравнивание колонок — строки переноса должны начинаться на уровне
    // первой строки блока (висячий отступ), а не уезжать влево от маркера.
    for (const a of info) {
      if (a.rects.length < 2) continue;
      const first = a.rects.reduce((m, r) => (r.t < m.t ? r : m));
      for (const r of a.rects) {
        if (r.t - first.t < 2) continue;
        const d = first.l - r.l;
        if (d > ALIGN_TOL) out.push({ kind: 'align', slide: si + 1, block: a.block, d });
      }
    }
  });
  return out;
};

async function smokeDeck(file) {
  const { meta, slides } = sourceOf(file);
  const html = toHtml(slides);
  const blockNames = slides.map(s => s.items.filter(it => it.k === 'txt').map(it => it.block || null));
  const measured = await withChromium(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });
    await page.setContent(html, { waitUntil: 'load' });
    return page.evaluate(MEASURE, { blockNames, TOL, ALIGN_TOL });
  });

  const defects = [];
  const seen = new Set();
  const add = (d) => { if (!seen.has(`${d.code}|${d.slide}|${d.block}|${d.detail}`)) { seen.add(`${d.code}|${d.slide}|${d.block}|${d.detail}`); defects.push(d); } };
  for (const m of measured) {
    if (m.kind === 'overflow') add({ level: 1, code: 'l1_box_overflow', slide: m.slide, block: m.block, source: 'render', measured_pt: Math.round(m.over * PT), detail: 'текст выше бокса в рендере' });
    else if (m.kind === 'overlap') add({ level: 1, code: 'l1_text_overlap', slide: m.slide, block: m.block, source: 'render', measured_pt: Math.round(Math.min(m.w, m.h) * PT), detail: `наложение на блок «${m.other}» в рендере` });
    else add({ level: 4, code: 'l4_column_alignment', slide: m.slide, block: m.block, source: 'render', measured_pt: Math.round(m.d * PT), detail: 'строки переноса уходят левее первой строки' });
  }

  // сверка оценщика с рендером — по паре (слайд, блок) для сопоставимого кода
  // Сопоставим только l1_box_overflow: наложение строк оценщик не детектит вовсе
  // (у него нет второго блока в том же боксе) — сверять его не с чем, и он был бы
  // вечным ложным «false negative».
  const est = checkDeck(fs.readFileSync(file, 'utf8')).defects.filter(d => d.code === 'l1_box_overflow');
  const key = d => `${d.slide}|${d.block}|${d.code}`;
  const estKeys = new Map(est.map(d => [key(d), d]));
  const renKeys = new Set(defects.map(key));
  let falsePositive = 0, falseNegative = 0;
  for (const [k, d] of estKeys) if (!renKeys.has(k)) {
    falsePositive++;
    add({ level: 1, code: 'l1_estimator_false_positive', slide: d.slide, block: d.block, source: 'reconcile', measured_pt: d.measured_pt, detail: 'оценщик предупредил, рендер чистый' });
  }
  for (const d of defects) if (!estKeys.has(key(d)) && d.source === 'render' && d.code === 'l1_box_overflow') {
    falseNegative++;
    add({ level: 1, code: 'l1_estimator_false_negative', slide: d.slide, block: d.block, source: 'reconcile', measured_pt: d.measured_pt, detail: 'рендер грязный, оценщик молчал' });
  }

  return {
    deckgen: { version: D.DECKGEN_VERSION },
    slides: slides.length,
    theme: meta.theme || 'dark',
    defects,
    score: D.scoreDefects(defects),
    reconcile: {
      estimator_overflow: est.length,
      render_overflow: defects.filter(d => d.source === 'render' && d.code === 'l1_box_overflow').length,
      false_positive: falsePositive,
      false_negative: falseNegative,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
  const input = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--smoke-report');
  if (!input) { console.error('usage: render-smoke deck.md [--smoke-report out.json]'); process.exit(1); }
  const report = await smokeDeck(input);
  const json = JSON.stringify(report, null, 2);
  const file = opt('smoke-report');
  if (file) { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, json + '\n'); }
  console.log(json);
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { smokeDeck };
