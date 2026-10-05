# Owner-approved Sheet fixture preparation

Parent: [architecture #140](https://github.com/trained-assist/trained-agent-architecture/issues/140).
This domain-owned operator is for the dedicated spreadsheet
`1KTYuKw-hzM5bJCHbhnm-TG63oApHX_KhuuGT2CeWaxg` only. It does not create
spreadsheets, share files, mint MCP bindings, send credential-ready events,
submit CP work or start models. **Only the parent operator may execute live
commands after owner approval.** Offline tests are not provider acceptance.

## Private inputs and command contract

Use the existing isolated Google runtime and a separate operator-owned `0700`
directory for preparation metadata/checkpoint/source output. JSON files must be
`0600`, owned by the operator and nonsymlink. The runtime must pass the existing
`childEnvironment` contract; no ADC, inherited environment or root credentials.
The exact service-account email and baseline title/gid are parent-confirmed
metadata, never guesses. Example metadata structure:

```json
{
  "schemaVersion": "google-sheet-preparation-v1",
  "spreadsheetId": "1KTYuKw-hzM5bJCHbhnm-TG63oApHX_KhuuGT2CeWaxg",
  "expectedSaEmail": "ISOLATED_SA@ISOLATED_PROJECT.iam.gserviceaccount.com",
  "baselineSheetId": 1056899445,
  "baselineSheetName": "PARENT_CONFIRMED_EXISTING_TAB_TITLE"
}
```

For each phase use the same runtime, metadata and output paths:

```sh
node scripts/sandbox/google-sheet-prepare.cjs preflight \
  --runtime "$GOOGLE_PRIVATE_RUNTIME" \
  --metadata "$PRIVATE_RUNTIME/sheet-preparation-metadata.json" \
  --checkpoint "$PRIVATE_RUNTIME/sheet-preparation-checkpoint.json" \
  --source-out "$PRIVATE_RUNTIME/source.json"
```

`preflight` is read-only at Google. It exclusively creates a private checkpoint,
authenticates freshly through the existing SA auth module in an isolated child,
checks Drive-about exact account, file identity/type/not-trashed and
`capabilities.canEdit:true`, then reads selected **full-grid** Sheets data with
no range restriction. The metadata field mask explicitly includes grid values;
see [Sheets get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get)
and [Drive file capabilities](https://developers.google.com/workspace/drive/api/reference/rest/v3/files).
Every existing GRID tab must be blank, including formulas, zeros and cells outside
the proposed source rectangle. The confirmed baseline gid/title must match.
An existing Expenses tab or fixture sheet-ID collision refuses first seeding.
All baseline tab IDs/titles/grid sizes are checkpointed before any mutation.
No source input file is published during preflight. If permission/readback fails,
there is no seed; a failed preflight checkpoint is not automatically replaced.

After parent review and explicit owner authorization, invoke the **same command
arguments with `seed` instead of `preflight`**. This requires a successful prior
checkpoint and rechecks fresh auth, permissions and the exact blank baseline.
It durably records `seed_attempted` before launching the existing
`google-expenses-fixture.cjs --seed` in a fresh `childEnvironment` child.
No credential/key/access token or raw child output is forwarded to the terminal.

The child permits only one exact approved fixture batch: add a new Expenses tab,
write the existing literal fixture rows and its developer-metadata receipt.
It delegates the mutation to the existing tool/CLI, not a parallel write handler.
The operation is always `google-expenses-v1:source`. No deletion, legacy clear,
overwrite, alternate title, other spreadsheet/resource or second mutation is
allowed. Every provider fetch rejects redirects, has a 15-second deadline and
4 MiB JSON body bound; children have a 120-second total bound and captured
64 KiB stdout/stderr limit.

After successful seed, a fresh read-only child checks actual Expenses metadata,
exact operation/payload receipt and sheet scope, all literal/effective cells,
no extra source cells, actual readback SHA-256 against the pinned fixture, and
every preserved baseline tab unchanged/blank. It then atomically publishes private
`source.json` for the CP harness with only `schemaVersion:google-sheet-source-v1`,
the approved `spreadsheetId`, **observed verified** `sourceSheetId`,
`sourceSheetName:Expenses`, and `sourceRange:A1:D1000`. No rows, expected totals
or credentials are in that file. The source gid is not the owner URL's baseline
gid and must not be guessed from it. The source output is exclusive; an existing
identical file is accepted on reconciliation, never overwritten.

## Ambiguous outcome: read-only reconciliation

After **any seed attempt**, repeating `seed` is refused, including after success.
If the child times out/loses ACK, use the same arguments with `reconcile`.
It performs fresh read-only inspection of the **same** receipt/fixture operation,
preserves the baseline and exports source metadata only if every check passes.
Missing/conflicting receipt, missing tab or changed cells stay unresolved; no
blind write retry or alternate tab is performed. Parent must inspect the existing
operation before any further independently authorized action. Repeating a
verified reconciliation is read-only and preserves identical source metadata.

An exclusive sibling `.lock` prevents concurrent local operators; it is never
automatically stolen. Owner reconciliation is required before stale-lock removal.
Publication fsyncs both the completed file and its private parent directory
after rename/link, before acknowledging the checkpoint/source file. Directory
sync failure refuses seed launch even if the intent file already exists; there
is no best-effort fallback on filesystems without directory fsync support.
Atomic checkpoint writes bind the private runtime reference, exact metadata,
output path, fixed operation ID and fixture hash. This is not a Google lock
against other editors: keep the dedicated Sheet isolated and serialize operators.
Remote blankness checks and seeding are separate requests, not a cross-request
transaction; the only permitted batch never modifies existing tabs regardless.

Successful output proves only fixture preparation/readback, not model tool use,
category/month results, CP continuation, public artifacts or full Sheet acceptance.
The CP Google harness remains prepare-only until source-protection, trusted
registration and actual permission gates are separately reviewed and activated.

```sh
node --test tests/google-sheet-prepare.test.js tests/google-expenses-fixture.test.js \
  tests/gdrive-sheets.test.js tests/google-provider-verify.test.js
```

Tests use synthetic private files, mocked providers and the actual existing
operation handler. They never read a real SA, call Google or mutate a live Sheet.
