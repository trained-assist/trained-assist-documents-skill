'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { childEnvironment } = require('./google-mcp-host.cjs');
const { expectedAccount, providerReport } = require('./google-provider-verify-child.cjs');

function main(args, dependencies = { childEnvironment, execFileSync }) {
  let expectedEmail;
  let phase = 'invalid_configuration';
  try {
    if (args.length !== 4 || args[0] !== '--runtime' || args[2] !== '--expected-sa-email'
      || !path.isAbsolute(args[1]) || !expectedAccount(args[3])) throw new Error('INVALID_ARGUMENTS');
    expectedEmail = args[3];
    phase = 'invalid_runtime_binding';
    const env = dependencies.childEnvironment(args[1], false);
    phase = 'provider_verification_failed';
    const output = dependencies.execFileSync(process.execPath,
      [path.join(__dirname, 'google-provider-verify-child.cjs'), expectedEmail], {
        cwd: env.AGENT_DATA_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 35000, maxBuffer: 65536, killSignal: 'SIGKILL',
      });
    const report = JSON.parse(output.toString());
    const endpoints = ['oauth_token', 'drive_about'];
    if (report.schemaVersion !== 'google-provider-verification-v1' || report.expectedSaEmail !== expectedEmail
      || typeof report.passed !== 'boolean' || report.exactAccountVerified !== report.passed
      || report.providerOnly !== true || report.realGoogleArtifactCalls !== 0
      || report.credentialsForwardedToEngine !== false || report.credentialReadyEventSent !== false
      || report.googleSheetsAcceptance !== false || !Array.isArray(report.calls) || report.calls.length > 2
      || report.calls.some((call, index) => call.endpoint !== endpoints[index] || !Number.isInteger(call.status) || call.status < 100 || call.status > 599)
      || (report.passed && (report.calls.length !== 2 || report.calls.some(call => call.status !== 200)))
      || (!report.passed && !['invalid_expected_account', 'isolated_account_mismatch', 'unexpected_provider_request',
        'oauth_token_transport', 'oauth_token_response_invalid', 'drive_about_transport', 'drive_about_response_invalid',
        'provider_account_mismatch', 'invalid_child_context', 'provider_verification_failed'].includes(report.reason))) {
      throw new Error('INVALID_CHILD_REPORT');
    }
    return providerReport(report.passed, expectedEmail, report.calls.map(call => ({ endpoint: call.endpoint, status: call.status })), report.passed ? undefined : report.reason);
  } catch { return providerReport(false, expectedEmail, [], phase); }
}

module.exports = { main };
if (require.main === module) {
  const report = main(process.argv.slice(2));
  process.stdout.write(JSON.stringify(report) + '\n');
  if (!report.passed) process.exitCode = 1;
}
