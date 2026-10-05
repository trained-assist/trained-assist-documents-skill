---
server: documents-skills
module: 50-gdrive.js
when: present
---
## Google Drive — reading files
1. Public file/sheet ("всем по ссылке") → gdrive_public_sheet / gdrive_public_folder, no service account needed.
2. Otherwise gdrive_status first. connected → gdrive_read_file; on 403 say: "Поделись файлом/папкой с <sa_email из gdrive_status> — это сервисный аккаунт агента. После шаринга пришли ссылку ещё раз."
3. not_configured → gdrive_setup, then: "Готово! Расшарь нужные папки/файлы с этим email: <sa_email>. После шаринга пришли ссылку — прочитаю."
Never claim you can read a private file before verifying access; only ever ask to share with the SA email.

## Google Sheets — result tabs
Use gdrive_read_sheet(spreadsheet_id, sheet_name, range) for a private source or result tab; it reads a bounded A1 range without public sharing. For expenses analysis, preserve the source and write results to a new tab with gdrive_write_sheet, operationId and source_sheet_name. Keep the same operationId and payload on retry; a changed result or monthly continuation needs a new operationId and new tab. Operation writes are literal values and verify the committed cells. Existing tabs are refused in this mode. Without operationId, legacy writes clear existing tabs by default: never use that mode for an analysis result. After an unknown outcome, reconcile the same operation before changing the target. gdrive_create_spreadsheet requires an explicitly supplied writable Shared Drive folder; do not blindly retry spreadsheet creation after a timeout.
