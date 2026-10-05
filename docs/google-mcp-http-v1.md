# Isolated Google MCP HTTP v1

Parent: [architecture #140](https://github.com/trained-assist/trained-agent-architecture/issues/140).
Transport issue: [documents #19](https://github.com/trained-assist/trained-assist-documents-skill/issues/19).
Stacked on documents PR #18, source `802fe204020f66cc7318df9ba902cf29053a4cac`.

This is a single-run host transport, not a controller or credential authority.
It reuses the real stdio entry point, isolated host environment and three-tool
registry; it does not fork Google handlers. OAuth/broker, Runner lifecycle and
binding-reference resolution stay with their owners. The existing SA is never
sent to the engine. Live artifact access requires separate owner target approval.

## Host-only registration before model access

The trusted resolver maps its binding reference to the already-provisioned
isolated runtime on the documents host. After Runner normalization, register
`userTaskId`, the dedicated profile and the **canonical Runner run UUID**, not
CP's original `spec.runId`. Registration must precede engine/model access.

Call the exported `mintBinding({runtime, userTaskId, profile, runId, expiresAt})`
from `scripts/sandbox/google-mcp-http.cjs`, or use its operator CLI:

```bash
node scripts/sandbox/google-mcp-http-mint.cjs \
  --runtime /absolute/private/google-runtime \
  --user-task-id REGISTERED_TASK_ID --profile sandbox-integrator-google \
  --run-id CANONICAL_RUNNER_UUID --expires-at FUTURE_ISO_TIMESTAMP
```

Minting writes a fresh random 256-bit opaque token to `http-binding.json` in
the private runtime (`0600`, exclusive creation), returning only scope/expiry
metadata. It does not read the SA, grant Google permissions or create resources.
An existing binding makes mint fail: inspect it, never silently reuse or replace
another run's token. Expiry must be future and at most 24 hours away. The host
is permanently pinned to the tuple present at startup; changing task/run/profile
requires a new isolated host. There is no remote mint endpoint.

The resolver reads the opaque token only on its trusted host/private channel
and injects it through `mcpSecrets`. No SA JSON, Google access token, encryption
key, owner cloud credentials or runtime path goes to the engine. The bearer is
not a Google credential: it authorizes only this task/profile/canonical run and
the three owner-target-gated tools. The engine process necessarily receives this
opaque transport token; keep it out of prompts and artifacts, with worker log
redaction. The remote worker currently exposes injected env to its process, so
this transport cannot guarantee secrecy from arbitrary same-process model shell
execution. Never give that process host credential filesystem access.

The [remote engine contract](https://github.com/trained-assist/opencode-gha-runner/blob/ed81ae75ae257eef21a34c36d1a8d75db810e557/src/contracts.ts)
supports named servers, header env references and separate `mcpSecrets`:

```json
{
  "mcp": {
    "servers": {
      "google-documents": {
        "type": "remote",
        "url": "https://ISOLATED_HOST/mcp",
        "headers": {
          "Authorization": "Bearer {env:GOOGLE_DOCUMENTS_MCP_TOKEN}",
          "X-MCP-User-Task-Id": "REGISTERED_TASK_ID",
          "X-MCP-Profile": "sandbox-integrator-google",
          "X-MCP-Run-Id": "CANONICAL_RUNNER_UUID"
        }
      }
    }
  }
}
```

Supply the runtime token separately as `mcpSecrets.GOOGLE_DOCUMENTS_MCP_TOKEN`;
do not replace the config env reference with a literal. The resolver supplies
only registered metadata and this bearer, never the underlying SA binding.

## Serving and target approval

Prepare the private runtime layout from [the stdio host contract](google-sheets-v1.md#isolated-stdio-mcp-host).
Start without inheriting operator/model credentials:

```bash
env -i PATH=/usr/bin:/bin HOME=/absolute/private/google-runtime/home \
  /absolute/path/to/node scripts/sandbox/google-mcp-http.cjs \
  --runtime /absolute/private/google-runtime --port 8791
```

The listener binds **127.0.0.1 only**. Parent-owned TLS forwarding/tunneling can
expose the endpoint later; it must preserve the local Host header and bearer/
scope headers. TLS is mandatory outside the local machine. No public listener,
tunnel, cloud resource or shared legacy agent is launched by this slice. Browser
Origin headers are rejected, and Host is limited to the listener's local names.
The endpoint has no access logs, and startup prints only listening state/port.

`POST /mcp` accepts one JSON-RPC message and replies as `application/json`.
Initialized/cancelled notifications receive empty `202`; notifications do not
cancel already-started mutations. `GET`/`DELETE` return `405`; there is no SSE,
session persistence or session header. Initialization negotiates supported
Streamable HTTP versions `2025-03-26`, `2025-06-18`, `2025-11-25`. See the
[transport specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports).
Only initialize, ping, tool discovery and the three tools are accepted. Auth
and tuple checks apply to every request, including discovery and notifications.
Binding removal/expiry revokes subsequent requests; it does not cancel a Google
mutation already in progress. Body/response sizes, concurrent domain calls and
transport wait time are bounded; malformed input/errors never echo bearer,
provider text or private paths. Domain child env is explicit, with no HTTP bearer
or inherited cloud/model env. The SA/master key stays solely on the trusted host.
Authorization is checked again after body upload, immediately before dispatch.
Startup verifies the existing SA readiness through exact three-tool discovery
before opening the HTTP listener; decryption/startup failures stay sanitized.

In HTTP mode, private `owner-target.json` must additionally match both registered
task ID and canonical run UUID:

```json
{
  "profile": "sandbox-integrator-google",
  "userTaskId": "REGISTERED_TASK_ID",
  "runId": "CANONICAL_RUNNER_UUID",
  "ownerApproved": true,
  "folderId": "OWNER_APPROVED_SHARED_DRIVE_FOLDER_ID",
  "spreadsheetId": "OWNER_APPROVED_TEST_SPREADSHEET_ID"
}
```

Omit this file until owner input. Missing/mismatched scope fails before any Google
artifact or token request. Approval is read for every tool call; only exact target
IDs pass. Creation does not automatically approve the new spreadsheet ID. A
changed transport/task/run does not inherit another run's owner approval.

Timeout/crash fails closed, stops the domain and never retries/restarts it
automatically. A started mutation may have committed: `MCP_OUTCOME_UNKNOWN`
requires reconciliation, not blind creation replay. Result writes retain the
existing operationId reconciliation contract; legacy defaults are unchanged.
Shutdown waits for actual domain exit and escalates ignored SIGTERM to SIGKILL;
failure to observe exit fails shutdown rather than reporting successful closure.
Stopping a host does not revoke Google permissions or delete artifacts. Stop it
and remove its private transport binding for transport cleanup; SA/key cleanup
remains the separately authorized procedure in the stdio documentation.

## Offline validation

```bash
node --test tests/google-mcp-http.test.js tests/google-mcp-host.test.js \
  tests/gdrive-sheets.test.js tests/google-expenses-fixture.test.js
```

Tests use synthetic encrypted bindings and the real HTTP→stdio→registry path.
They cover exact discovery, handshake, host-only mint, tuple/auth refusal,
missing/wrong owner targets, expiry/revocation, malformed input and timeout
without retry. No live Google artifact calls or owner profiles are used.
