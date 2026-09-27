// Мини-движок: слайды описываются примитивами в pt (960×540),
// один и тот же список рендерится в .pptx (pptxgenjs) и в HTML → PDF.
const THEMES = {
  dark: {
  bg: '0B1C24', panel: '0F2733', panel2: '12303D', border: '2B4755',
  text: 'FFFFFF', muted: 'B7C7CE', dim: '8FA3AC', codeBg: '07141A',
  green: '2FD07A', red: 'FF6B6B', orange: 'FFB547', blue: '6AA9FF', teal: '2BC4B0',
  greenBg: '0F3A2A', redBg: '3A1C22', orangeBg: '3A2E17', blueBg: '172A45',
  },
  light: {
  bg: 'FFFFFF', panel: 'F3F5F7', panel2: 'E9EDF1', border: 'D0D7DE',
  text: '14202A', muted: '46535E', dim: '7A8791', codeBg: '0F1B22',
  green: '12A150', red: 'D93F3F', orange: 'C77700', blue: '2F6FDB', teal: '0E9384',
  greenBg: 'E6F6EC', redBg: 'FCEBEB', orangeBg: 'FDF3E1', blueBg: 'E8F0FD',
  },
};
const C = { ...THEMES.dark };
function setTheme(name, over = {}) { Object.assign(C, THEMES[name] || THEMES.dark, over); }
const SANS = 'Helvetica';
const MONO = 'Menlo';

class Slide {
  constructor() { this.items = []; this.notes = ''; }
  box(x, y, w, h, o = {}) { this.items.push({ k: 'box', x, y, w, h, o }); return this; }
  txt(x, y, w, h, runs, o = {}) { this.items.push({ k: 'txt', x, y, w, h, runs: norm(runs, o), o }); return this; }
  line(x1, y1, x2, y2, o = {}) { this.items.push({ k: 'line', x1, y1, x2, y2, o }); return this; }
  img(x, y, w, h, path) { this.items.push({ k: 'img', x, y, w, h, path }); return this; }
  table(x, y, w, rows, o = {}) { this.items.push({ k: 'table', x, y, w, rows, o }); return this; }
}
// runs: строка или массив {t, color, bold, italic}; '\n' внутри t — перенос строки
function norm(runs) {
  if (typeof runs === 'string') runs = [{ t: runs }];
  return runs;
}

// ---------- Python / YAML подсветка ----------
const KW = new Set('def class async await return if elif else for while in not and or is None True False raise try except with as import from match case break continue lambda yield pass'.split(' '));
const PC = { kw: 'C792EA', str: 'C3E88D', num: 'F78C6C', com: '7F95A0', fn: '82AAFF', dec: 'FFCB6B', def: 'E6EDF3', key: '82AAFF' };
function highlight(src, lang = 'py') {
  const runs = [];
  const lines = src.replace(/^\n/, '').replace(/\s+$/, '').split('\n');
  lines.forEach((ln, i) => {
    const re = lang === 'yaml'
      ? /(#.*$)|("[^"]*"|'[^']*')|(^\s*[\w_]+(?=:))|(\b\d[\d_]*\b)|(\s+)|([^\s"'#\d]+|.)/g
      : /(#.*$)|([rf]?"[^"]*"|[rf]?'[^']*')|(@[\w.]+)|(\b\d[\d_]*\b)|([A-Za-z_][\w]*)(?=\()|([A-Za-z_]\w*)|(\s+)|(.)/g;
    let m;
    while ((m = re.exec(ln)) !== null) {
      let color = PC.def, t = m[0];
      if (lang === 'yaml') {
        if (m[1]) color = PC.com; else if (m[2]) color = PC.str; else if (m[3]) color = PC.key; else if (m[4]) color = PC.num;
      } else {
        if (m[1]) color = PC.com; else if (m[2]) color = PC.str; else if (m[3]) color = PC.dec; else if (m[4]) color = PC.num;
        else if (m[5]) color = KW.has(t) ? PC.kw : PC.fn; else if (m[6]) color = KW.has(t) ? PC.kw : PC.def;
      }
      runs.push({ t, color, italic: color === PC.com });
    }
    if (i < lines.length - 1) runs.push({ t: '\n' });
  });
  return runs;
}

// ---------- PPTX ----------
function toPptx(slides, file, meta = {}) {
  const P = require('pptxgenjs');
  const p = new P();
  p.layout = 'LAYOUT_WIDE'; // 13.333 × 7.5 in = 960 × 540 pt
  p.author = meta.author || '';
  p.title = meta.title || '';
  const I = v => v / 72;
  for (const s of slides) {
    const ps = p.addSlide();
    ps.background = { color: C.bg };
    for (const it of s.items) {
      if (it.k === 'box') {
        const o = it.o;
        ps.addShape(o.r ? p.ShapeType.roundRect : p.ShapeType.rect, {
          x: I(it.x), y: I(it.y), w: I(it.w), h: I(it.h),
          fill: o.fill ? { color: o.fill } : { type: 'none' },
          line: o.line ? { color: o.line, width: o.lw || 1, dashType: o.dash ? 'dash' : 'solid' } : { type: 'none' },
          rectRadius: o.r ? Math.min(0.5, o.r / Math.min(it.w, it.h)) : undefined,
        });
      } else if (it.k === 'line') {
        const o = it.o;
        ps.addShape(p.ShapeType.line, {
          x: I(Math.min(it.x1, it.x2)), y: I(Math.min(it.y1, it.y2)),
          w: I(Math.abs(it.x2 - it.x1)) || 0.001, h: I(Math.abs(it.y2 - it.y1)) || 0.001,
          line: { color: o.color || C.border, width: o.w || 1.5, endArrowType: o.arrow ? 'triangle' : undefined },
        });
      } else if (it.k === 'img') {
        ps.addImage({ path: it.path, x: I(it.x), y: I(it.y), w: I(it.w), h: I(it.h), sizing: { type: 'contain', w: I(it.w), h: I(it.h) } });
      } else if (it.k === 'table') {
        const o = it.o;
        const rows = it.rows.map((r, ri) => r.map(cell => ({ text: cell, options: {
          bold: ri === 0, color: ri === 0 ? C.text : C.muted, fill: { color: ri === 0 ? C.panel2 : (ri % 2 ? C.panel : C.bg) },
        } })));
        ps.addTable(rows, { x: I(it.x), y: I(it.y), w: I(it.w), fontSize: o.size || 16, fontFace: SANS,
          border: { type: 'solid', color: C.border, pt: 1 }, margin: 0.08, valign: 'middle' });
      } else {
        const o = it.o;
        // pptxgenjs: перенос строки задаётся breakLine у предыдущего рана
        const out = [];
        for (const r of it.runs) {
          const parts = r.t.split('\n');
          parts.forEach((part, j) => {
            if (j > 0) { if (out.length) out[out.length - 1].options.breakLine = true; else out.push({ text: '', options: { breakLine: true } }); }
            if (part !== '') out.push({ text: part, options: { color: r.color || o.color || C.text, bold: r.bold ?? o.bold ?? false, italic: !!r.italic, fontFace: r.mono || o.mono ? MONO : SANS } });
          });
        }
        ps.addText(out, {
          x: I(it.x), y: I(it.y), w: I(it.w), h: I(it.h), margin: 0,
          fontSize: o.size || 20, fontFace: o.mono ? MONO : SANS,
          align: o.align || 'left', valign: o.valign || 'top',
          lineSpacingMultiple: o.lh || (o.mono ? 1.1 : 1.0), fit: 'none', wrap: true,
        });
      }
    }
    if (s.notes) ps.addNotes(s.notes);
  }
  return p.writeFile({ fileName: file });
}

// ---------- HTML ----------
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function toHtml(slides) {
  const css = `@page{size:960pt 540pt;margin:0}*{box-sizing:border-box;margin:0;padding:0}
html,body{width:960pt;overflow:hidden;background:#${C.bg}}.s{position:relative;width:960pt;height:540pt;overflow:hidden;background:#${C.bg};page-break-after:always;font-family:Helvetica,Arial,'Liberation Sans',sans-serif}
.t{position:absolute;display:flex;flex-direction:column;white-space:pre-wrap;word-wrap:break-word}
.m{font-family:Menlo,'DejaVu Sans Mono',monospace}`;
  const body = slides.map(s => {
    const html = s.items.map(it => {
      if (it.k === 'box') {
        const o = it.o;
        return `<div style="position:absolute;left:${it.x}pt;top:${it.y}pt;width:${it.w}pt;height:${it.h}pt;background:${o.fill ? '#' + o.fill : 'transparent'};border:${o.line ? `${o.lw || 1}pt ${o.dash ? 'dashed' : 'solid'} #${o.line}` : 'none'};border-radius:${o.r || 0}pt"></div>`;
      }
      if (it.k === 'img') {
        return `<img src="file://${it.path}" style="position:absolute;left:${it.x}pt;top:${it.y}pt;width:${it.w}pt;height:${it.h}pt;object-fit:contain">`;
      }
      if (it.k === 'table') {
        const o = it.o, fs = o.size || 16;
        const trs = it.rows.map((r, ri) => `<tr>${r.map(c => `<td style="border:1pt solid #${C.border};padding:5.8pt;font-size:${fs}pt;vertical-align:middle;font-weight:${ri === 0 ? 700 : 400};color:#${ri === 0 ? C.text : C.muted};background:#${ri === 0 ? C.panel2 : (ri % 2 ? C.panel : C.bg)}">${esc(c)}</td>`).join('')}</tr>`).join('');
        return `<table style="position:absolute;left:${it.x}pt;top:${it.y}pt;width:${it.w}pt;border-collapse:collapse;line-height:1.15">${trs}</table>`;
      }
      if (it.k === 'line') {
        const o = it.o, dx = it.x2 - it.x1, dy = it.y2 - it.y1, len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx) * 180 / Math.PI;
        const w = o.w || 1.5, col = '#' + (o.color || C.border);
        const head = o.arrow ? `<div style="position:absolute;right:-1pt;top:${-4 + w / 2}pt;width:0;height:0;border-left:8pt solid ${col};border-top:4pt solid transparent;border-bottom:4pt solid transparent"></div>` : '';
        return `<div style="position:absolute;left:${it.x1}pt;top:${it.y1 - w / 2}pt;width:${len}pt;height:${w}pt;background:${col};transform-origin:0 50%;transform:rotate(${ang}deg)">${head}</div>`;
      }
      const o = it.o;
      const jc = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[o.valign || 'top'];
      const inner = it.runs.map(r => `<span${r.mono ? ' class="m"' : ''} style="color:#${r.color || o.color || C.text};font-weight:${(r.bold ?? o.bold) ? 700 : 400};${r.italic ? 'font-style:italic;' : ''}">${esc(r.t)}</span>`).join('');
      return `<div class="t${o.mono ? ' m' : ''}" style="left:${it.x}pt;top:${it.y}pt;width:${it.w}pt;height:${it.h}pt;justify-content:${jc};text-align:${o.align || 'left'};font-size:${o.size || 20}pt;line-height:${(o.lh || (o.mono ? 1.1 : 1.0)) * 1.2}"><div>${inner}</div></div>`;
    }).join('\n');
    return `<div class="s">${html}</div>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}

module.exports = { C, THEMES, setTheme, Slide, highlight, toPptx, toHtml };
