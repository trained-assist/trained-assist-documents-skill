'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { childEnvironment, privatePath } = require('./google-mcp-host.cjs');
const { expectedAccount } = require('./google-provider-verify-child.cjs');
const { spreadsheetId, operationId, sourceSheetId, rowsSha256 } = require('./google-sheet-prepare-child.cjs');

function privateJson(file) {
  privatePath(file);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    assert.ok(fs.fstatSync(descriptor).size <= 65536);
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } finally { fs.closeSync(descriptor); }
}

function keys(value, allowed) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.ok(Object.keys(value).every(key => allowed.includes(key)));
}

function checkedInspection(value) {
  keys(value, ['schemaVersion', 'spreadsheetId', 'exactAccountVerified', 'canEdit', 'sheets', 'seed']);
  assert.equal(value.schemaVersion, 'google-sheet-inspection-v1');
  assert.equal(value.spreadsheetId, spreadsheetId);
  assert.equal(value.exactAccountVerified, true);
  assert.equal(value.canEdit, true);
  assert.ok(Array.isArray(value.sheets) && value.sheets.length > 0 && value.sheets.length <= 50);
  for (const sheet of value.sheets) {
    keys(sheet, ['sheetId', 'title', 'rowCount', 'columnCount', 'blank']);
    assert.ok(Number.isSafeInteger(sheet.sheetId) && sheet.sheetId >= 0);
    assert.ok(typeof sheet.title === 'string' && sheet.title.length > 0 && sheet.title.length <= 100 && !/[\x00-\x1f\x7f]/.test(sheet.title));
    assert.ok(Number.isSafeInteger(sheet.rowCount) && sheet.rowCount > 0 && Number.isSafeInteger(sheet.columnCount) && sheet.columnCount > 0);
    assert.equal(typeof sheet.blank, 'boolean');
  }
  assert.equal(new Set(value.sheets.map(sheet => sheet.sheetId)).size, value.sheets.length);
  assert.equal(new Set(value.sheets.map(sheet => sheet.title)).size, value.sheets.length);
  if (value.seed !== null) {
    keys(value.seed, ['sheetId', 'rowsSha256', 'receiptVerified', 'rowsVerified']);
    assert.equal(value.seed.sheetId, sourceSheetId);
    assert.equal(value.seed.rowsSha256, rowsSha256);
    assert.equal(value.seed.receiptVerified, true);
    assert.equal(value.seed.rowsVerified, true);
  }
  return value;
}

function blankBaseline(observed, metadata) {
  assert.equal(observed.seed, null);
  assert.ok(observed.sheets.every(sheet => sheet.blank && sheet.title !== 'Expenses' && sheet.sheetId !== sourceSheetId));
  assert.ok(observed.sheets.some(sheet => sheet.sheetId === metadata.baselineSheetId && sheet.title === metadata.baselineSheetName));
  return [...observed.sheets].sort((first, second) => first.sheetId - second.sheetId);
}

function verifiedSource(observed, baseline) {
  assert.ok(observed.seed);
  const source = observed.sheets.find(sheet => sheet.sheetId === observed.seed.sheetId && sheet.title === 'Expenses');
  assert.ok(source && !source.blank);
  assert.deepEqual(observed.sheets.filter(sheet => sheet.sheetId !== source.sheetId).sort((first, second) => first.sheetId - second.sheetId), baseline);
  return { schemaVersion: 'google-sheet-source-v1', spreadsheetId, sourceSheetId: source.sheetId,
    sourceSheetName: source.title, sourceRange: 'A1:D1000' };
}

function writeJson(file, value, exclusive = false) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2));
    fs.fsyncSync(descriptor);
    if (exclusive) fs.linkSync(temporary, file);
    else fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(directory);
      assert.ok(stat.isDirectory() && (stat.mode & 0o777) === 0o700 && (!process.getuid || stat.uid === process.getuid()));
      fs.fsyncSync(directory);
    } finally { fs.closeSync(directory); }
  } finally {
    fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function main(args, dependencies = { childEnvironment, execFileSync }) {
  let report;
  let checkpointFile;
  let lockFile;
  let lock;
  let phase = 'configuration';
  try {
    assert.ok(args.length === 9 && ['preflight', 'seed', 'reconcile'].includes(args[0]));
    assert.deepEqual([args[1], args[3], args[5], args[7]], ['--runtime', '--metadata', '--checkpoint', '--source-out']);
    const [mode, , runtime, , metadataFile, , checkpoint, , sourceOut] = args;
    assert.ok([runtime, metadataFile, checkpoint, sourceOut].every(path.isAbsolute));
    assert.equal(new Set([metadataFile, checkpoint, sourceOut].map(file => path.resolve(file))).size, 3);
    privatePath(path.dirname(checkpoint), true);
    privatePath(path.dirname(sourceOut), true);
    const metadata = privateJson(metadataFile);
    keys(metadata, ['schemaVersion', 'spreadsheetId', 'expectedSaEmail', 'baselineSheetId', 'baselineSheetName']);
    assert.equal(metadata.schemaVersion, 'google-sheet-preparation-v1');
    assert.equal(metadata.spreadsheetId, spreadsheetId);
    assert.ok(expectedAccount(metadata.expectedSaEmail));
    assert.ok(Number.isSafeInteger(metadata.baselineSheetId) && metadata.baselineSheetId >= 0);
    assert.ok(typeof metadata.baselineSheetName === 'string' && metadata.baselineSheetName.trim()
      && metadata.baselineSheetName.length <= 100 && !/[\x00-\x1f\x7f]/.test(metadata.baselineSheetName));
    const env = dependencies.childEnvironment(runtime, false);
    const scope = { metadata, runtimeRefSha256: createHash('sha256').update(path.resolve(runtime)).digest('hex'), sourceOut };
    checkpointFile = checkpoint;
    lockFile = `${checkpoint}.lock`;
    lock = fs.openSync(lockFile, 'wx', 0o600);
    if (mode === 'preflight') {
      assert.ok(!fs.existsSync(sourceOut));
      const descriptor = fs.openSync(checkpoint, 'wx', 0o600);
      fs.closeSync(descriptor);
      report = { schemaVersion: 'google-sheet-preparation-checkpoint-v1', scope, operationId, rowsSha256,
        phase: 'preflight', verified: false, googleSheetsAcceptance: false };
      writeJson(checkpoint, report);
    } else {
      const previous = privateJson(checkpoint);
      assert.equal(previous.schemaVersion, 'google-sheet-preparation-checkpoint-v1');
      assert.deepEqual(previous.scope, scope);
      assert.equal(previous.operationId, operationId);
      assert.equal(previous.rowsSha256, rowsSha256);
      assert.equal(previous.googleSheetsAcceptance, false);
      assert.ok(Array.isArray(previous.baseline) && previous.baseline.length > 0);
      assert.ok(['preflight_passed', 'seed_attempted', 'seed_verified'].includes(previous.phase));
      if (mode === 'seed') assert.equal(previous.phase, 'preflight_passed');
      else assert.ok(['seed_attempted', 'seed_verified'].includes(previous.phase));
      report = previous;
    }
    phase = report.phase;
    const child = action => dependencies.execFileSync(process.execPath,
      [path.join(__dirname, 'google-sheet-prepare-child.cjs'), action, metadata.expectedSaEmail], {
        cwd: env.AGENT_DATA_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 65536, killSignal: 'SIGKILL',
      });
    const observe = () => checkedInspection(JSON.parse(child('inspect').toString()));
    if (mode === 'preflight') {
      report.baseline = blankBaseline(observe(), metadata);
      report.phase = 'preflight_passed';
      writeJson(checkpoint, report);
      return { passed: true, report };
    }
    if (mode === 'seed') {
      assert.ok(!fs.existsSync(sourceOut));
      assert.deepEqual(blankBaseline(observe(), metadata), report.baseline);
      phase = 'seed_attempted';
      report.phase = phase;
      writeJson(checkpoint, report);
      child('seed');
    }
    const source = verifiedSource(observe(), report.baseline);
    if (fs.existsSync(sourceOut)) assert.deepEqual(privateJson(sourceOut), source);
    else writeJson(sourceOut, source, true);
    Object.assign(report, { phase: 'seed_verified', verified: true, source });
    delete report.reason;
    writeJson(checkpoint, report);
    return { passed: true, report };
  } catch {
    if (report) {
      report.reason = `${phase}_failed_reconcile_same_seed_operation`;
      try { writeJson(checkpointFile, report); } catch {}
    }
    return { passed: false, report: report ?? { phase: 'configuration', reason: 'invalid_configuration',
      verified: false, googleSheetsAcceptance: false } };
  } finally {
    if (lock !== undefined) {
      try { fs.closeSync(lock); } catch {}
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }
}

module.exports = { main };
if (require.main === module) {
  const { passed, report } = main(process.argv.slice(2));
  process.stdout.write(JSON.stringify({ passed, phase: report.phase, reason: report.reason, spreadsheetId,
    sourceSheetId: report.source?.sourceSheetId, fixtureReadbackVerified: report.verified, googleSheetsAcceptance: false }) + '\n');
  if (!passed) process.exitCode = 1;
}
