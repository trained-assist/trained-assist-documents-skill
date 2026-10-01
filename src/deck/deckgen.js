#!/usr/bin/env node
// deckgen: Markdown → .pptx + .html + .pdf без LLM. Раскладка выбирается правилами по содержимому слайда.
// Формат разметки: src/deck/deckgen-markdown-format.md. Программно: renderDeck() (его зовёт MCP-инструмент deck_render).
// CLI: node src/deck/deckgen.js deck.md [--out dir] [--name file] [--theme dark|light] [--accent HEX]
//        [--no-pdf] [--png] [--report file.json] [--strict] [--autofix-markers] [--smoke]
//   --report  пишет тот же JSON-отчёт, что и stdout, в файл (каталог создаётся сам)
//   --strict  код выхода 2, если есть warnings (текст не влез) — для машинной проверки в плейбуке
//   --autofix-markers  снять двойной маркер в начале пункта (выключен по умолчанию:
//                      без флага осмысленный «✓» в тексте пункта съедался бы)
//   --smoke   дополнительно измерить текст в Chromium (наземная правда) → отчёт.smoke
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { C, setTheme, Slide, highlight, toPptx, toHtml } = require('./engine');
const { withChromium } = require('../render/chromium');
const { charEm, lineWidth, widestTokenEm } = require('./text-widths');
const D = require('./defects');

const W = 960, H = 540, M = 48, CW = W - 2 * M;
// Накопители текущего рендера живут в defects.js (warnings + defects),
// renderDeck()/checkDeck() обнуляют их в начале через D.reset().
// Допуск L1 — ровно порог из рубрики (scrollHeight > clientHeight + 2), общий для оценщика и смоука.
const L1_TOLERANCE = 2;
// Номер слайда, который сейчас раскладывается: нужен дефектам из txt() и L5.
let curSlide = 0;
// Опции текущего прогона разметки (пока — только авто-чистка маркеров за флагом).
// Обнуляются в beginRun() ВМЕСТЕ с накопителями: иначе флаг одного прогона утекает
// в следующий (deck_check после deck_check --autofix-markers тихо чистил бы текст).
let opts = {};
function beginRun(flags = {}) {
  D.reset();
  opts = { autofixMarkers: !!flags.autofixMarkers };
}

// ---------- оценка размера текста (детерминированно, без рендера) ----------
// Ширины символов — измеренные (см. text-widths.js), а не «средний символ 0.55»:
// иначе заглавная кириллица/латиница недооценивается и слово рвётся посреди.
// mono — фиксированная ширина 0.6, там перенос посреди слова ожидаем.
function textHeight(text, w, size, { mono = false, lh = 1.0, bold = false } = {}) {
  return wrapCount(text, w, size, { mono, bold }) * size * 1.2 * lh;
}
function wrapCount(text, w, size, { mono = false, bold = false } = {}) {
  let lines = 0;
  for (const para of String(text).split('\n')) {
    if (mono) {
      const perLine = Math.max(1, Math.floor(w / (size * 0.6)));
      lines += Math.max(1, Math.ceil(para.length / perLine));
    } else lines += wrapPara(para, w, size, bold);
  }
  return lines;
}
// Жадный перенос по словам с измеренными ширинами. Слово шире строки
// браузер ломает посреди — считаем куски как отдельные строки.
function wrapPara(para, w, size, bold) {
  if (!para) return 1;
  const space = lineWidth(' ', bold) * size;
  const tokens = [];
  for (const word of para.split(/\s+/)) {
    const ww = lineWidth(word, bold) * size;
    if (ww <= w) { tokens.push({ w: ww, br: false }); continue; }
    let rest = ww;
    while (rest > 0) {
      const take = Math.min(rest, w);
      tokens.push({ w: take, br: tokens.length > 0 && rest < ww });
      rest -= take;
    }
  }
  let lines = 1, cur = 0;
  for (const t of tokens) {
    if (t.br) { lines++; cur = t.w; continue; }
    if (cur === 0) cur = t.w;
    else if (cur + space + t.w <= w) cur += space + t.w;
    else { lines++; cur = t.w; }
  }
  return lines;
}
// opts.maxLines — потолок строк: кегль уменьшается пропорционально, пока текст
// не уместится и по высоте, и по числу строк (бенчмарк: блок не переезжает на 3+ строки).
// opts.quiet — не писать предупреждения (пробный подбор, решает вызывающий код).
function fit(text, w, h, max, min, opts = {}, where = '') {
  // Кегль не может превышать тот, при котором самое длинное НЕРАЗРЫВАЕМОЕ слово
  // влезает в колонку — иначе текст перенесётся посреди слова.
  const tokenEm = opts.mono ? 0 : widestTokenEm(text, opts.bold);
  const { maxLines, quiet, ...box } = opts;
  let hi = max;
  if (tokenEm) {
    const byToken = Math.floor(w / tokenEm);
    if (byToken < min) {
      if (!quiet) D.pushWarning(`${where}: слово шире колонки даже в ${min}pt — сократи подпись`,
        { level: 1, code: 'l1_word_wider', slide: curSlide, block: blockOf(where), detail: `слово шире колонки даже в ${min}pt` });
      hi = min;
    } else hi = Math.min(max, byToken);
  }
  for (let s = hi; s >= min; s--) {
    const lines = wrapCount(text, w, s, box);
    if (lines * s * 1.2 * (box.lh || 1) <= h && (!maxLines || lines <= maxLines)) return s;
  }
  if (!quiet) {
    // Измеренный хвост, а не «не влезает»: дальше по этому числу видно, насколько сокращать.
    const over = Math.round(wrapCount(text, w, min, box) * min * 1.2 * (box.lh || 1) - h);
    D.pushWarning(`${where}: текст не влезает даже в ${min}pt — разбей слайд или сократи`,
      { level: 1, code: 'l1_fit_failed', slide: curSlide, block: blockOf(where), detail: `не влезает даже в ${min}pt`, measured_pt: over > 0 ? over : null });
  }
  return min;
}
const plain = runs => (typeof runs === 'string' ? runs : runs.map(r => r.t).join(''));

// L1: единственная точка проверки высоты. Через неё идёт КАЖДЫЙ текстовый блок —
// поэтому блок с боксом-константой (карточка, плашка вывода, строка титула) не может
// уйти непроверенным, как раньше: fit() их просто не звал.
// fit() отвечает на вопрос «поместилось ли», нужен — «на сколько не поместилось».
function txt(sl, where, block, x, y, w, h, runs, o = {}) {
  const size = o.size || 20;
  const lh = o.lh || (o.mono ? 1.1 : 1.0);
  const need = textHeight(plain(runs), w, size, { mono: !!o.mono, lh, bold: !!o.bold });
  const over = need - h;
  if (over > L1_TOLERANCE) {
    D.pushWarning(`L1: ${where} (${block}): текст не влезает на ${Math.round(over)}pt — сократи или разбей слайд`,
      { level: 1, code: 'l1_box_overflow', slide: curSlide, block, detail: 'текст выше бокса', measured_pt: Math.round(over) });
  }
  lintRuns(runs, o, { where, block });
  sl.txt(x, y, w, h, runs, o);
  // Помечаем блок в списке items: отсюда L5 берёт геометрию раскладки.
  // textH — реальная высота ТЕКСТА: бокс текстового блока часто больше (avail()),
  // и мерить близость по боксу значило бы мерить пустоту.
  const it = sl.items[sl.items.length - 1];
  it.block = block;
  it.textH = need;
}

// Блок по подсказке в `where`: «слайд 3 (заголовок)» → 'title'. Нужен, чтобы
// существующие предупреждения fit()/cardsBlock() тоже несли block, а не «слайд N».
const BLOCK_BY_HINT = { 'заголовок': 'title', 'код': 'code', 'вывод': 'callout', 'схема': 'flow' };
const blockOf = where => {
  const m = /\(([^)]+)\)\s*$/.exec(where || '');
  return m ? (BLOCK_BY_HINT[m[1]] || m[1]) : null;
};

// L2: маркер, который автор поставил ВНУТРИ пункта. Список рисует свой маркер
// ('• ', '1. ', '– ') — второй, авторский, даёт «• ✓» и читается как мусор.
const DOUBLE_MARKER = /^\s*(?:[\u2713\u2714\u2611\u2610\u2717\u2718\u25cf\u25cb\u2022\u2023\u25aa\u25e6\u00b7]|\[[ xX\u2713]\]|[\u2014\u2013])\s+/;
const stripDoubleMarker = t => t.replace(DOUBLE_MARKER, '');
const markerOf = t => { const m = DOUBLE_MARKER.exec(t); return m ? m[0].trim() : null; };

// L4: интерлиньяж. engine.js считает line-height как (lh || 1.0) * 1.2 —
// рубрика требует 1.2–1.6. Сегодня все значения в допуске: класс ловит регресс.
const LEADING_MIN = 1.2, LEADING_MAX = 1.6;

// Хук линтера рана: L2 (бюджет выделений), L4 (интерлиньяж).
function lintRuns(runs, o = {}, { where, block } = {}) {
  const list = typeof runs === 'string' ? [{ t: runs }] : runs;
  lintEmphasis(list, o, { where, block });
  lintLeading(o, { where, block });
}

// L2: бюджет выделений — не больше 2 приёмов на блок (по рубрике).
// Тонкость, на которой легко словить десятки ложных срабатываний: карточка всегда
// даёт три цвета оформления (muted тело + accent маркер списка + text жирный), а
// блок кода — цвета подсветки синтаксиса. Ни то, ни другое приёмом автора не является.
function lintEmphasis(runs, o, { where, block }) {
  if (o.mono || !runs.length) return;                    // блок кода — цвета даёт подсветка
  const base = { color: o.color || C.text, bold: !!o.bold, mono: !!o.mono };
  // Приём = ОТКЛОНЕНИЕ от базового оформления блока (жирный, другой цвет, код, курсив).
  // Сам базовый стиль приёмом не считается — иначе «жирный + акцент» давали бы 3.
  const keys = new Set();
  for (const r of runs) {
    if (!r.t || !r.t.trim()) continue;                    // пробельные раны не приём
    if (r.marker) continue;                              // маркер списка — оформление, не приём
    const d = [];
    const color = r.color || o.color || C.text;
    if (color !== base.color) d.push('цвет:' + color);
    if (!!(r.bold ?? o.bold) !== base.bold) d.push('жирный');
    if (!!r.mono !== base.mono) d.push('код');
    if (r.italic) d.push('курсив');
    if (d.length) keys.add(d.sort().join('+'));
  }
  if (keys.size > 2) {
    D.pushDefect({ level: 2, code: 'l2_emphasis_budget', slide: curSlide, block,
      detail: `${keys.size} приёмов выделения в блоке (${[...keys].join(', ')}) — оставь 2` });
  }
}

function lintLeading(o, { where, block }) {
  const ratio = (o.lh || (o.mono ? 1.1 : 1.0)) * 1.2;
  if (ratio < LEADING_MIN || ratio > LEADING_MAX) {
    D.pushDefect({ level: 4, code: 'l4_leading', slide: curSlide, block,
      detail: `интерлиньяж ${ratio.toFixed(2)} вне ${LEADING_MIN}–${LEADING_MAX}` });
  }
}

// L5: теория близости. «Смысловой блок» здесь НЕ догадка, а результат раскладки:
// колонка = кластер блоков с одинаковым x, опорный блок = ближайший предыдущий блок
// той же колонки (для первого — заголовок слайда). Флаг ставится, только когда
// блок в нижних 25% контентной области И ближе к футеру, чем к своему блоку.
// Титулы/разделители (ветка p.h1) и одноколоночные слайды исключены — там скан
// давал ложные срабатывания. Advisory: гейты не роняет.
const L5_FOOTER_Y = 510, L5_BOTTOM = 0.75, L5_GAP_TOL = 8, L5_MAX_H = 1 / 3;
// «Та же колонка» = горизонтальные интервалы блоков пересекаются хотя бы наполовину
// более узкого. Сравнение точек x не годится: текст плашки вывода сдвинут на 20pt
// внутрь своего бокса и в 20pt отличается от блока над ней.
// Нижняя граница БЛИКА блока: конец текста, а не конец бокса.
const inkBottom = b => b.y + Math.min(b.h, b.textH || b.h);
const sameColumn = (a, b) => {
  const o = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  return o > 0 && o >= 0.5 * Math.min(a.w, b.w);
};
const L5_SKIP = new Set(['num', 'footer', 'tag', 'h1', 'title']);

function lintProximity(sl, no, isTitle) {
  if (isTitle) return;                                     // титул/разделитель: раскладки нет
  const footerY = (sl.items.find(it => it.k === 'txt' && it.block === 'footer') || { y: L5_FOOTER_Y }).y;
  const texts = sl.items.filter(it => it.k === 'txt');
  // Оцениваем только содержательные блоки; шапка/номер/футер в оценку не входят,
  // но в опорные входят — иначе у первого блока не было бы «своего».
  const blocks = texts.filter(it => !L5_SKIP.has(it.block || ''));
  if (blocks.length < 2) return;                            // на слайде ≥2 контентных групп
  const top = Math.min(...blocks.map(b => b.y));
  const area = footerY - top;
  for (const b of [...blocks].sort((p, q) => p.y - q.y)) {
    // Блок во всю высоту колонки кончается у футера по построению — флагу�� это не про него.
    if (b.h > L5_MAX_H * area) continue;
    if (inkBottom(b) < top + L5_BOTTOM * area) continue;     // не в нижних 25%
    // Опорный блок: ближайший предыдущий блок той же колонки, для первого — заголовок слайда.
    const anchor = [...blocks].reverse().find(x => x !== b && x.y < b.y && sameColumn(x, b))
      || texts.filter(x => x !== b && (x.block === 'title' || x.block === 'tag' || x.block === 'h1') && x.y < b.y)
          .sort((p, q) => q.y - p.y)[0];
    if (!anchor) return;
    const gapFooter = footerY - inkBottom(b);
    const gapAnchor = b.y - inkBottom(anchor);
    if (gapFooter < gapAnchor - L5_GAP_TOL) {
      D.pushDefect({ level: 5, code: 'l5_proximity', slide: no, block: b.block || 'block',
        detail: `ближе к футеру (${Math.round(gapFooter)}pt), чем к блоку «${anchor.block || 'блок'}» (${Math.round(gapAnchor)}pt)`,
        measured_pt: Math.round(gapAnchor - gapFooter) });
    }
  }
}

// L2: двойной маркер — парс-этап, до раскладки. Список, тела карточек, lead,
// плашки вывод и подписи схемы. Авто-чистка — только за флагом: без неё съедается
// осмысленный «✓» в тексте пункта.
function lintMarkers(p, where) {
  const check = (items, kind, get) => {
    for (const it of items) {
      const t = get(it);
      if (typeof t !== 'string') continue;
      const m = markerOf(t);
      if (!m) continue;
      if (opts.autofixMarkers) {                           // починили — не жалуемся
        const s = stripDoubleMarker(t);
        if (typeof it.t === 'string') it.t = s;
        else if (it.text !== undefined) it.text = s;
        continue;
      }
      D.pushDefect({ level: 2, code: 'l2_double_marker', slide: curSlide, block: kind,
        detail: `маркер «${m}» + маркер списка — убери один` });
    }
  };
  check(p.lead, 'lead', it => it.t);
  check(p.bullets, 'bullets', it => it.t);
  check(p.quote, 'quote', it => it);
  check(p.callouts, 'callout', it => it.text);
  check(p.flow || [], 'flow', it => it.t);
  for (const c of p.cards) check(c.body, 'cards', it => it.t);
}

// Имя блока для отчёта: список с маркерами — 'bullets', абзац — 'lead'.
const blockName = items => (items.some(i => i.lvl !== undefined || i.num !== undefined) ? 'bullets' : 'lead');

// ---------- inline-разметка: **жирный**, ==акцент==, `код` ----------
function inline(s, base = {}) {
  const runs = [];
  const re = /(\*\*[^*]+\*\*)|(==[^=]+==)|(`[^`]+`)/g;
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) runs.push({ t: s.slice(last, m.index), ...base });
    if (m[1]) runs.push({ t: m[1].slice(2, -2), ...base, bold: true, color: base.boldColor || C.text });
    else if (m[2]) runs.push({ t: m[2].slice(2, -2), ...base, bold: true, color: C.accent });
    else runs.push({ t: m[3].slice(1, -1), ...base, mono: true, color: C.orange });
    last = m.index + m[0].length;
  }
  if (last < s.length) runs.push({ t: s.slice(last), ...base });
  return runs.map(({ boldColor, ...r }) => r);
}
const stripInline = s => s.replace(/\*\*|==|`/g, '');

// ---------- парсинг ----------
function parseFront(src) {
  const meta = {};
  if (src.startsWith('---\n')) {
    const end = src.indexOf('\n---', 4);
    const head = src.slice(4, end);
    if (head.split('\n').every(l => !l.trim() || /^\w[\w-]*\s*:/.test(l))) {
      head.split('\n').forEach(l => { const m = l.match(/^(\w[\w-]*)\s*:\s*(.*)$/); if (m) meta[m[1]] = m[2].trim(); });
      src = src.slice(end + 4);
    }
  }
  return { meta, body: src };
}

function splitSlides(body) {
  const out = []; let cur = []; let inCode = false;
  for (const l of body.split('\n')) {
    if (/^```/.test(l)) inCode = !inCode;
    if (!inCode && /^---\s*$/.test(l)) { out.push(cur.join('\n')); cur = []; } else cur.push(l);
  }
  out.push(cur.join('\n'));
  return out.filter(s => s.trim());
}

function parseSlide(src) {
  const s = { h1: null, title: null, tag: null, section: null, lead: [], bullets: [], codes: [], cards: [], table: null,
    quote: [], callouts: [], flow: null, notes: '', images: [], sub: [] };
  const lines = src.split('\n');
  let i = 0, card = null;
  const push = (arr, v) => (card ? card.body.push(v) : arr.push(v));
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const lang = l.slice(3).trim().split(/\s+/)[0] || 'py'; const label = l.slice(3).trim().split(/\s+/).slice(1).join(' ');
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      s.codes.push({ lang: lang === 'yml' ? 'yaml' : lang, src: buf.join('\n'), label }); i++; continue;
    }
    if (/^(Note|Notes|Заметки):\s*$/i.test(l.trim())) { s.notes = lines.slice(i + 1).join('\n').trim(); break; }
    // Пустая строка закрывает текущую карточку: абзац после неё — текст слайда,
    // а не продолжение карточки. Иначе он молча съедался карточкой и та
    // превращалась в 6 строк мелкого шрифта.
    if (!l.trim()) { card = null; i++; continue; }
    let m;
    if ((m = l.match(/^\[([^\]]+)\]\s*$/)) && !s.title && !s.h1) {
      const [tag, ...rest] = m[1].split('·').map(x => x.trim()); s.tag = tag; s.section = rest.join(' · ') || null;
    } else if ((m = l.match(/^#\s+(.*)/))) s.h1 = m[1];
    else if ((m = l.match(/^##\s+(.*)/))) s.title = m[1];
    else if ((m = l.match(/^###\s+(.*)/))) {
      let head = m[1], color = null; const cm = head.match(/\s*\{(\w+)\}\s*$/);
      if (cm) { color = cm[1]; head = head.slice(0, cm.index); }
      card = { head, color, body: [] }; s.cards.push(card);
    } else if ((m = l.match(/^!!(\w*)\s+(.*)/))) s.callouts.push({ color: m[1] || 'accent', text: m[2] });
    else if ((m = l.match(/^>\s?(.*)/))) s.quote.push(m[1]);
    else if ((m = l.match(/^!\[[^\]]*\]\(([^)]+)\)/))) s.images.push(m[1]);
    else if (/^\|.*\|\s*$/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().slice(1, -1).split('|').map(c => stripInline(c.trim()));
        if (!cells.every(c => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      s.table = rows; continue;
    } else if (/\S\s*->\s*\S/.test(l) && !card && !/^\s*[-*]/.test(l)) {
      s.flow = l.split('->').map(x => x.trim()).map(x => { const mm = x.match(/^(.*?)\s*\{(\w+)\}$/); return mm ? { t: mm[1], color: mm[2] } : { t: x }; });
    } else if ((m = l.match(/^(\s*)[-*]\s+(.*)/))) push(s.bullets, { lvl: m[1].length >= 2 ? 1 : 0, t: m[2] });
    else if ((m = l.match(/^(\s*)\d+[.)]\s+(.*)/))) push(s.bullets, { lvl: m[1].length >= 2 ? 1 : 0, t: m[2], num: true });
    else if (l.trim()) push(s.lead, { t: l.trim() });
    i++;
  }
  return s;
}

// ---------- цвета ----------
const TAGS = { 'ПРОТОТИП': 'green', 'ГОТОВО': 'green', 'ИТОГ': 'green', 'DONE': 'green', 'ТЗ': 'orange', 'ПЛАН': 'orange', 'TODO': 'orange',
  'ИНЦИДЕНТ': 'red', 'РИСК': 'red', 'ПРОБЛЕМА': 'red', 'КОНТЕКСТ': 'dim', 'ВОПРОС': 'blue' };
const col = name => C[name] || (name === 'accent' ? C.accent : /^[0-9A-Fa-f]{6}$/.test(name || '') ? name : C.accent);
const bgOf = c => ({ [C.green]: C.greenBg, [C.red]: C.redBg, [C.orange]: C.orangeBg, [C.blue]: C.blueBg })[c] || C.panel;

// ---------- рендер блоков ----------
function bulletRuns(items, base = {}) {
  const runs = []; let n = 0;
  items.forEach((b, i) => {
    if (i) runs.push({ t: '\n' });
    if (b.num === undefined && b.lvl === undefined) { runs.push(...inline(b.t, base)); return; }
    const mark = b.num ? `${++n}. ` : (b.lvl ? '    – ' : '• ');
    runs.push({ t: mark, color: b.lvl ? C.dim : C.accent, bold: true, marker: true });
    runs.push(...inline(b.t, { ...base, color: b.lvl ? C.muted : base.color }));
  });
  return runs;
}

function textBlock(sl, x, y, w, h, items, max, min, where) {
  const runs = bulletRuns(items);
  const size = fit(plain(runs), w, h, max, min, { lh: 1.25 }, where);
  txt(sl, where, blockName(items), x, y, w, h, runs, { size, lh: 1.25, color: C.text });
}

function codeBlock(sl, x, y, w, h, c, where) {
  sl.box(x, y, w, h, { fill: C.codeBg, line: C.border, r: 8 });
  const top = c.label ? 30 : 14;
  if (c.label) txt(sl, where, 'code-label', x + 14, y + 8, w - 28, 18, c.label, { size: 13, color: C.dim, bold: true });
  const src = c.src.replace(/\s+$/, '');
  const longest = Math.max(...src.split('\n').map(l => l.length));
  const maxByWidth = Math.floor((w - 32) / (longest * 0.6));
  const size = fit(src, w - 32, h - top - 10, Math.max(11, Math.min(18, maxByWidth)), 11, { mono: true, lh: 1.1 }, where + ' (код)');
  txt(sl, where, 'code', x + 16, y + top, w - 32, h - top - 10, highlight(src, c.lang === 'yaml' ? 'yaml' : 'py'), { size, mono: true });
}

function cardsBlock(sl, x, y, w, h, cards, where, opts = {}) {
  const n = cards.length, perRow = n <= 4 ? n : Math.ceil(n / 2), rows = Math.ceil(n / perRow), gap = 16;
  const cw = (w - gap * (perRow - 1)) / perRow; let ch = (h - gap * (rows - 1)) / rows;
  // один кегль на все карточки — выглядит ровнее
  const bodies = cards.map(c => plain(bulletRuns(c.body)));
  const headBox = cw - 28;
  const headS = Math.min(h < 140 ? 20 : 24, fit(cards.map(c => stripInline(c.head)).sort((a, b) => b.length - a.length)[0], headBox, 60, 26, 16, { bold: true, maxLines: 2 }, where));
  // Иерархия «дерева» (бенчмарк — слайды докладчика): подзаголовок = 0.66 заголовка,
  // то есть заголовок блока заметно крупнее (≈1.5×), а не почти одного кегля.
  const HIERARCHY = 0.66, BODY_MIN = 12, BODY_MAX_LINES = 4;
  let bs = Math.max(BODY_MIN, Math.min(22, Math.floor(headS * HIERARCHY)));
  const bodyBox = () => ch - 28 - headS * 1.3 - 6;
  const fits = s => s >= BODY_MIN
    && bodies.every(b => textHeight(b, headBox, s, { lh: 1.2 }) <= bodyBox()
        && wrapCount(b, headBox, s) <= BODY_MAX_LINES);
  for (; bs > BODY_MIN && !fits(bs); bs--) {}
  if (!fits(bs)) D.pushWarning(`${where}: в карточках много текста (больше ${BODY_MAX_LINES} строк) — сократи или раздели слайд`,
    { level: 3, code: 'l3_card_body_lines', slide: curSlide, block: 'cards', detail: `больше ${BODY_MAX_LINES} строк текста в теле карточки` });
  if (bs > 0 && headS / bs < 1.3) D.pushWarning(`${where}: иерархия заголовок/подзаголовок ${headS}/${bs} меньше 1.3 — уменьши подзаголовок`,
    { level: 4, code: 'l4_hierarchy', slide: curSlide, block: 'cards-head', detail: `иерархия ${headS}/${bs} = ${(headS / bs).toFixed(2)} меньше 1.3` });
  const need = Math.max(...cards.map((c, i) => 30 + textHeight(stripInline(c.head), headBox, headS) + (c.body.length ? 8 + textHeight(bodies[i], headBox, bs, { lh: 1.2 }) : 0)));
  if (!opts.stretch) ch = Math.min(ch, Math.max(need + 16, ch * 0.45));
  cards.forEach((c, i) => {
    const cx = x + (i % perRow) * (cw + gap), cy = y + Math.floor(i / perRow) * (ch + gap);
    const color = c.color ? col(c.color) : C.accent;
    const tinted = c.color && c.color !== 'accent';
    sl.box(cx, cy, cw, ch, { fill: tinted ? bgOf(color) : C.panel, line: tinted ? color : C.border, r: 8 });
    const hh = textHeight(stripInline(c.head), cw - 28, headS);
    txt(sl, where, 'cards-head', cx + 14, cy + 12, cw - 28, hh, inline(c.head, { bold: true, color }), { size: headS, bold: true, color });
    if (c.body.length) txt(sl, where, 'cards', cx + 14, cy + 18 + hh, cw - 28, ch - 30 - hh, bulletRuns(c.body, { color: C.muted, boldColor: C.text }), { size: bs, lh: 1.2, color: C.muted });
  });
}

function flowBlock(sl, x, y, w, h, flow, where = 'flow') {
  // Бенчмарк (слайды докладчика): подпись узла — ОДНА строка, кегль уменьшается
  // пропорционально ширине узла. Раньше кегль подбирался только по высоте бокса,
  // и длинная подпись переезжала на 2–3 строки.
  const n = flow.length, gap = n >= 4 ? 18 : 28, bw = (w - gap * (n - 1)) / n;
  const inner = bw - 12, boxH = h - 16, MIN = 11, MAX = 24;
  const labels = flow.map(f => stripInline(f.t));
  // Кегль, при котором каждая подпись укладывается в maxLines строк (null — не укладывается).
  const pick = maxLines => {
    const sizes = labels.map(t => {
      const tokenEm = widestTokenEm(t, true);
      const hi = tokenEm ? Math.min(MAX, Math.floor(inner / tokenEm)) : MAX;
      if (hi < MIN) return null;
      for (let s = hi; s >= MIN; s--) if (wrapCount(t, inner, s, { bold: true }) <= maxLines) return s;
      return null;
    });
    return sizes.some(v => v === null) ? null : Math.min(...sizes);
  };
  const whereF = `${where} (схема)`;
  let size = pick(1);
  if (size === null) {
    size = pick(2);
    if (size === null) {
      D.pushWarning(`${whereF}: слово шире колонки даже в ${MIN}pt — сократи подпись`,
        { level: 1, code: 'l1_word_wider', slide: curSlide, block: 'flow', detail: `подпись узла шире колонки даже в ${MIN}pt` });
      size = MIN;
    } else D.pushWarning(`${whereF}: цепочка не помещается в одну строку — кегль уменьшен, максимум 2 строки`,
      { level: 3, code: 'l3_flow_lines', slide: curSlide, block: 'flow', detail: 'подписи узлов в 2 строки' });
  }
  flow.forEach((f, i) => {
    const bx = x + i * (bw + gap), c = f.color ? col(f.color) : null;
    sl.box(bx, y, bw, h, { fill: c ? bgOf(c) : C.panel, line: c || C.border, r: 8 });
    txt(sl, where, 'flow', bx + 6, y, inner, h, inline(f.t, { color: c || C.text }), { size, bold: true, align: 'center', valign: 'middle', color: c || C.text });
    if (i < n - 1) sl.line(bx + bw + 4, y + h / 2, bx + bw + gap - 4, y + h / 2, { color: C.dim, w: 2, arrow: true });
  });
}

function calloutBlock(sl, y, c, where) {
  const color = col(c.color);
  const size = fit(stripInline(c.text), CW - 40, 44, 22, 15, { bold: true }, where + ' (вывод)');
  sl.box(M, y, CW, 48, { fill: bgOf(color), line: color, r: 8 });
  txt(sl, where, 'callout', M + 20, y, CW - 40, 48, inline(c.text, { color, bold: true }), { size, bold: true, color, valign: 'middle' });
}

// ---------- раскладки ----------
function build(parsed, meta) {
  const slides = [];
  const total = parsed.length;
  parsed.forEach((p, idx) => {
    const no = idx + 1, where = `слайд ${no}`;
    curSlide = no;
    lintMarkers(p, where);
    const sl = new Slide(); slides.push(sl);
    sl.notes = p.notes;
    sl.box(0, 0, W, 6, { fill: C.accent });

    // титул / разделитель
    if (p.h1) {
      const isTitle = idx === 0;
      const lines = [...p.lead.map(x => x.t), ...p.bullets.map(x => x.t)];
      if (p.tag) txt(sl, where, 'tag', 64, 60, 800, 26, p.tag, { size: 20, bold: true, color: C.accent });
      const hs = fit(p.h1, 830, 170, isTitle ? 44 : 48, 28, { lh: 1.1, bold: true }, where);
      const hh = textHeight(p.h1, 830, hs, { lh: 1.1 });
      const y0 = isTitle ? 120 : Math.max(120, (H - hh - 40 * lines.length) / 2);
      txt(sl, where, 'h1', 64, y0, 830, hh, p.h1.replace(/\\n/g, '\n'), { size: hs, bold: true, lh: 1.1 });
      let y = y0 + hh + 24;
      if (lines.length) {
        sl.line(64, y, 200, y, { color: C.accent, w: 3 }); y += 18;
        lines.forEach((t, i) => { txt(sl, where, 'title', 64, y, 830, 30, inline(t, { color: i ? C.muted : C.text }), { size: i ? 18 : 22, bold: !i, color: C.muted }); y += i ? 28 : 34; });
      }
      if (!isTitle) txt(sl, where, 'num', 880, 510, 50, 18, String(no).padStart(2, '0'), { size: 11, color: C.dim, align: 'right' });
      return;
    }

    // шапка
    let y = 30;
    if (p.tag) {
      const tc = col(TAGS[p.tag.toUpperCase()] || 'accent');
      txt(sl, where, 'tag', M, 24, CW, 22, [{ t: p.tag.toUpperCase(), color: tc, bold: true }, { t: p.section ? '  ·  ' + p.section.toUpperCase() : '', color: C.dim, bold: true }], { size: 15 });
      y = 50;
    }
    if (p.title) {
      const ts = fit(stripInline(p.title), CW, 80, 32, 22, { bold: true }, where + ' (заголовок)');
      const th = textHeight(stripInline(p.title), CW, ts);
      txt(sl, where, 'title', M, y, CW, th, inline(p.title, { color: C.text }), { size: ts, bold: true });
      y += th + 22;
    }
    txt(sl, where, 'num', 880, 510, 50, 18, String(no).padStart(2, '0'), { size: 11, color: C.dim, align: 'right' });
    if (meta.footer) txt(sl, where, 'footer', M, 510, 700, 18, meta.footer, { size: 11, color: C.dim });

    let bottom = 500;
    if (p.callouts.length) { bottom = 500 - p.callouts.length * 58; p.callouts.forEach((c, i) => calloutBlock(sl, bottom + 10 + i * 58, c, where)); bottom -= 4; }
    const avail = () => bottom - y;

    // тезис-цитата
    if (p.quote.length && !p.codes.length && !p.cards.length && !p.table) {
      const q = p.quote.join('\n');
      const extra = [...p.lead, ...p.bullets];
      const qh = extra.length ? avail() * 0.6 : avail();
      const qs = fit(stripInline(q), CW - 60, qh, 40, 22, { lh: 1.15, bold: true }, where);
      // bold обязан совпадать с fit() и с рисованием: жирный текст шире, и без него
      // бокс цитаты считался ниже, чем текст, который в него рисовали (L1 наезжал
      // на текст под цитатой). Найдено L1-линтером на examples/demo-deck.md.
      const realH = Math.min(qh, textHeight(stripInline(q), CW - 60, qs, { lh: 1.15, bold: true }));
      const qy = extra.length ? y + 10 : y + (avail() - realH) / 2;
      sl.box(M, qy + 4, 6, realH - 4, { fill: C.accent });
      txt(sl, where, 'quote', M + 30, qy, CW - 60, realH, inline(q, { color: C.text }), { size: qs, bold: true, lh: 1.15 });
      if (extra.length) textBlock(sl, M + 30, qy + realH + 30, CW - 60, bottom - (qy + realH + 30), extra, 24, 16, where);
      return;
    }

    // вводный текст сверху (если есть другие блоки)
    const text = [...p.lead, ...p.bullets];
    const hasMain = p.codes.length || p.cards.length || p.table || p.flow || p.images.length;
    if (text.length && hasMain && !(p.codes.length && !p.cards.length && p.bullets.length)) {
      const runs = bulletRuns(text);
      const s = fit(plain(runs), CW, Math.min(110, avail() * 0.35), 22, 16, { lh: 1.25 }, where);
      const th = textHeight(plain(runs), CW, s, { lh: 1.25 });
      txt(sl, where, blockName(text), M, y, CW, th, runs, { size: s, lh: 1.25, color: C.text });
      y += th + 16;
    }

    if (p.flow) {
      const alone = !(p.cards.length || p.codes.length || p.table || p.images.length);
      const fh = Math.min(90, avail() * (alone ? 0.6 : 0.3));
      if (alone) y += Math.max(0, (avail() - fh) / 2 - 20);
      flowBlock(sl, M, y, CW, fh, p.flow, where); y += fh + 20;
    }

    if (p.codes.length) {
      const side = p.cards.length ? p.cards : null;
      const sideText = !side && p.bullets.length ? [...p.lead, ...p.bullets] : null;
      if (p.codes.length >= 2) {
        const cw = (CW - 16) / 2;
        const h = side ? avail() * 0.6 : avail();
        p.codes.slice(0, 2).forEach((c, i) => codeBlock(sl, M + i * (cw + 16), y, cw, h, c, where));
        if (side) cardsBlock(sl, M, y + h + 16, CW, avail() - h - 16, side, where);
      } else if (side || sideText) {
        const cw = CW * 0.64;
        codeBlock(sl, M, y, cw, avail(), p.codes[0], where);
        if (side) cardsBlockColumn(sl, M + cw + 16, y, CW - cw - 16, avail(), side, where);
        else textBlock(sl, M + cw + 20, y, CW - cw - 20, avail(), sideText, 20, 14, where);
      } else codeBlock(sl, M, y, CW, avail(), p.codes[0], where);
    } else if (p.table) {
      const nrows = p.table.length;
      const size = Math.max(12, Math.min(20, Math.floor(avail() / nrows / 1.9)));
      sl.table(M, y, CW, p.table, { size });
      if (p.cards.length) D.pushWarning(`${where}: таблица и карточки на одном слайде — карточки пропущены`,
        { level: 3, code: 'l3_table_cards', slide: curSlide, block: 'table', detail: 'таблица и карточки на одном слайде' });
    } else if (p.images.length) {
      const img = path.resolve(meta._dir, p.images[0]);
      if (p.cards.length) { const iw = CW * 0.55; sl.img(M, y, iw, avail(), img); cardsBlockColumn(sl, M + iw + 16, y, CW - iw - 16, avail(), p.cards, where); }
      else sl.img(M, y, CW, avail(), img);
    } else if (p.cards.length) {
      cardsBlock(sl, M, y, CW, avail(), p.cards, where);
    } else if (text.length && !p.flow) {
      textBlock(sl, M, y, CW, avail(), text, 28, 16, where);
    }
    lintProximity(sl, no, !!p.h1);
  });
  return slides;
}

// карточки колонкой справа от кода/картинки
function cardsBlockColumn(sl, x, y, w, h, cards, where) {
  const gap = 14, ch = (h - gap * (cards.length - 1)) / cards.length;
  cards.forEach((c, i) => cardsBlock(sl, x, y + i * (ch + gap), w, ch, [c], where, { stretch: true }));
}

// ---------- PDF ----------
async function toPdf(html, file, pngDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deckgen-'));
  try {
    await withChromium(async (b) => {
      const p = await b.newPage();
      const i0 = html.indexOf('<body>') + 6, head = html.slice(0, i0);
      const parts = html.slice(i0).replace('</body></html>', '').split('<div class="s">').slice(1);
      const files = [];
      // Chrome ужимает многостраничную печать — печатаем по слайду и склеиваем
      for (let i = 0; i < parts.length; i++) {
        fs.writeFileSync(path.join(tmp, 'one.html'), head + '<div class="s">' + parts[i] + '</body></html>');
        await p.goto(`file://${path.join(tmp, 'one.html')}`);
        const f = path.join(tmp, `${String(i + 1).padStart(3, '0')}.pdf`);
        await p.pdf({ path: f, preferCSSPageSize: true, printBackground: true });
        files.push(f);
      }
      // execFile с массивом аргументов: имена файлов приходят от пользователя, shell не нужен.
      if (files.length > 1) execFileSync('pdfunite', [...files, file]);
      else fs.copyFileSync(files[0], file);
    });
    if (pngDir) { fs.mkdirSync(pngDir, { recursive: true }); execFileSync('pdftoppm', ['-r', '50', '-png', file, path.join(pngDir, 'p')]); }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- API ----------
/**
 * Отрендерить markdown-колоду в pptx + html (+ pdf).
 * @returns {Promise<{slides:number, pptx:string, html:string, pdf:string|null, warnings:string[], defects:object[], score:object}>}
 */
async function renderDeck({ input, outDir, name, theme, accent, pdf = true, png = false, autofixMarkers = false }) {
  beginRun({ autofixMarkers });
  const { meta, body } = parseFront(fs.readFileSync(input, 'utf8'));
  meta._dir = path.dirname(path.resolve(input));
  setTheme(theme || meta.theme || 'dark');
  C.accent = (accent || meta.accent || C.green).replace('#', '');
  outDir = outDir || path.dirname(input);
  name = name || meta.file || path.basename(input, path.extname(input));
  fs.mkdirSync(outDir, { recursive: true });

  const slides = build(splitSlides(body).map(parseSlide), meta);
  const pptxPath = path.join(outDir, name + '.pptx');
  await toPptx(slides, pptxPath, meta);
  const html = toHtml(slides);
  const htmlPath = path.join(outDir, name + '.html');
  fs.writeFileSync(htmlPath, html);
  let pdfPath = null;
  if (pdf) { pdfPath = path.join(outDir, name + '.pdf'); await toPdf(html, pdfPath, png ? path.join(outDir, name + '-png') : null); }
  return {
    slides: slides.length, pptx: pptxPath, html: htmlPath, pdf: pdfPath,
    warnings: [...D.warnings], defects: [...D.defects], score: D.scoreDefects(D.defects),
    deckgen: { version: D.DECKGEN_VERSION },
  };
}

// Только синтаксис/раскладка, без файлов — быстрая проверка «влезает ли текст».
function checkDeck(src, options = {}) {
  beginRun(options);
  const { meta, body } = parseFront(src);
  meta._dir = process.cwd();
  // Та же тема и акцент, что и в renderDeck: иначе check считал бы дефекты по цветам
  // предыдущего рендера, и сверка «оценщик против рендера» в смоуке врала бы.
  setTheme(meta.theme || 'dark');
  C.accent = (meta.accent || C.green).replace('#', '');
  const slides = build(splitSlides(body).map(parseSlide), meta);
  return {
    slides: slides.length, warnings: [...D.warnings], defects: [...D.defects],
    score: D.scoreDefects(D.defects), deckgen: { version: D.DECKGEN_VERSION },
  };
}

// ---------- CLI ----------
const VALUE_FLAGS = ['--out', '--name', '--theme', '--accent', '--report'];
async function main() {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
  const input = args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1]));
  if (!input) { console.error('usage: deckgen deck.md [--out dir] [--name file] [--theme dark|light] [--accent HEX] [--no-pdf] [--png] [--report file.json] [--strict]'); process.exit(1); }
  const result = await renderDeck({
    input, outDir: opt('out'), name: opt('name'), theme: opt('theme'), accent: opt('accent'),
    pdf: !args.includes('--no-pdf'), png: args.includes('--png'),
    autofixMarkers: args.includes('--autofix-markers'),
  });
  if (args.includes('--smoke')) {
    // Наземная правда: та же колода, измеренная в браузере, + сверка с оценщиком.
    const { smokeDeck } = require('./render-smoke');
    result.smoke = await smokeDeck(input);
  }
  const report = JSON.stringify(result, null, 2);
  const reportFile = opt('report');
  if (reportFile) { fs.mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true }); fs.writeFileSync(reportFile, report + '\n'); }
  console.log(report);
  if (args.includes('--strict') && result.warnings.length) process.exit(2);
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { parseSlide, parseFront, splitSlides, build, renderDeck, checkDeck, txt, blockName };
