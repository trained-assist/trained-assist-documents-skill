'use strict';

// Markdown → HTML + PDF + DOCX with a checked print layout (moved from core's
// ba_export_client_doc). The DOCX and the PDF come from one pandoc HTML source so
// they don't drift; the PDF is printed by Chromium with explicit header/footer
// templates (no doubled title, no file:// path in the footer); tables never break
// mid-page, and tables with long cell text switch to a "label + bullets" block layout.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { withChromium } = require('../render/chromium');

const execFileAsync = promisify(execFile);

function slugify(slug) {
  return String(slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'doc';
}

function footerTemplate(signature) {
  const pageNo = '<span><span class="pageNumber"></span>/<span class="totalPages"></span></span>';
  const style = 'width:100%;font-size:8px;color:#666;padding:0 1.3cm;display:flex;font-family:Arial,sans-serif;';
  return signature
    ? `<div style="${style}justify-content:space-between;"><span>${escapeHtml(signature)}</span>${pageNo}</div>`
    : `<div style="${style}justify-content:flex-end;">${pageNo}</div>`;
}

/**
 * @returns {Promise<{html_path:string, pdf_path:string, docx_path:string}>}
 */
async function exportMarkdownDocument({ markdown, title, slug, outDir, footerSignature = '', wideTableCharThreshold = 45 }) {
  const name = slugify(slug);
  fs.mkdirSync(outDir, { recursive: true });
  const mdPath   = path.join(outDir, `${name}.md`);
  const htmlPath = path.join(outDir, `${name}.html`);
  const pdfPath  = path.join(outDir, `${name}.pdf`);
  const docxPath = path.join(outDir, `${name}.docx`);
  fs.writeFileSync(mdPath, transformWideTables(markdown, wideTableCharThreshold), 'utf8');

  const cssPath = path.join(outDir, `.${name}-style.css.tmp`);
  fs.writeFileSync(cssPath, `<style>${DOC_CSS}</style>`, 'utf8');
  try {
    try {
      await execFileAsync('pandoc', [mdPath, '-s', '--metadata', `title=${title}`, '--include-in-header', cssPath, '-o', htmlPath]);
    } catch (e) {
      throw new Error(`pandoc (markdown→html) failed — проверь что pandoc установлен: ${e.message}`);
    }
    try {
      await execFileAsync('pandoc', [mdPath, '-s', '--metadata', `title=${title}`, '-o', docxPath]);
    } catch (e) {
      throw new Error(`pandoc (markdown→docx) failed: ${e.message}`);
    }
  } finally {
    fs.rmSync(cssPath, { force: true });
  }

  try {
    await withChromium(async (browser) => {
      const page = await browser.newPage();
      await page.goto(`file://${path.resolve(htmlPath)}`, { waitUntil: 'networkidle' });
      await page.pdf({
        path: pdfPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '1.4cm', bottom: '1.6cm', left: '1.3cm', right: '1.3cm' },
        displayHeaderFooter: true,
        headerTemplate: '<span></span>', // empty — suppresses Chrome's default date/title header
        footerTemplate: footerTemplate(footerSignature),
      });
    });
  } catch (e) {
    throw new Error(`Chromium PDF render failed: ${e.message}`);
  }

  return { html_path: htmlPath, pdf_path: pdfPath, docx_path: docxPath };
}

// ── Markdown table → block layout (for wide-cell tables) ────────────────────
// A table where any data cell exceeds the threshold becomes unreadable as narrow
// columns (e.g. 5-column assumption tables). Convert it into one card per row:
// header cells become bold labels, so it reads as a block instead of a strip.
function transformWideTables(markdown, threshold) {
  const lines = markdown.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isTableStart = /^\s*\|.*\|\s*$/.test(line) &&
      lines[i + 1] && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-');
    if (!isTableStart) { out.push(line); i++; continue; }

    const headerCells = splitRow(line);
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]); j++) {
      rows.push(splitRow(lines[j]));
    }
    const maxLen = Math.max(0, ...rows.flat().map(c => c.length));

    if (maxLen <= threshold) {
      // Keep as a normal table — it's narrow enough to read.
      out.push(...lines.slice(i, j));
    } else {
      for (const row of rows) {
        out.push('<div class="spec-block">');
        out.push('<ul>');
        for (let c = 0; c < headerCells.length; c++) {
          if (row[c] === undefined || row[c] === '') continue;
          out.push(`<li><em>${escapeHtml(headerCells[c])}:</em> ${escapeHtml(row[c])}</li>`);
        }
        out.push('</ul>');
        out.push('</div>');
        out.push('');
      }
    }
    i = j;
  }
  return out.join('\n');
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const DOC_CSS = `
/* pandoc -s injects its own "#title-block-header > h1.title" from --metadata title=
   on top of whatever H1 the markdown source already has — a second, pandoc-only
   doubled title distinct from the Chrome print-header one (which page.pdf's empty
   headerTemplate already suppresses). The <title> tag itself is kept for the PDF/tab
   title; only the visible duplicate heading in the body is hidden. */
#title-block-header{display:none}
body{font-family:"Helvetica Neue",Arial,"PT Sans",sans-serif;color:#1a1a1a;line-height:1.5;max-width:880px;margin:0 auto;padding:2em 1.5em;font-size:15px}
h1,h2,h3{page-break-after:avoid;break-after:avoid-page}
h2{margin-top:1.6em;border-bottom:2px solid #2a5b8c;padding-bottom:.2em}
h3{margin-top:1.3em;color:#2a5b8c}
table{border-collapse:collapse;width:100%;margin:.8em 0;page-break-inside:avoid;break-inside:avoid;font-size:.95em}
th,td{border:1px solid #cdd6df;padding:.4em .7em;text-align:left;vertical-align:top}
th{background:#eef3f8}
tr:nth-child(even){background:#fbfcfd}
.spec-block{page-break-inside:avoid;break-inside:avoid;border:1px solid #dde4ea;border-left:4px solid #2a5b8c;border-radius:4px;padding:.7em 1em;margin:.9em 0;background:#f8fafc}
.spec-block ul{margin:.2em 0 0 0}
.spec-block li{margin:.25em 0;font-size:.94em}
.spec-block em{font-style:normal;color:#2a5b8c;font-weight:600}
@media print{body{max-width:100%;padding:0 .3cm;font-size:12.5px}.spec-block,table,h2,h3{page-break-inside:avoid;break-inside:avoid}}
`;

module.exports = { exportMarkdownDocument, transformWideTables, slugify };
