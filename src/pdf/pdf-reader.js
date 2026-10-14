'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 50;
const MAX_TEXT = 250_000;
async function safePath(file) {
  if (typeof file !== 'string' || !file.trim() || file.includes('\0')) throw new Error('path required');
  const root = await fs.realpath(process.env.PDF_READ_ROOT || process.env.WORK_DIR || process.cwd());
  const target = await fs.realpath(path.resolve(root, file));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('path outside allowed root');
  const s = await fs.stat(target);
  if (!s.isFile() || s.size > MAX_BYTES) throw new Error('not a regular PDF or exceeds 25 MiB');
  const fh = await fs.open(target, 'r');
  try {
    const b = Buffer.alloc(1024);
    const n = await fh.read(b, 0, b.length, 0);
    if (!b.subarray(0, n.bytesRead).includes(Buffer.from('%PDF-'))) throw new Error('not a PDF');
  } finally { await fh.close(); }
  return target;
}
async function call(command, args) {
  try { return (await exec(command, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' })).stdout; }
  catch (e) {
    if (e.code === 'ENOENT') throw new Error('Missing ' + command + ': install poppler-utils');
    throw new Error(command + ' failed: ' + String(e.stderr || e.message).slice(0, 250));
  }
}
async function readPdf({ path: file, start_page = 1, end_page, max_pages = MAX_PAGES } = {}) {
  const source = await safePath(file);
  const info = await call('pdfinfo', [source]);
  const found = /^Pages:\s*(\d+)\s*$/m.exec(info);
  if (!found) throw new Error('Cannot read PDF page count');
  const page_count = Number(found[1]);
  for (const [k, v] of Object.entries({ start_page, end_page, max_pages })) {
    if (v !== undefined && (!Number.isSafeInteger(v) || v < 1)) throw new Error(k + ' must be positive integer');
  }
  if (max_pages > MAX_PAGES || start_page > page_count || (end_page !== undefined && (end_page < start_page || end_page > page_count))) throw new Error('Invalid page range');
  const requestedEnd = end_page ?? page_count;
  const last = Math.min(requestedEnd, start_page + max_pages - 1);
  const pages = [];
  let size = 0, clipped = false;
  for (let p = start_page; p <= last; p++) {
    const raw = await call('pdftotext', ['-f', String(p), '-l', String(p), '-enc', 'UTF-8', source, '-']);
    const normalized = raw.replace(/\f+$/, '').trim();
    const remaining = MAX_TEXT - size;
    if (normalized.length > remaining) {
      pages.push({ page: p, text: normalized.slice(0, remaining) });
      clipped = true;
      break;
    }
    pages.push({ page: p, text: normalized });
    size += normalized.length;
  }
  const hasText = pages.some(p => p.text.length);
  const partial = clipped || last < requestedEnd;
  const warnings = [];
  if (!hasText) warnings.push('No selectable text on selected pages; OCR may be required');
  if (partial) warnings.push('Page or text extraction limit reached');
  return { status: !hasText ? 'needs_ocr' : partial ? 'partial' : 'ok',
    source, page_count, pages, text: pages.map(p => p.text).join('\n\n'),
    warnings, extraction: { engine: 'poppler', ocr_used: false } };
}
module.exports = { readPdf };
