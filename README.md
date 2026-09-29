# trained-assist-documents-skill

Documents domain skill server for [trained-assist-agent](https://github.com/trained-assist/trained-assist-agent):
presentations, document export and Google Drive. Core mounts it as the
`documents-skills` MCP sibling (same stdio JSON-RPC contract as the other
`trained-assist-*-skill` repos) and loads its playbooks and prompt domains.

Split out of core because the presentation service will keep growing — it
evolves here without weighing on the control plane.

## What is here

| Path | What it does |
|------|--------------|
| `src/deck/deckgen.js` | Markdown deck → `.pptx` (editable) + `.html` + `.pdf`, no LLM: layout, font sizes, colours, code highlighting are computed. Markup: `src/deck/deckgen-markdown-format.md`. |
| `src/doc-export/markdown-to-documents.js` | Markdown document → HTML + A4 PDF + DOCX from one pandoc source; wide tables become blocks. |
| `src/render/chromium.js` | The one headless Chromium launcher (system Chrome first, Playwright's as fallback). |
| `src/gdrive/google-auth.js` | Per-profile Google Service Account: key file, JWT → access token, SA delete. |
| `src/gdrive/drive-watcher.js` | Polls the Drive Changes API per profile, catalogs newly shared files, notifies Telegram. Runs in **core's** process (`server.js` loads it via `siblingLib('documents', …)`). |
| `src/mcp-skills/tools/10-deck.js` | `deck_markup_guide`, `deck_check`, `deck_render` |
| `src/mcp-skills/tools/20-doc-export.js` | `doc_export` |
| `src/mcp-skills/tools/50-gdrive.js` | `gdrive_*` (setup, status, list/read/search/create/update, Docs structure + precise insert, Sheets write, public files) |
| `src/prompt-domains/*.md` | Prompt sections core adds when this server is mounted |
| `playbooks/presentation-creation.json` | Playbook v1: ideation → research → outline → draft → RU/EN rewrite → render + fit loop → delivery |

## CLI

```bash
node src/deck/deckgen.js deck.md --out output/ru --name presentation-ru \
  --report output/ru/presentation-ru.deckgen.json --strict
```

`--strict` exits 2 when text does not fit (`warnings` non-empty); `--report`
writes the JSON report (creating the directory). `--no-pdf`, `--png`,
`--theme dark|light`, `--accent HEX` as before.

## Runtime requirements (VM)

- Node ≥ 20; runtime deps `pptxgenjs`, `playwright-core` — core's `deploy.sh` runs
  `npm ci --omit=dev` in this checkout when `package-lock.json` changes.
- Chrome at `/usr/bin/google-chrome` (or Playwright's Chromium), `pdfunite` /
  `pdftoppm` (poppler-utils), `pandoc`.
- Google Drive: VM default credentials allowed to create SAs in GCP project
  `trained-assist-gdrive-sa`.

## Development

```bash
npm ci
npm run check   # every tool module loads, server parses, playbook is JSON
npm test        # offline unit tests (no browser, no network)
```

CI also checks out core and runs `scripts/check-mcp-conformance.js` — the same
gate core's deploy uses before it moves this checkout in prod.

## Claude Code Instructions

- Same env contract as core: `USERS_DIR`, `AGENT_TOKENS_DIR`, `AGENT_DATA_DIR`
  via `src/data-paths.js` — never build `os.homedir()/agent-tokens/...` inline.
- Token files are written with mode `0o600`; every HTTP call has a timeout.
- External binaries (`pandoc`, `pdfunite`, `pdftoppm`) via `execFile` with an
  argument array — file names come from users, no shell strings.
- Tool names are an API: renaming one needs a core PR too (prompt domains,
  `config/skill-catalog.json`, intent-engine references).
- Playbooks: no absolute host paths, no model version ids (contract is
  `executor_role` + `minimum_model_level`); prefer deterministic
  `file_exists` / `command_exit_zero` checks over prose validation keys.
- PRs only; never push to `main` or to someone else's branch.

## Чеклисты и планы — не для репозиториев с pull requestами

Чеклисты (checklist.md и подобные трекеры) и планы НЕ живут в репозитории, где есть pull requestы: общий файл становится гарантированным merge conflict при параллельных PR (дважды за день: trained-assist-agent #1790, #1829), а статус CI/merge и так виден в GitHub. Планы и трекеры статуса -> issue или тело PR. Исключение: репо в статусе draft (нет PR-флоу, одна ветка) — локальный чеклист там допустим.
