'use strict';

const fs = require('fs');
const path = require('path');

const toolsDir = process.env.TOOLS_DIR || path.join(__dirname, 'tools');
const handlers = {};
const defs = [];
// Every declared tool regardless of isReady(): core's headless transport and cron
// gate tool names on this static catalog (the shared server process has no USER_ID,
// so listTools() alone would hide ready-gated tools — trained-assist-agent#1530).
const allDefs = [];
// Profile skills (trained-assist-agent #1537): core writes the resolved plan and passes
// SKILLS_RESOLVED; modules of switched-off catalog sections are listed there as
// 'documents-skills/<file>' and are not registered. Unset/unreadable → nothing hidden.
const SERVER_ID = 'documents-skills';
function hiddenModules(file) {
  if (!file) return new Set();
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8')).hidden || {};
    return new Set((Array.isArray(h.modules) ? h.modules : []).filter(m => typeof m === 'string'));
  } catch (e) {
    console.error(`[skills] SKILLS_RESOLVED=${file}: ${e.message} — no filter`);
    return new Set();
  }
}
const hidden = hiddenModules(process.env.SKILLS_RESOLVED);

// Auto-discover all tool files in tools/
// Each module may export:
//   isReady()    — returns bool; if false, only setupTools are registered (default: true)
//   setupTools   — tool names always registered even when !isReady (for configure/status tools)
for (const file of fs.readdirSync(toolsDir).filter(f => f.endsWith('.js')).sort()) {
  const mod = require(path.join(toolsDir, file));
  const ready = typeof mod.isReady === 'function' ? mod.isReady() : true;
  const setupSet = new Set(mod.setupTools || []);

  const off = hidden.has(`${SERVER_ID}/${file}`);
  for (const [name, tool] of Object.entries(mod.tools || {})) {
    const def = { name, description: tool.description, inputSchema: tool.inputSchema || { type: 'object', properties: {} } };
    if (!allDefs.some(d => d.name === name)) allDefs.push(def);
    if (off) continue;
    if (!ready && !setupSet.has(name)) continue;
    if (handlers[name]) {
      console.error(`[registry] duplicate tool name: ${name} in ${file}`);
      continue;
    }
    handlers[name] = tool.handler;
    defs.push(def);
  }
}

module.exports = {
  listTools: () => defs,
  listAllTools: () => allDefs,
  callTool: (name, args) => {
    const fn = handlers[name];
    if (!fn) throw new Error(`Unknown tool: ${name}`);
    const ctx = { userId: process.env.USER_ID };
    return fn(args, ctx);
  },
};
