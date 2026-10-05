# Google Sheets v1

Implementation issue: [documents #17](https://github.com/trained-assist/trained-assist-documents-skill/issues/17).
Parent: [architecture #140](https://github.com/trained-assist/trained-agent-architecture/issues/140).

The tools use the existing profile service-account contract, `USER_ID` and
`AGENT_TOKENS_DIR/<profile>/gdrive`. Google keys remain on the domain/MCP host.
OAuth, credential broker, external Runner MCP transport and durable task resume
are separate integration prerequisites. These tools remain behind the existing
service-account readiness gate.

## Tool inputs

| Tool | Input | Result |
|---|---|---|
| `gdrive_create_spreadsheet` | `title`, `folder_id` | `created`, `spreadsheet_id`, `title`, `url` |
| `gdrive_read_sheet` | `spreadsheet_id`, `sheet_name`, optional `range` | `range`, `values`, `row_count` and target IDs |
| `gdrive_write_sheet` | Existing inputs plus optional `operationId`, `source_sheet_name` | Legacy result; operation mode adds `operationId`, `deduplicated`, `verified` |

Creation checks that the supplied folder is in a Shared Drive and that the
service account can add children. It uses Drive `files.create` with the native
spreadsheet MIME type and `supportsAllDrives=true`. Service accounts have no
personal storage quota and cannot own files: a folder shared from personal My
Drive is insufficient for creation. See [Google's quota guidance](https://developers.google.com/workspace/drive/api/guides/handle-errors#storageQuotaExceeded).
An existing spreadsheet owned by the isolated test account and shared as Editor
with the service account can instead be used for the read/write fixture.

Creation is not idempotent. On a timeout, inspect the isolated folder and retain
the discovered spreadsheet ID before repeating anything. The fixture prints the
created ID immediately, before seeding, so a later failure can use `--seed`.

Readback accepts a bounded cell or rectangle such as `A1` or `B2:D20`, without a
tab prefix. When omitted, the range covers up to 26 columns and 1000 rows,
clamped to the actual tab grid; the maximum is 50,000 cells. Tab titles are
quoted/escaped, including spaces and apostrophes. Values use `UNFORMATTED_VALUE`
and serial date rendering. Google omits trailing empty cells/rows; an empty
range returns `values: []`.

## Result-write reconciliation

Use an operation ID stable for one logical result, for example
`task-140:categories:v1`. With `operationId`, the tool commits a new tab, typed
literal values and a sheet-scoped developer metadata receipt in a single
[atomic Sheets batch](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate).
The receipt contains operation/payload hashes, not credentials or the raw
operation ID. The operation is scoped to the spreadsheet. The deterministic
sheet ID prevents concurrent same-operation requests creating multiple tabs.

The first write requires an unused tab title and sheet ID. Existing tabs,
including source tabs, are never cleared or overwritten in operation mode,
regardless of `clear_first`. `source_sheet_name` additionally rejects an explicit
source/result title collision in both legacy and operation modes. The host must
retain the source ID/title and provide it; the tool cannot infer source intent.

Rows accept strings, finite numbers, booleans and null/omitted cells (empty).
Numbers/booleans stay typed; dates and strings beginning `=` remain literal.
Operation writes allow 50,000 cells and at most 2 MB of normalized row JSON.
They do not use the legacy formula-parsing `USER_ENTERED` mode.

After commit, or after a failed/ambiguous response, the tool checks the remote
receipt and reads the written rectangle. An identical replay returns
`deduplicated: true, verified: true` without writing. Changed payloads, renamed
targets or altered written cells yield `SHEETS_OPERATION_CONFLICT`; an existing
unowned target yields `SHEETS_TARGET_EXISTS`. Missing/unreadable evidence after
an attempted write yields `SHEETS_OUTCOME_UNKNOWN`. Known provider 4xx refusals
(except timeout/rate-limit statuses) preserve `SHEETS_API_ERROR` and HTTP status
after the reconciliation attempt. There is no automatic mutation retry.

Receipts survive MCP/Runner restarts because they live in Google. They are
reconciliation evidence, not an authorization boundary: spreadsheet editors can
change/remove metadata or cells. Hash collisions fail closed rather than picking
another ID. There is no global lock against arbitrary collaborators, no receipt
retention cleanup and no whole-spreadsheet transaction across multiple calls.
Keep the test spreadsheet isolated and serialize different logical results.

Without `operationId`, legacy defaults remain: create missing tab, clear an
existing tab unless `clear_first: false`, and write `USER_ENTERED` values. This
mode has no operation receipt or source inference. Integrator result writes must
supply `operationId` and a distinct result title. Monthly continuation uses a
new operation ID/title while preserving the same spreadsheet and task.

## Deterministic expenses fixture

```bash
node scripts/sandbox/google-expenses-fixture.cjs --print-fixture
```

This command is offline and reads no credential/profile directories. Source
data and expectations are in `scripts/fixtures/google-expenses-v1.json`:
8 expense rows, 2 exact duplicates at sheet rows 3 and 6, raw total 750,
deduplicated total 550. Categories: Food 230, Transport 120, Utilities 200.
Months: January 170, February 280, March 100. Deduplicate all four cells and
retain the first occurrence. The source tab is `Expenses`; suggested result
tabs are `Category results` and `Monthly results`.

Live preparation requires an operator-provisioned, encrypted service-account
binding in a dedicated absolute token root, a `sandbox-*` profile and a matching
confirmation. `CRED_ENCRYPTION_KEY` must already be supplied by the trusted host;
never pass credentials on the command line. The script does not provision keys,
read other profiles, use ADC or make files public.

```bash
node scripts/sandbox/google-expenses-fixture.cjs --create \
  --profile sandbox-integrator-google --tokens-dir /isolated/test-tokens \
  --confirm-isolated-binding sandbox-integrator-google --folder-id TEST_SHARED_DRIVE_FOLDER_ID

node scripts/sandbox/google-expenses-fixture.cjs --seed \
  --profile sandbox-integrator-google --tokens-dir /isolated/test-tokens \
  --confirm-isolated-binding sandbox-integrator-google --spreadsheet-id TEST_SPREADSHEET_ID
```

The selected folder/spreadsheet must also be isolated test data. A profile name
is not proof of isolation: the operator owns that binding/access check. Source
seeding uses a stable operation receipt and private readback, so repeating
`--seed` verifies without rewriting; an existing unowned `Expenses` tab is
refused. Output contains spreadsheet ID, fixture and expectations, never keys.
The script leaves result tabs for the real agent scenario to create and verify.

## Isolated stdio MCP host

The reproducible host is `scripts/sandbox/google-mcp-host.cjs`; it runs this
checkout's real MCP entry point with a separate three-tool registry. It exposes
only `gdrive_create_spreadsheet`, `gdrive_read_sheet`, `gdrive_write_sheet`, behind
the existing service-account readiness gate. Lifecycle/setup, public-file tools
and unrelated document tools are not exposed. This is a local domain host, not
a replacement gateway, credential broker or external Runner transport.

The trusted operator supplies a private runtime directory outside the checkout:

```text
runtime/                         0700
  .host-encryption-key            0600, fresh 64-hex host-only encryption key
  tokens/                        0700
    sandbox-integrator-google/   0700
      gdrive                     0600, encrypted v2 service-account binding
  home/                          0700, empty isolated HOME
  work/                          0700
  owner-target.json              0600, optional owner-approved target metadata
```

Neither secrets nor encrypted credential payloads belong in the repository,
PR, task inputs, model context, command-line arguments or MCP results. Provision
the binding through `writeServiceAccount()` in a trusted operator process with
`CRED_ENCRYPTION_KEY` present; never rely on the store's plaintext fallback.
The host checks ownership, exact modes, nonsymlink entries and encrypted
envelope structure. Runtime files must remain operator-controlled; same-UID
untrusted code is not isolated by file modes or this launcher.

```bash
node scripts/sandbox/google-mcp-host.cjs --runtime /absolute/private/runtime --probe
node scripts/sandbox/google-mcp-host.cjs --runtime /absolute/private/runtime --serve
```

`--probe` initializes the real stdio server, lists exactly three tools and
verifies a pre-provider refusal. It is always offline, even if an owner target
has already been approved. It outputs only readiness evidence. `--serve` starts
an interactive stdio endpoint; it does not launch the shared legacy agent.
Probe mode preloads denial guards for fetch, HTTP(S), TCP/TLS and UDP creation;
private IPC reports guard activation and blocked attempts. The probe succeeds
only with an active guard and zero attempts. This is Node API instrumentation,
not an OS network sandbox against malicious subprocesses/native code.

The child environment is an explicit allowlist: isolated paths/profile,
tool registry location, probe flag and host encryption key. It does not inherit
model API keys, `AGENT_SECRET`, `GDRIVE_SA_JSON`, cloud CLI configuration or
`GOOGLE_APPLICATION_CREDENTIALS`. Only the trusted host and domain process see
the encryption key and decrypt the SA binding; neither is supplied to the LLM.
Child stderr is suppressed; provider error text is replaced by a bounded code
while successful tool results retain their existing contract. This does not
sandbox OS/network access: do not give an untrusted model shell/file access to
the host runtime or credentials.

Until the owner supplies an isolated test target, omit `owner-target.json`.
All calls then fail with `OWNER_TARGET_REQUIRED` before any Google request.
An operator may write this metadata-only file privately after owner approval:

```json
{
  "profile": "sandbox-integrator-google",
  "ownerApproved": true,
  "folderId": "OWNER_APPROVED_SHARED_DRIVE_FOLDER_ID",
  "spreadsheetId": "OWNER_APPROVED_TEST_SPREADSHEET_ID"
}
```

Use only the fields needed: folder ID for creation, spreadsheet ID for read/write.
Calls to any other target fail with `TARGET_NOT_APPROVED`. Missing, malformed,
wrong-profile, unapproved or nonprivate binding fails closed. Approval is reread
on each call. Creation does not automatically approve the returned spreadsheet:
the operator must explicitly bind its ID before read/write. No public sharing
or automatic Google permission changes occur. The fixture CLI is a separate
operator tool, not governed by this MCP target gate.

## Provisioning and cleanup metadata

Provisioning remains operator-only and requires explicit authorization. Read
metadata first; if the desired account already exists, stop rather than reuse
an unknown identity. Never borrow an existing user profile or default VM SA.

```bash
PROJECT=trained-assist-gdrive-sa
ACCOUNT=integrator-v1-20261005
SA="$ACCOUNT@$PROJECT.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$SA" --project="$PROJECT" --format='json(email,disabled)' --quiet
gcloud iam service-accounts list --project="$PROJECT" --format='table(email,disabled)' --quiet
gcloud resource-manager org-policies describe constraints/iam.disableServiceAccountCreation --project="$PROJECT" --effective --quiet
gcloud resource-manager org-policies describe constraints/iam.disableServiceAccountKeyCreation --project="$PROJECT" --effective --quiet
gcloud resource-manager org-policies describe constraints/iam.managed.disableServiceAccountCreation --project="$PROJECT" --effective --quiet
gcloud resource-manager org-policies describe constraints/iam.managed.disableServiceAccountKeyCreation --project="$PROJECT" --effective --quiet
gcloud iam service-accounts keys list --iam-account="$SA" --project="$PROJECT" --filter=keyType:USER_MANAGED --format='table(name,keyType,disabled,validAfterTime)' --quiet
```

Once separately authorized, create only the dedicated SA/key using owner CLI
authentication, with no project roles granted to the new SA. Key creation is
not a metadata command: it writes a secret file. Use a `0700` private directory,
`umask 077`, a `0600` transient file, immediate encryption and guaranteed
transient-file cleanup on success/failure. Record only SA email/project/key ID,
time, mode checks and test evidence. Do not print key contents or access tokens.
Existing `gdrive_setup` uses GCP VM metadata ADC, not local owner `gcloud` auth.
GCP ownership does not grant Shared Drive permissions; that remains owner input.

Stop the isolated host before cleanup. Identify the dedicated key ID from the
metadata command above, then revoke it before deleting the dedicated SA:

```bash
gcloud iam service-accounts keys delete DEDICATED_KEY_ID --iam-account="$SA" --project="$PROJECT" --quiet
gcloud iam service-accounts delete "$SA" --project="$PROJECT" --quiet
```

After successful cloud cleanup, remove only this dedicated Google runtime and
its host encryption key, not a parent integration runtime or shared profile tree.
Deleting the SA does not delete Google artifacts; any later fixture cleanup
needs separate owner approval. No provisioning or cleanup command runs as part
of the MCP launcher or offline tests.

## Validation

The actual Node OAuth JWT exchange, Sheets bearer requests and Drive helper use
`redirect: 'error'` at their fixed Google endpoints. A redirect fails the
request rather than forwarding credentials or replaying its body; this also
applies inside the HTTP-to-stdio MCP host without a preparation/probe override.
`node --test tests/google-node-redirect.test.js` exercises real Node fetch
against local 307/308 fixtures with synthetic credentials, including Sheets
read and write requests plus Drive folder validation and spreadsheet creation,
and verifies zero redirected receiver requests. The isolated HTTP/stdio host
exposes only `gdrive_create_spreadsheet`, `gdrive_read_sheet` and
`gdrive_write_sheet`: their provider helpers are OAuth, Drive and Sheets.
Docs/export/download/lifecycle handlers are not exposed in this scope; their
legacy fetch behavior is not a redirect-security guarantee from these tests.

`node --test tests/gdrive-sheets.test.js tests/google-expenses-fixture.test.js tests/google-mcp-host.test.js`
uses synthetic auth and a stateful offline Google API. It exercises lost request
and response, module reload, concurrent duplicate/conflict, source protection,
private readback, known refusal, unreadable verification and legacy defaults.
Host tests additionally exercise real stdio discovery, offline probing after
approval, private/symlink/plaintext refusal, exact target gating, sanitized
provider errors and environment isolation with synthetic credentials only.
These checks establish module behavior; live Google, Telegram delivery and
awaiting-to-same-task acceptance remain with the parent integration.
