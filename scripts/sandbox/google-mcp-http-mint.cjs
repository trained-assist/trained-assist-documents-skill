'use strict';

const { mintBinding } = require('./google-mcp-http.cjs');
try {
  const args = process.argv.slice(2);
  const names = ['--runtime', '--user-task-id', '--actor-profile', '--credential-profile', '--run-id', '--expires-at'];
  if (args.length !== 12 || names.some((name, index) => args[index * 2] !== name)) throw new Error();
  const metadata = mintBinding({ runtime: args[1], userTaskId: args[3], expectedActorProfile: args[5],
    credentialProfile: args[7], runId: args[9], expiresAt: args[11] });
  process.stdout.write(JSON.stringify(metadata) + '\n');
} catch {
  process.stderr.write('Scoped HTTP binding mint failed; inspect private metadata before retry.\n');
  process.exitCode = 1;
}
