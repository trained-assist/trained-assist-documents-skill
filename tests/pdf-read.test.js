'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readPdf } = require('../src/pdf/pdf-reader');
const { tools } = require('../src/mcp-skills/tools/25-pdf-read');

function fixture(filename, text) {
  const clean = String(text).replace(/[()\\]/g, '\\$&');
  const stream = 'BT /F1 12 Tf 60 700 Td (' + clean + ') Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream',
  ];
  let pdf = '%PDF-1.4\n', offsets = [0];
  for (let i=0;i<objects.length;i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += (i+1)+' 0 obj\n'+objects[i]+'\nendobj\n';
  }
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10,'0')+' 00000 n \n';
  pdf += 'trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
  fs.writeFileSync(filename, pdf);
}
const popplerInstalled = ['pdfinfo','pdftotext'].every(command => spawnSync(command, ['-v'], {stdio:'ignore'}).status === 0 || spawnSync(command, ['-v'], {stdio:'ignore'}).status === 1);

test('MCP tool is registered with deterministic contract', () => {
  assert.equal(typeof tools.pdf_read.handler, 'function');
  assert.deepEqual(tools.pdf_read.inputSchema.required, ['path']);
});

test('extracts exact text of a generated PDF without a model', {skip: !popplerInstalled}, async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdf-read-'));
  const old = process.env.PDF_READ_ROOT;
  try {
    fixture(path.join(temp,'small file.pdf'), 'Microcapsules test fixture');
    process.env.PDF_READ_ROOT = temp;
    const result = await readPdf({path:'small file.pdf'});
    assert.equal(result.status, 'ok');
    assert.equal(result.page_count, 1);
    assert.match(result.pages[0].text, /Microcapsules test fixture/);
    await assert.rejects(readPdf({path:'../outside.pdf'}));
    await assert.rejects(readPdf({path:'small file.pdf',start_page:2}));
  } finally {
    if (old === undefined) delete process.env.PDF_READ_ROOT;
    else process.env.PDF_READ_ROOT = old;
    await fsp.rm(temp,{recursive:true,force:true});
  }
});

test('optional ACS article regression uses lawfully supplied PDF only', {skip: !process.env.ACS_PDF_FILE || !popplerInstalled}, async () => {
  const actual = path.resolve(process.env.ACS_PDF_FILE);
  const old = process.env.PDF_READ_ROOT;
  try {
    process.env.PDF_READ_ROOT = path.dirname(actual);
    const result = await readPdf({path:path.basename(actual),max_pages:10});
    assert.notEqual(result.status,'needs_ocr','ACS PDF requires OCR');
    assert.match(result.text,/microcapsules/i);
    assert.match(result.text,/palm oil/i);
  } finally {
    if (old === undefined) delete process.env.PDF_READ_ROOT;
    else process.env.PDF_READ_ROOT = old;
  }
});
