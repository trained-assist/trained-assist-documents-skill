'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');
const fixture = require('../fixtures/google-expenses-v1.json');

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && args[0] === '--print-fixture')) {
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
    return;
  }
  const mode = args.shift();
  if (!['--create', '--seed'].includes(mode) || args.length % 2) throw new Error('Use --print-fixture or --create/--seed with explicit isolated binding options');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--profile', '--tokens-dir', '--confirm-isolated-binding', '--folder-id', '--spreadsheet-id'].includes(key) || options[key] !== undefined) {
      throw new Error('Unknown or duplicate fixture option');
    }
    options[key] = args[index + 1];
  }
  const profile = options['--profile'];
  const tokensDir = options['--tokens-dir'];
  if (!/^sandbox-[a-z0-9_-]+$/.test(profile || '') || !tokensDir || !path.isAbsolute(tokensDir) ||
      options['--confirm-isolated-binding'] !== profile || !process.env.CRED_ENCRYPTION_KEY) {
    throw new Error('Live fixture requires a sandbox-* profile, absolute dedicated --tokens-dir, matching --confirm-isolated-binding and host CRED_ENCRYPTION_KEY');
  }
  const root = fs.realpathSync(tokensDir);
  if (root !== path.resolve(tokensDir) || fs.lstatSync(path.join(root, profile)).isSymbolicLink() ||
      fs.lstatSync(path.join(root, profile, 'gdrive')).isSymbolicLink()) {
    throw new Error('Fixture credential binding must use a dedicated real directory and nonsymlink profile/key');
  }
  if ((mode === '--create' && (!options['--folder-id'] || options['--spreadsheet-id'])) ||
      (mode === '--seed' && (!options['--spreadsheet-id'] || options['--folder-id']))) {
    throw new Error('--create requires only --folder-id; --seed requires only --spreadsheet-id');
  }
  process.env.USER_ID = profile;
  process.env.AGENT_TOKENS_DIR = root;
  const credentialStore = require('../../src/credential-store');
  if (!credentialStore.hasMasterKey()) throw new Error('Fixture requires a valid host encryption key');
  const keyFile = path.join(root, profile, 'gdrive');
  if (!credentialStore.isEncrypted(fs.readFileSync(keyFile, 'utf8'))) throw new Error('Fixture requires an encrypted isolated service-account binding');
  const { tools, isReady } = require('../../src/mcp-skills/tools/50-gdrive');
  if (!isReady()) throw new Error('Isolated service-account binding is unavailable');
  let spreadsheetId = options['--spreadsheet-id'];
  if (mode === '--create') {
    const created = await tools.gdrive_create_spreadsheet.handler({ title: 'Integrator Google expenses v1', folder_id: options['--folder-id'] });
    spreadsheetId = created.spreadsheet_id;
    process.stdout.write(`${JSON.stringify({ event: 'spreadsheet_created', spreadsheet_id: spreadsheetId })}\n`);
  }
  await tools.gdrive_write_sheet.handler({
    spreadsheet_id: spreadsheetId, sheet_name: fixture.source_sheet_name, rows: fixture.rows,
    operationId: 'google-expenses-v1:source',
  });
  const readback = await tools.gdrive_read_sheet.handler({ spreadsheet_id: spreadsheetId, sheet_name: fixture.source_sheet_name, range: 'A1:D9' });
  assert.deepEqual(readback.values, fixture.rows);
  process.stdout.write(`${JSON.stringify({ event: 'fixture_verified', spreadsheet_id: spreadsheetId, ...fixture })}\n`);
}

main().catch(() => {
  process.stderr.write('Fixture preparation failed. Check isolated binding, Shared Drive access and outcome before retrying creation; use --seed for a known spreadsheet ID.\n');
  process.exitCode = 1;
});
