'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function privatePath(filePath, directory = false) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
      (process.getuid && stat.uid !== process.getuid())) throw new Error('UNSAFE_RUNTIME_BINDING');
}

function childEnvironment(runtimePath, probe) {
  if (!path.isAbsolute(runtimePath)) throw new Error('UNSAFE_RUNTIME_BINDING');
  privatePath(runtimePath, true);
  const runtime = fs.realpathSync(runtimePath);
  for (const directory of ['home', 'work', 'tokens', 'tokens/sandbox-integrator-google']) {
    privatePath(path.join(runtime, directory), true);
  }
  const keyPath = path.join(runtime, '.host-encryption-key');
  const credentialPath = path.join(runtime, 'tokens/sandbox-integrator-google/gdrive');
  privatePath(keyPath);
  privatePath(credentialPath);
  const key = fs.readFileSync(keyPath, 'utf8').trim();
  const blob = fs.readFileSync(credentialPath, 'utf8').trim();
  const envelope = Buffer.from(blob, 'base64');
  if (!/^[a-f0-9]{64}$/i.test(key) || envelope.length < 33 || envelope[0] !== 2 ||
      envelope.toString('base64') !== blob) throw new Error('UNSAFE_RUNTIME_BINDING');
  return {
    PATH: path.dirname(process.execPath) + ':/usr/bin:/bin',
    HOME: path.join(runtime, 'home'),
    USER_ID: 'sandbox-integrator-google',
    AGENT_TOKENS_DIR: path.join(runtime, 'tokens'),
    AGENT_DATA_DIR: path.join(runtime, 'work'),
    USERS_DIR: path.join(runtime, 'work'),
    TOOLS_DIR: path.join(__dirname, 'google-mcp-tools'),
    GOOGLE_MCP_RUNTIME: runtime,
    GOOGLE_MCP_PROBE_ONLY: probe ? '1' : '0',
    CRED_ENCRYPTION_KEY: key,
  };
}

function spawnDomain(env, probe = false) {
  const childArgs = [path.join(__dirname, '../../src/mcp-skills/index.js')];
  if (probe) childArgs.unshift('--require', path.join(__dirname, 'google-mcp-probe-guard.cjs'));
  return spawn(process.execPath, childArgs, {
    cwd: env.AGENT_DATA_DIR, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
}

async function main(args) {
  if (args.length !== 3 || args[0] !== '--runtime' || !['--probe', '--serve'].includes(args[2])) {
    throw new Error('INVALID_HOST_ARGUMENTS');
  }
  const probe = args[2] === '--probe';
  const env = childEnvironment(args[1], probe);
  const child = spawnDomain(env, probe);
  let networkGuardActive = false;
  let blockedNetworkAttempts = 0;
  child.on('message', message => {
    if (message?.networkGuardActive === true) networkGuardActive = true;
    if (message?.blockedNetworkAttempt === true) blockedNetworkAttempts++;
  });
  let transportError = false;
  child.stderr.on('data', () => { transportError = true; });
  if (!probe) {
    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  }
  let output = '';
  let timer;
  if (probe) {
    timer = setTimeout(() => child.kill(), 10000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stdin.end([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gdrive_read_sheet', arguments: {} } },
    ].map(request => JSON.stringify(request)).join('\n') + '\n');
  }
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  }).finally(() => clearTimeout(timer));
  if (code !== 0 || transportError) throw new Error('MCP_HOST_FAILED');
  if (!probe) return;
  const responses = output.trim().split('\n').map(line => JSON.parse(line));
  const tools = responses.find(response => response.id === 2)?.result?.tools?.map(tool => tool.name).sort();
  const expected = ['gdrive_create_spreadsheet', 'gdrive_read_sheet', 'gdrive_write_sheet'];
  if (JSON.stringify(tools) !== JSON.stringify(expected) ||
      responses.find(response => response.id === 3)?.error?.message !== 'OWNER_TARGET_REQUIRED' ||
      !responses.find(response => response.id === 1)?.result?.serverInfo ||
      !networkGuardActive || blockedNetworkAttempts !== 0) throw new Error('MCP_PROBE_FAILED');
  process.stdout.write(JSON.stringify({ realStdioMcp: true, toolNames: tools, ownerTargetGateVerified: true,
    liveGoogleArtifactCalls: 0, networkGuardActive, blockedNetworkAttempts, inheritedEnvironment: false }) + '\n');
}

module.exports = { privatePath, childEnvironment, spawnDomain, main };
if (require.main === module) main(process.argv.slice(2)).catch(() => {
  process.stderr.write('Isolated Google MCP host failed; check private binding and owner approval.\n');
  process.exitCode = 1;
});
