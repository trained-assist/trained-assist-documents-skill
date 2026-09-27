#!/usr/bin/env node
// deckgen: Markdown → .pptx + .html + .pdf без LLM. Раскладка выбирается правилами по содержимому слайда.
// Формат разметки: src/deck/deckgen-markdown-format.md. Программно: renderDeck() (его зовёт MCP-инструмент deck_render).
// CLI: node src/deck/deckgen.js deck.md [--out dir] [--name file] [--theme dark|light] [--accent HEX]
//        [--no-pdf] [--png] [--report file.json] [--strict]
//   --report  пишет тот же JSON-отчёт, что и stdout, в файл (каталог создаётся сам)
//   --strict  код выхода 2, если есть warnings (текст не влез) — для машинной проверки в плейбуке
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { C, setTheme, Slide, highlight, toPptx, toHtml } = require('./engine');
const { withChromium } = require('../render/chromium');

const W = 960, H = 540, M = 48, CW = W - 2 * M;
// Накопитель предупреждений текущего рендера — renderDeck() обнуляет его в начале.
const warnings = [];

// ---------- оценка размера текста (детерминированно, без рендера) ----------
// средняя ширина символа в долях кегля: Helvetica/кириллица ≈ 0.55, моно ≈ 0.6
function textHeight(text, w, size, { mono = false, lh = 1.0 } = {}) {
  const cw = size * (mono ? 0.6 : 0.55);
  const perLine = Math.max(1, Math.floor(w / cw));
  let lines = 0;
  for (const para of text.split('\n')) {
    lines += mono ? Math.max(1, Math.ceil(para.length / perLine)) : wrapCount(para, perLine);
  }
  return lines * size * 1.2 * lh;
}
function wrapCount(para, perLine) {
  if (!para) return 1;
  let lines = 1, cur = 0;
  for (const word of para.split(/\s+/)) {
    const L = word.length;
    if (cur === 0) cur = L;
    else if (cur + 1 + L <= perLine) cur += 1 + L;
    else { lines++; cur = L; }
    while (cur > perLine) { lines++; cur -= perLine; }
  }
  return lines;
}
function fit(text, w, h, max, min, opts = {}, where = '') {
  for (let s = max; s >= min; s--) if (textHeight(text, w, s, opts) <= h) return s;
  warnings.push(`${where}: текст не влезает даже в ${min}pt — разбей слайд или сократи`);
  return min;
}
const plain = runs => runs.map(r => r.t).join('');

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
    runs.push({ t: mark, color: b.lvl ? C.dim : C.accent, bold: true });
    runs.push(...inline(b.t, { ...base, color: b.lvl ? C.muted : base.color }));
  });
  return runs;
}

function textBlock(sl, x, y, w, h, items, max, min, where) {
  const runs = bulletRuns(items);
  const size = fit(plain(runs), w, h, max, min, { lh: 1.25 }, where);
  sl.txt(x, y, w, h, runs, { size, lh: 1.25, color: C.text });
}

function codeBlock(sl, x, y, w, h, c, where) {
  sl.box(x, y, w, h, { fill: C.codeBg, line: C.border, r: 8 });
  const top = c.label ? 30 : 14;
  if (c.label) sl.txt(x + 14, y + 8, w - 28, 18, c.label, { size: 13, color: C.dim, bold: true });
  const src = c.src.replace(/\s+$/, '');
  const longest = Math.max(...src.split('\n').map(l => l.length));
  const maxByWidth = Math.floor((w - 32) / (longest * 0.6));
  const size = fit(src, w - 32, h - top - 10, Math.max(11, Math.min(18, maxByWidth)), 11, { mono: true, lh: 1.1 }, where + ' (код)');
  sl.txt(x + 16, y + top, w - 32, h - top - 10, highlight(src, c.lang === 'yaml' ? 'yaml' : 'py'), { size, mono: true });
}

function cardsBlock(sl, x, y, w, h, cards, where, opts = {}) {
  const n = cards.length, perRow = n <= 4 ? n : Math.ceil(n / 2), rows = Math.ceil(n / perRow), gap = 16;
  const cw = (w - gap * (perRow - 1)) / perRow; let ch = (h - gap * (rows - 1)) / rows;
  // один кегль на все карточки — выглядит ровнее
  const bodies = cards.map(c => plain(bulletRuns(c.body)));
  let bs = 22;
  const headS = Math.min(h < 140 ? 20 : 24, fit(cards.map(c => stripInline(c.head)).sort((a, b) => b.length - a.length)[0], cw - 28, 60, 26, 16, {}, where));
  for (; bs > 14; bs--) if (bodies.every(b => textHeight(b, cw - 28, bs, { lh: 1.2 }) <= ch - 28 - headS * 1.3 - 6)) break;
  if (bs === 14 && bodies.some(b => textHeight(b, cw - 28, 14, { lh: 1.2 }) > ch - 28 - headS * 1.3 - 6)) warnings.push(`${where}: в карточках много текста`);
  const need = Math.max(...cards.map((c, i) => 30 + textHeight(stripInline(c.head), cw - 28, headS) + (c.body.length ? 8 + textHeight(bodies[i], cw - 28, bs, { lh: 1.2 }) : 0)));
  if (!opts.stretch) ch = Math.min(ch, Math.max(need + 16, ch * 0.45));
  cards.forEach((c, i) => {
    const cx = x + (i % perRow) * (cw + gap), cy = y + Math.floor(i / perRow) * (ch + gap);
    const color = c.color ? col(c.color) : C.accent;
    const tinted = c.color && c.color !== 'accent';
    sl.box(cx, cy, cw, ch, { fill: tinted ? bgOf(color) : C.panel, line: tinted ? color : C.border, r: 8 });
    const hh = textHeight(stripInline(c.head), cw - 28, headS);
    sl.txt(cx + 14, cy + 12, cw - 28, hh, inline(c.head, { bold: true, color }), { size: headS, bold: true, color });
    if (c.body.length) sl.txt(cx + 14, cy + 18 + hh, cw - 28, ch - 30 - hh, bulletRuns(c.body, { color: C.muted, boldColor: C.text }), { size: bs, lh: 1.2, color: C.muted });
  });
}

function flowBlock(sl, x, y, w, h, flow) {
  const n = flow.length, gap = 28, bw = (w - gap * (n - 1)) / n;
  const size = Math.min(...flow.map(f => fit(stripInline(f.t), bw - 16, h - 16, 24, 14, {}, 'flow')));
  flow.forEach((f, i) => {
    const bx = x + i * (bw + gap), c = f.color ? col(f.color) : null;
    sl.box(bx, y, bw, h, { fill: c ? bgOf(c) : C.panel, line: c || C.border, r: 8 });
    sl.txt(bx + 8, y, bw - 16, h, inline(f.t, { color: c || C.text }), { size, bold: true, align: 'center', valign: 'middle', color: c || C.text });
    if (i < n - 1) sl.line(bx + bw + 4, y + h / 2, bx + bw + gap - 4, y + h / 2, { color: C.dim, w: 2, arrow: true });
  });
}

function calloutBlock(sl, y, c, where) {
  const color = col(c.color);
  const size = fit(stripInline(c.text), CW - 40, 44, 22, 15, {}, where + ' (вывод)');
  sl.box(M, y, CW, 48, { fill: bgOf(color), line: color, r: 8 });
  sl.txt(M + 20, y, CW - 40, 48, inline(c.text, { color, bold: true }), { size, bold: true, color, valign: 'middle' });
}

// ---------- раскладки ----------
function build(parsed, meta) {
  const slides = [];
  const total = parsed.length;
  parsed.forEach((p, idx) => {
    const no = idx + 1, where = `слайд ${no}`;
    const sl = new Slide(); slides.push(sl);
    sl.notes = p.notes;
    sl.box(0, 0, W, 6, { fill: C.accent });

    // титул / разделитель
    if (p.h1) {
      const isTitle = idx === 0;
      const lines = [...p.lead.map(x => x.t), ...p.bullets.map(x => x.t)];
      if (p.tag) sl.txt(64, 60, 800, 26, p.tag, { size: 20, bold: true, color: C.accent });
      const hs = fit(p.h1, 830, 170, isTitle ? 44 : 48, 28, { lh: 1.1 }, where);
      const hh = textHeight(p.h1, 830, hs, { lh: 1.1 });
      const y0 = isTitle ? 120 : Math.max(120, (H - hh - 40 * lines.length) / 2);
      sl.txt(64, y0, 830, hh, p.h1.replace(/\\n/g, '\n'), { size: hs, bold: true, lh: 1.1 });
      let y = y0 + hh + 24;
      if (lines.length) {
        sl.line(64, y, 200, y, { color: C.accent, w: 3 }); y += 18;
        lines.forEach((t, i) => { sl.txt(64, y, 830, 30, inline(t, { color: i ? C.muted : C.text }), { size: i ? 18 : 22, bold: !i, color: C.muted }); y += i ? 28 : 34; });
      }
      if (!isTitle) sl.txt(880, 510, 50, 18, String(no).padStart(2, '0'), { size: 11, color: C.dim, align: 'right' });
      return;
    }

    // шапка
    let y = 30;
    if (p.tag) {
      const tc = col(TAGS[p.tag.toUpperCase()] || 'accent');
      sl.txt(M, 24, CW, 22, [{ t: p.tag.toUpperCase(), color: tc, bold: true }, { t: p.section ? '  ·  ' + p.section.toUpperCase() : '', color: C.dim, bold: true }], { size: 15 });
      y = 50;
    }
    if (p.title) {
      const ts = fit(stripInline(p.title), CW, 80, 32, 22, {}, where + ' (заголовок)');
      const th = textHeight(stripInline(p.title), CW, ts);
      sl.txt(M, y, CW, th, inline(p.title, { color: C.text }), { size: ts, bold: true });
      y += th + 22;
    }
    sl.txt(880, 510, 50, 18, String(no).padStart(2, '0'), { size: 11, color: C.dim, align: 'right' });
    if (meta.footer) sl.txt(M, 510, 700, 18, meta.footer, { size: 11, color: C.dim });

    let bottom = 500;
    if (p.callouts.length) { bottom = 500 - p.callouts.length * 58; p.callouts.forEach((c, i) => calloutBlock(sl, bottom + 10 + i * 58, c, where)); bottom -= 4; }
    const avail = () => bottom - y;

    // тезис-цитата
    if (p.quote.length && !p.codes.length && !p.cards.length && !p.table) {
      const q = p.quote.join('\n');
      const extra = [...p.lead, ...p.bullets];
      const qh = extra.length ? avail() * 0.6 : avail();
      const qs = fit(stripInline(q), CW - 60, qh, 40, 22, { lh: 1.15 }, where);
      const realH = Math.min(qh, textHeight(stripInline(q), CW - 60, qs, { lh: 1.15 }));
      const qy = extra.length ? y + 10 : y + (avail() - realH) / 2;
      sl.box(M, qy + 4, 6, realH - 4, { fill: C.accent });
      sl.txt(M + 30, qy, CW - 60, realH, inline(q, { color: C.text }), { size: qs, bold: true, lh: 1.15 });
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
      sl.txt(M, y, CW, th, runs, { size: s, lh: 1.25, color: C.text });
      y += th + 16;
    }

    if (p.flow) {
      const alone = !(p.cards.length || p.codes.length || p.table || p.images.length);
      const fh = Math.min(90, avail() * (alone ? 0.6 : 0.3));
      if (alone) y += Math.max(0, (avail() - fh) / 2 - 20);
      flowBlock(sl, M, y, CW, fh, p.flow); y += fh + 20;
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
      if (p.cards.length) warnings.push(`${where}: таблица и карточки на одном слайде — карточки пропущены`);
    } else if (p.images.length) {
      const img = path.resolve(meta._dir, p.images[0]);
      if (p.cards.length) { const iw = CW * 0.55; sl.img(M, y, iw, avail(), img); cardsBlockColumn(sl, M + iw + 16, y, CW - iw - 16, avail(), p.cards, where); }
      else sl.img(M, y, CW, avail(), img);
    } else if (p.cards.length) {
      cardsBlock(sl, M, y, CW, avail(), p.cards, where);
    } else if (text.length && !p.flow) {
      textBlock(sl, M, y, CW, avail(), text, 28, 16, where);
    }
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
 * @returns {Promise<{slides:number, pptx:string, html:string, pdf:string|null, warnings:string[]}>}
 */
async function renderDeck({ input, outDir, name, theme, accent, pdf = true, png = false }) {
  warnings.length = 0;
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
  return { slides: slides.length, pptx: pptxPath, html: htmlPath, pdf: pdfPath, warnings: [...warnings] };
}

// Только синтаксис/раскладка, без файлов — быстрая проверка «влезает ли текст».
function checkDeck(src) {
  warnings.length = 0;
  const { meta, body } = parseFront(src);
  meta._dir = process.cwd();
  const slides = build(splitSlides(body).map(parseSlide), meta);
  return { slides: slides.length, warnings: [...warnings] };
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
  });
  const report = JSON.stringify(result, null, 2);
  const reportFile = opt('report');
  if (reportFile) { fs.mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true }); fs.writeFileSync(reportFile, report + '\n'); }
  console.log(report);
  if (args.includes('--strict') && result.warnings.length) process.exit(2);
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { parseSlide, splitSlides, build, renderDeck, checkDeck };
