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
tab prefix. The default is `A1:Z1000`; the maximum is 50,000 cells. Tab titles are
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

## Validation

`node --test tests/gdrive-sheets.test.js tests/google-expenses-fixture.test.js`
uses synthetic auth and a stateful offline Google API. It exercises lost request
and response, module reload, concurrent duplicate/conflict, source protection,
private readback, known refusal, unreadable verification and legacy defaults.
These checks establish module behavior; live Google, Telegram delivery and
awaiting-to-same-task acceptance remain with the parent integration.
