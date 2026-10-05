# Isolated Google provider-only verification

Domain-owner operator tool, not a broker, model tool or credential-ready sender.
This replaces the temporary verifier with reproducible source. The parent must
already have provisioned the private isolated runtime and know its exact service
account email. This tool creates no credentials, changes no input files, and
performs no Google artifact operations.

```sh
node scripts/sandbox/google-provider-verify.cjs \
  --runtime /absolute/private/google-runtime \
  --expected-sa-email ISOLATED_ACCOUNT@PROJECT.iam.gserviceaccount.com
```

Do not invoke against real runtime paths without parent authorization. The
existing `childEnvironment(runtime, false)` validates private modes, ownership,
encrypted mount and host key, and supplies only its explicit environment. A fresh
child imports the existing `src/gdrive/google-auth.js`, reads only the pinned
`sandbox-integrator-google` account and requires exact expected email equality.
Host keys, SA JSON/JWT and access tokens stay in that host child, not stdout,
models, prompts, artifacts, MCP wire or CP requests. Child stderr is captured,
never relayed by the parent CLI.

Only these two HTTP requests, in order, are permitted:

1. POST `https://oauth2.googleapis.com/token` through existing Google auth.
2. GET `https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)`
   with that token; require exact `user.emailAddress` equality.

Signed/authenticated requests reject redirects, each request is bounded to 15
seconds, and object-shaped JSON bodies to 64 KiB. Child execution is bounded to
35 seconds and 64 KiB output. Any other endpoint/method/order, reused token without
a fresh token response, non-200 response, malformed/oversized body, account
mismatch or runtime error fails closed with a fixed sanitized reason.

Stdout contains provider-only JSON metadata (including expected SA email, check
time, endpoint classes and status codes), never provider response bodies. Exit
code zero requires both real 200 responses and exact account match. It explicitly
sets `providerOnly: true`, `realGoogleArtifactCalls: 0`,
`credentialsForwardedToEngine: false`, `credentialReadyEventSent: false`, and
`googleSheetsAcceptance: false`. Provider identity verification is not owner
target approval, Sheet access, a Runner/MCP capability, task resume or final
acceptance. There is no JSON evidence input or ready-event mode. Parent must
separately authorize any credential callback after a fresh real verification.

Offline validation (mocks, no real credentials or provider calls):

```sh
node --test tests/google-provider-verify.test.js tests/google-mcp-host.test.js
```
