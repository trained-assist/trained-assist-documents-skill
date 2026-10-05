'use strict';

const fs = require('fs');
const path = require('path');
const { privatePath } = require('../google-mcp-host.cjs');
const original = require('../../../src/mcp-skills/tools/50-gdrive');
const names = ['gdrive_create_spreadsheet', 'gdrive_read_sheet', 'gdrive_write_sheet'];
const errorCodes = new Set(['SHEETS_API_ERROR', 'SHEETS_FOLDER_UNAVAILABLE', 'SHEETS_INVALID_INPUT',
  'SHEETS_OPERATION_CONFLICT', 'SHEETS_OUTCOME_UNKNOWN', 'SHEETS_SOURCE_PROTECTED',
  'SHEETS_TAB_NOT_FOUND', 'SHEETS_TARGET_EXISTS']);

function approvedTarget(name, args) {
  try {
    if (process.env.GOOGLE_MCP_PROBE_ONLY === '1' || !process.env.GOOGLE_MCP_RUNTIME) throw new Error();
    const targetPath = path.join(process.env.GOOGLE_MCP_RUNTIME, 'owner-target.json');
    privatePath(targetPath);
    const target = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    const actorProfile = process.env.GOOGLE_MCP_ACTOR_PROFILE;
    if (actorProfile && (actorProfile !== 'integration-v1' || process.env.USER_ID !== 'sandbox-integrator-google')) throw new Error();
    if (target.profile !== (actorProfile || 'sandbox-integrator-google') || target.ownerApproved !== true) throw new Error();
    if (process.env.GOOGLE_MCP_RUN_ID && target.runId !== process.env.GOOGLE_MCP_RUN_ID) throw new Error();
    if (process.env.GOOGLE_MCP_USER_TASK_ID && target.userTaskId !== process.env.GOOGLE_MCP_USER_TASK_ID) throw new Error();
    if (process.env.GOOGLE_MCP_RUN_ID) {
      const { readBinding, ownerTargetDigest } = require('../google-mcp-http.cjs');
      const binding = readBinding(process.env.GOOGLE_MCP_RUNTIME);
      if (binding.runId !== process.env.GOOGLE_MCP_RUN_ID || binding.userTaskId !== process.env.GOOGLE_MCP_USER_TASK_ID ||
          binding.profile !== actorProfile || binding.ownerTargetDigest !== ownerTargetDigest(binding, target)) throw new Error();
    }
    if (name === 'gdrive_create_spreadsheet') {
      if (!target.folderId || args.folder_id !== target.folderId) return 'TARGET_NOT_APPROVED';
    } else if (!target.spreadsheetId || args.spreadsheet_id !== target.spreadsheetId) {
      return 'TARGET_NOT_APPROVED';
    }
    return null;
  } catch { return 'OWNER_TARGET_REQUIRED'; }
}

module.exports = {
  isReady: original.isReady,
  tools: Object.fromEntries(names.map(name => [name, {
    ...original.tools[name],
    handler: async args => {
      const refusal = approvedTarget(name, args);
      if (refusal) throw new Error(refusal);
      try { return await original.tools[name].handler(args); }
      catch (error) {
        const code = errorCodes.has(error.code) ? error.code : 'GOOGLE_TOOL_FAILED';
        throw new Error(code);
      }
    },
  }])),
  approvedTarget,
};
