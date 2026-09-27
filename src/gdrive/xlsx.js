'use strict';

// Minimal xlsx reading without dependencies — used by the gdrive tools to read
// uploaded Excel files and in-cell hyperlinks of public Google Sheets exports.

const zlib = require('zlib');

// Minimal ZIP central-directory reader — enough for xlsx, no external deps.
function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let n = 0; n < count && buf.readUInt32LE(off) === 0x02014b50; n++) {
    const method   = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen  = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commLen  = buf.readUInt16LE(off + 32);
    const lho      = buf.readUInt32LE(off + 42);
    const name     = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries[name] = () => (method === 0 ? raw : zlib.inflateRawSync(raw));
    off += 46 + nameLen + extraLen + commLen;
  }
  return entries;
}

// Extract in-cell hyperlinks from an xlsx buffer → [{ sheet, cell, url }].
function extractXlsxHyperlinks(buf) {
  const entries = readZipEntries(buf);
  const out = [];
  for (const p of Object.keys(entries)) {
    const m = p.match(/^xl\/worksheets\/(sheet\d+)\.xml$/);
    if (!m) continue;
    const sheet = m[1];
    const xml = entries[p]().toString('utf8');
    const rels = {};
    const relsFile = entries[`xl/worksheets/_rels/${sheet}.xml.rels`];
    if (relsFile) {
      for (const r of relsFile().toString('utf8').matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
        rels[r[1]] = r[2];
      }
    }
    // Attribute order varies (r:id may precede ref) — parse each tag order-agnostically.
    for (const h of xml.matchAll(/<hyperlink\b[^>]*\/?>/g)) {
      const tag = h[0];
      const rid = (tag.match(/r:id="([^"]+)"/) || [])[1];
      const ref = (tag.match(/\bref="([^"]+)"/) || [])[1] || null;
      if (rid && rels[rid]) out.push({ sheet, cell: ref, url: rels[rid] });
    }
  }
  return out;
}

// Decode XML entities in cell text.
function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// Convert column letters (A, B, AA, …) to 1-based number.
function colLetterToNum(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + letters.charCodeAt(i) - 64;
  return n;
}

// Parse an xlsx Buffer → multi-sheet CSV text (no external deps, uses readZipEntries).
function parseXlsxToText(buf) {
  let entries;
  try { entries = readZipEntries(buf); } catch (e) { return `Ошибка чтения xlsx: ${e.message}`; }

  // Shared strings table
  const ss = [];
  if (entries['xl/sharedStrings.xml']) {
    const xml = entries['xl/sharedStrings.xml']().toString('utf8');
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const parts = [...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map(t => decodeXmlEntities(t[1]));
      ss.push(parts.join(''));
    }
  }

  // Sheet names (workbook.xml + rels)
  const sheetNames = {}, rIdToNum = {};
  if (entries['xl/workbook.xml']) {
    const xml = entries['xl/workbook.xml']().toString('utf8');
    for (const m of xml.matchAll(/<sheet\b[^>]+\bname="([^"]+)"[^>]+\br:id="([^"]+)"/g)) sheetNames[m[2]] = m[1];
  }
  if (entries['xl/_rels/workbook.xml.rels']) {
    const xml = entries['xl/_rels/workbook.xml.rels']().toString('utf8');
    for (const m of xml.matchAll(/Id="([^"]+)"[^>]*Target="worksheets\/(sheet\d+)\.xml"/g)) rIdToNum[m[1]] = m[2];
  }

  const sections = [];
  for (let idx = 1; entries[`xl/worksheets/sheet${idx}.xml`]; idx++) {
    const xml = entries[`xl/worksheets/sheet${idx}.xml`]().toString('utf8');
    const rId = Object.keys(rIdToNum).find(k => rIdToNum[k] === `sheet${idx}`);
    const name = (rId && sheetNames[rId]) || `Sheet${idx}`;

    const rowsMap = new Map();
    let maxCol = 0;

    for (const rm of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const rowNum = parseInt(rm[1]);
      const cells = new Map();
      for (const cm of rm[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cm[1], inner = cm[2];
        const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
        if (!ref) continue;
        const col = colLetterToNum(ref.replace(/\d+/g, ''));
        maxCol = Math.max(maxCol, col);
        const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
        const vMatch = inner.match(/<v>([^<]*)<\/v>/);
        let value = '';
        if (type === 's' && vMatch) value = ss[parseInt(vMatch[1])] ?? '';
        else if (type === 'inlineStr') { const t = inner.match(/<t[^>]*>([^<]*)<\/t>/); value = t ? decodeXmlEntities(t[1]) : ''; }
        else if (type === 'b' && vMatch) value = vMatch[1] === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'e') value = vMatch ? vMatch[1] : '#ERR';
        else if (vMatch) value = type === 'str' ? decodeXmlEntities(vMatch[1]) : vMatch[1];
        cells.set(col, value);
      }
      if (cells.size > 0) rowsMap.set(rowNum, cells);
    }

    if (rowsMap.size > 0) {
      const maxRow = Math.max(...rowsMap.keys());
      const lines = [];
      for (let r = 1; r <= maxRow; r++) {
        const c = rowsMap.get(r) || new Map();
        const row = [];
        for (let ci = 1; ci <= maxCol; ci++) {
          const v = c.get(ci) || '';
          row.push(v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v.replace(/"/g, '""')}"` : v);
        }
        lines.push(row.join(','));
      }
      sections.push(`=== ${name} ===\n${lines.join('\n')}`);
    }
  }
  return sections.length ? sections.join('\n\n') : '(пустой файл)';
}

module.exports = { readZipEntries, extractXlsxHyperlinks, decodeXmlEntities, colLetterToNum, parseXlsxToText };
