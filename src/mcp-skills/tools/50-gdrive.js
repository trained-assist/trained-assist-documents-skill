'use strict';

// Google Drive skill — per-user Service Account.
//
// Setup flow:
//   1. gdrive_setup → creates SA in trained-assist-gdrive-sa project (via VM ADC),
//      stores JSON key as <AGENT_TOKENS_DIR>/{userId}/gdrive (src/gdrive/google-auth.js)
//   2. User shares Drive folder with the SA email returned by gdrive_setup
//   3. gdrive_list_files / gdrive_read_file / etc. work from that point
//
// Note: SA is created in a separate GCP project (trained-assist-gdrive-sa) that has
// no org policies blocking key creation, unlike the main GCP project.

const {
  GCP_PROJECT, getAdcToken, readServiceAccount, writeServiceAccount, getAccessToken,
} = require('../../gdrive/google-auth');
const {
  extractXlsxHyperlinks, parseXlsxToText,
} = require('../../gdrive/xlsx');
const { createHash } = require('crypto');

const USER_ID = process.env.USER_ID || process.env.AGENT_USER_ID || '';
const parseSaJson = (userId) => readServiceAccount(userId || USER_ID);

function requireSa() {
  const sa = parseSaJson();
  if (!sa) {
    throw new Error(
      'Google Drive не настроен. Вызови gdrive_setup — это автоматически создаст сервис-аккаунт.\n\n' +
      'После этого расшарь нужные папки Drive с SA email который вернёт gdrive_setup.'
    );
  }
  return sa;
}

// ── Sheets API helper ─────────────────────────────────────────────────────────

async function sheetsApi(method, apiPath, body = null, sa = null) {
  if (!sa) sa = requireSa();
  const token = await getAccessToken(sa);
  const res = await fetch(`https://sheets.googleapis.com/v4${apiPath}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(`Sheets ${res.status}: ${data.error?.message || JSON.stringify(data)}`), { code: 'SHEETS_API_ERROR', status: res.status });
  return data;
}

const SHEET_OPERATION_KEY = 'trained_assist_sheet_operation_v1';
const MAX_SHEET_CELLS = 50_000;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const quotedSheet = (name) => `'${name.replace(/'/g, "''")}'`;

function sheetError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function validateSheetTarget(spreadsheetId, sheetName) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(spreadsheetId || '') ||
      typeof sheetName !== 'string' || !sheetName.trim() || sheetName.length > 100 || /[\[\]:*?/\\]/.test(sheetName)) {
    throw sheetError('SHEETS_INVALID_INPUT', 'Expected spreadsheet_id and a valid sheet_name');
  }
}

function columnNumber(column) {
  return [...column].reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0);
}

function columnName(number) {
  let name = '';
  while (number > 0) {
    number -= 1;
    name = String.fromCharCode(65 + number % 26) + name;
    number = Math.floor(number / 26);
  }
  return name;
}

function validateSheetRange(range) {
  const match = typeof range === 'string' && range.match(/^([A-Z]{1,3})([1-9]\d{0,6})(?::([A-Z]{1,3})([1-9]\d{0,6}))?$/);
  if (!match) throw sheetError('SHEETS_INVALID_INPUT', 'range must be a bounded A1 cell or rectangle without a tab prefix');
  const columns = columnNumber(match[3] || match[1]) - columnNumber(match[1]) + 1;
  const rows = Number(match[4] || match[2]) - Number(match[2]) + 1;
  if (columns < 1 || rows < 1 || rows * columns > MAX_SHEET_CELLS) {
    throw sheetError('SHEETS_INVALID_INPUT', `range must contain 1..${MAX_SHEET_CELLS} cells`);
  }
}

async function readSheetValues(spreadsheetId, sheetName, range, sa) {
  const qualified = `${quotedSheet(sheetName)}!${range}`;
  return sheetsApi('GET', `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(qualified)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`, null, sa);
}

function literalRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_SHEET_CELLS || !rows.every(Array.isArray)) {
    throw sheetError('SHEETS_INVALID_INPUT', 'rows must be a nonempty array of arrays');
  }
  const width = Math.max(...rows.map(row => row.length));
  if (!width || width > 18278 || width * rows.length > MAX_SHEET_CELLS) {
    throw sheetError('SHEETS_INVALID_INPUT', `rows must contain 1..${MAX_SHEET_CELLS} cells`);
  }
  return rows.map(row => Array.from({ length: width }, (_, index) => {
    const value = row[index] ?? '';
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
      throw sheetError('SHEETS_INVALID_INPUT', 'cells must be strings, finite numbers, booleans or null');
    }
    return value;
  }));
}

async function writeSheetOperation({ spreadsheet_id, sheet_name, rows, operationId }, sa) {
  validateSheetTarget(spreadsheet_id, sheet_name);
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(operationId)) {
    throw sheetError('SHEETS_INVALID_INPUT', 'operationId must be a stable identifier of 1..160 characters');
  }
  const values = literalRows(rows);
  if (Buffer.byteLength(JSON.stringify(values)) > 2_000_000) {
    throw sheetError('SHEETS_INVALID_INPUT', 'operation rows exceed the 2 MB payload limit');
  }
  const operationHash = digest(operationId);
  const payloadHash = digest(JSON.stringify({ spreadsheet_id, sheet_name, values }));
  const sheetId = parseInt(operationHash.slice(0, 8), 16) & 0x7fffffff;
  const range = `A1:${columnName(values[0].length)}${values.length}`;
  const inspect = () => sheetsApi('GET', `/spreadsheets/${spreadsheet_id}?fields=sheets(properties,developerMetadata),developerMetadata`, null, sa);
  const result = (deduplicated) => ({
    written: true, spreadsheet_id, sheet_name, rows_written: rows.length,
    tab_created: !deduplicated, operationId, deduplicated, verified: true,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheet_id}`,
  });
  const reconcile = async (meta) => {
    const metadata = [...(meta.developerMetadata || []), ...(meta.sheets || []).flatMap(sheet => sheet.developerMetadata || [])];
    const receipts = metadata.filter(entry => entry.metadataKey === SHEET_OPERATION_KEY).map(entry => {
      try { return { ...JSON.parse(entry.metadataValue), sheetId: entry.location?.sheetId }; }
      catch { return null; }
    }).filter(receipt => receipt?.operationHash === operationHash);
    if (!receipts.length) return false;
    const target = meta.sheets?.find(sheet => sheet.properties?.title === sheet_name);
    if (receipts.some(receipt => receipt.payloadHash !== payloadHash || receipt.sheetId !== target?.properties?.sheetId)) {
      throw sheetError('SHEETS_OPERATION_CONFLICT', 'operationId already committed with another payload or target');
    }
    const readback = await readSheetValues(spreadsheet_id, sheet_name, range, sa);
    const actual = values.map((row, rowIndex) => row.map((value, columnIndex) => readback.values?.[rowIndex]?.[columnIndex] ?? ''));
    if (JSON.stringify(actual) !== JSON.stringify(values)) {
      throw sheetError('SHEETS_OPERATION_CONFLICT', 'committed result cells have changed; refusing to overwrite');
    }
    return true;
  };
  const meta = await inspect();
  if (await reconcile(meta)) return result(true);
  if (meta.sheets?.some(sheet => sheet.properties?.title === sheet_name || sheet.properties?.sheetId === sheetId)) {
    throw sheetError('SHEETS_TARGET_EXISTS', 'operationId writes require a new result tab; existing tabs are never cleared');
  }
  try {
    await sheetsApi('POST', `/spreadsheets/${spreadsheet_id}:batchUpdate`, {
      requests: [
        { addSheet: { properties: { sheetId, title: sheet_name, gridProperties: { rowCount: values.length, columnCount: values[0].length } } } },
        { updateCells: {
          start: { sheetId, rowIndex: 0, columnIndex: 0 },
          rows: values.map(row => ({ values: row.map(value => ({ userEnteredValue: {
            [typeof value === 'number' ? 'numberValue' : typeof value === 'boolean' ? 'boolValue' : 'stringValue']: value,
          } })) })),
          fields: 'userEnteredValue',
        } },
        { createDeveloperMetadata: { developerMetadata: {
          metadataKey: SHEET_OPERATION_KEY, metadataValue: JSON.stringify({ operationHash, payloadHash }),
          location: { sheetId }, visibility: 'DOCUMENT',
        } } },
      ],
    }, sa);
  } catch (writeError) {
    try {
      if (await reconcile(await inspect())) return result(true);
    } catch (error) {
      if (error.code === 'SHEETS_OPERATION_CONFLICT') throw error;
    }
    if (writeError.status >= 400 && writeError.status < 500 && ![408, 429].includes(writeError.status)) throw writeError;
    throw sheetError('SHEETS_OUTCOME_UNKNOWN', 'no verified receipt after write failure; reconcile with the same operationId and payload');
  }
  try {
    if (!await reconcile(await inspect())) throw sheetError('SHEETS_OUTCOME_UNKNOWN', 'write returned without a receipt');
  } catch (error) {
    if (error.code === 'SHEETS_OPERATION_CONFLICT') throw error;
    throw sheetError('SHEETS_OUTCOME_UNKNOWN', 'write could not be verified; reconcile with the same operationId and payload');
  }
  return result(false);
}

// ── Docs API helper (structural, index-based edits — preserves formatting) ───

async function docsApi(method, apiPath, body = null, sa = null) {
  if (!sa) sa = requireSa();
  const token = await getAccessToken(sa);
  const res = await fetch(`https://docs.googleapis.com/v1${apiPath}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.error?.status === 'PERMISSION_DENIED' && data.error?.details?.some(d => d.reason === 'SERVICE_DISABLED')) {
      throw new Error(
        'Google Docs API отключён в GCP-проекте сервис-аккаунта. Точечное редактирование Google Docs (gdrive_docs_get_structure / gdrive_docs_insert_text) недоступно, пока владелец проекта его не включит: ' +
        'https://console.cloud.google.com/apis/library/docs.googleapis.com?project=trained-assist-gdrive-sa — у самого сервис-аккаунта нет прав включить API себе.'
      );
    }
    throw new Error(`Docs API ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
  }
  return data;
}

// Flatten a Docs API document.body.content tree into a linear list of paragraphs.
// Each entry keeps the Docs API character index range so callers can compute a
// precise insertText location without touching anything else in the document.
function flattenDocStructure(doc) {
  const out = [];
  const walk = (elements) => {
    for (const el of elements || []) {
      if (el.paragraph) {
        const style = el.paragraph.paragraphStyle?.namedStyleType || 'NORMAL_TEXT';
        const bullet = el.paragraph.bullet ? true : false;
        const text = (el.paragraph.elements || [])
          .map(e => e.textRun?.content || '')
          .join('')
          .replace(/\n$/, '');
        out.push({ startIndex: el.startIndex, endIndex: el.endIndex, style, bullet, text });
      } else if (el.table) {
        for (const row of el.table.tableRows || []) {
          for (const cell of row.tableCells || []) walk(cell.content);
        }
      } else if (el.sectionBreak) {
        // no text content
      }
    }
  };
  walk(doc.body?.content);
  return out;
}

// ── Drive API helper ──────────────────────────────────────────────────────────

async function driveApi(method, apiPath, body = null, sa = null) {
  if (!sa) sa = requireSa();
  const token = await getAccessToken(sa);
  const url   = apiPath.startsWith('http') ? apiPath : `https://www.googleapis.com${apiPath}`;
  const opts  = {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    const msg = err.error?.message || err.message || res.statusText;
    if (res.status === 403) throw new Error(`Нет доступа (403): ${msg}\n\nРасшарь файл/папку с SA email (gdrive_status покажет email).`);
    if (res.status === 404) throw new Error(`Файл/папка не найдена (404): ${msg}`);
    throw new Error(`Drive API ${res.status}: ${msg}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function exportFile(fileId, mimeType, sa) {
  const token = await getAccessToken(sa);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(mimeType)}&supportsAllDrives=true`,
    { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`Export ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.text();
}

async function downloadFile(fileId, sa) {
  const token = await getAccessToken(sa);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`Download ${res.status}`);
  return res.text();
}

async function downloadFileBuffer(fileId, sa) {
  const token = await getAccessToken(sa);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(30000) }
  );
  if (!res.ok) throw new Error(`Download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const MIME_READABLE = {
  'application/vnd.google-apps.document':     'text/plain',
  'application/vnd.google-apps.spreadsheet':  'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'text/plain': null, 'text/csv': null, 'application/json': null,
  'text/html': null, 'text/markdown': null,
};

// Excel MIME types we can parse with the built-in xlsx reader (ZIP-based).
const EXCEL_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel.sheet.macroEnabled.12',                    // .xlsm
]);

// ── Public files — NO Service Account needed ─────────────────────────────────
// A Google file shared "anyone with the link" is fetchable over plain HTTP.
// Do NOT reflexively call gdrive_setup for these. Two facts drive this path:
//   • CSV export (…/export?format=csv) returns only VISIBLE cell text and drops
//     any hyperlink embedded inside a cell — a limitation of the CSV format,
//     not of access.
//   • XLSX export (…/export?format=xlsx) preserves in-cell hyperlinks. The xlsx
//     is a zip; each worksheet's <hyperlink> maps to a URL via its .rels file.

// Pull a Google file ID out of any Drive/Docs/Sheets URL (or return the raw ID).
function parseFileId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/\/d\/([A-Za-z0-9_-]{20,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  return null;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

module.exports = {
  isReady: () => !!parseSaJson(USER_ID),
  // These tools need no SA — expose them before gdrive_setup so Claude never
  // reflexively calls gdrive_setup for public files/folders.
  setupTools: ['gdrive_setup', 'gdrive_status', 'gdrive_public_sheet', 'gdrive_public_folder'],
  tools: {

    gdrive_setup: {
      description: 'First-time setup: creates a dedicated Google Service Account for this user, stores the credentials, and returns the SA email to share Drive folders with. Run this once before using other gdrive tools. IMPORTANT: when the result contains reply_to_user, send that text verbatim to the user — do NOT paraphrase or add instructions like "send me a link". After sharing, the user just needs to send any message and you will call gdrive_list_files automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          display_name: { type: 'string', description: 'Human-readable SA name (optional, defaults to user ID)' },
        },
      },
      handler: async ({ display_name } = {}) => {
        const userId = USER_ID;
        if (!userId) throw new Error('USER_ID не задан');

        const existing = parseSaJson(userId);
        if (existing) {
          return {
            status: 'already_configured',
            sa_email: existing.client_email,
            message: `SA уже настроен. Email: ${existing.client_email}`,
            reply_to_user: `🧠 Google Drive уже подключён!\n\nEmail сервис-аккаунта: \`${existing.client_email}\`\n\nРасшарь нужные папки с этим email → после этого напиши любое сообщение, я сам проверю доступ. Ссылку слать не нужно.`,
          };
        }

        let adcToken;
        try {
          adcToken = await getAdcToken();
        } catch (e) {
          throw new Error(
            `Не удалось получить ADC токен с VM: ${e.message}\n\n` +
            'Убедись что агент запущен на GCP VM с активным service account.'
          );
        }

        const nameSource = display_name || process.env.AGENT_USER_NAME || '';
        const handleSource = (process.env.AGENT_USER_HANDLE || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
        const _slug = (nameSource
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')   // non-ascii (Cyrillic etc.) and spaces → -
          .replace(/^-+|-+$/g, '')        // trim leading/trailing -
          .slice(0, 20))                  // leave room for suffix
          || handleSource                 // fallback: Telegram @handle (always ASCII)
          || 'user';
        const _suffix = Math.random().toString(36).slice(2, 6); // 4 random alphanumeric chars
        // GCP SA accountId: 6-30 chars, must start with lowercase letter
        const _raw = `${_slug}-${_suffix}`;
        const accountId = /^[a-z]/.test(_raw) ? _raw : `u-${_raw}`.slice(0, 30);
        const saName    = nameSource || `Agent User ${userId}`;

        // Create Service Account in the dedicated project (no org policies)
        const createRes = await fetch(
          `https://iam.googleapis.com/v1/projects/${GCP_PROJECT}/serviceAccounts`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${adcToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId, serviceAccount: { displayName: saName } }),
            signal: AbortSignal.timeout(15000),
          }
        );

        let saData = null;
        if (!createRes.ok) {
          const err = await createRes.json().catch(() => ({}));
          const msg = err.error?.message || createRes.statusText;
          if (createRes.status !== 409) {
            throw new Error(`Не удалось создать SA (${createRes.status}): ${msg}`);
          }
          // 409 = SA already exists — continue with derived email
        } else {
          saData = await createRes.json().catch(() => null);
        }
        const saEmail = saData?.email || `${accountId}@${GCP_PROJECT}.iam.gserviceaccount.com`;

        // Delete existing user-managed keys to avoid accumulation (GCP limit: 10 keys per SA)
        try {
          const keysRes = await fetch(
            `https://iam.googleapis.com/v1/projects/${GCP_PROJECT}/serviceAccounts/${encodeURIComponent(saEmail)}/keys?keyTypes=USER_MANAGED`,
            { headers: { 'Authorization': `Bearer ${adcToken}` }, signal: AbortSignal.timeout(10000) }
          );
          if (keysRes.ok) {
            const { keys = [] } = await keysRes.json();
            for (const k of keys) {
              await fetch(`https://iam.googleapis.com/v1/${k.name}`, {
                method: 'DELETE', headers: { 'Authorization': `Bearer ${adcToken}` }, signal: AbortSignal.timeout(5000),
              }).catch(() => {});
            }
          }
        } catch { /* non-critical — proceed to create new key */ }


        // Create key for the SA — retry up to 4x because GCP may return 404 briefly after SA creation (propagation delay)
        let keyData = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 3000 * attempt));
          const keyRes = await fetch(
            `https://iam.googleapis.com/v1/projects/${GCP_PROJECT}/serviceAccounts/${encodeURIComponent(saEmail)}/keys`,
            {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${adcToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE' }),
              signal: AbortSignal.timeout(15000),
            }
          );
          if (keyRes.ok) { keyData = await keyRes.json(); break; }
          const err = await keyRes.json().catch(() => ({}));
          if (keyRes.status !== 404 || attempt === 3) {
            throw new Error(`Не удалось создать ключ SA (${keyRes.status}): ${err.error?.message || keyRes.statusText}`);
          }
        }
        const saJson  = JSON.parse(Buffer.from(keyData.privateKeyData, 'base64').toString('utf8'));

        writeServiceAccount(userId, saJson);

        return {
          status: 'created',
          sa_email: saJson.client_email,
          reply_to_user: `🧠 Готово! Расшарь нужные папки/файлы с этим email:\n\`${saJson.client_email}\`\n\nКак расшарить: правый клик на папке → Поделиться → добавь email → роль "Читатель" (или "Редактор" если нужна запись).\n\nПосле шаринга просто напиши мне — я сам проверю доступ. Никакую ссылку слать не нужно.`,
        };
      },
    },

    gdrive_status: {
      description: 'Check Google Drive connection status and how many files are accessible. ' +
        'NOTE: files_accessible counts only folder-shared files via files.list — files shared directly by ID return 0 here but are still readable via gdrive_read_file(file_id). ' +
        'If files_accessible=0 but you have a file ID, try gdrive_read_file directly before concluding access is broken.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const sa = parseSaJson();
        if (!sa) {
          return { status: 'not_configured', message: 'Google Drive не настроен. Вызови gdrive_setup.' };
        }
        try {
          const data = await driveApi('GET', '/drive/v3/files?pageSize=1&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true', null, sa);
          return {
            status: 'connected',
            files_accessible: data.files?.length ?? 0,
            note: 'files_accessible=0 is normal if files are shared directly by ID (not via folder). Use gdrive_read_file(file_id) to confirm access.',
          };
        } catch (e) {
          return { status: 'error', error: e.message };
        }
      },
    },

    gdrive_list_files: {
      description: 'List files in a Google Drive folder shared with your Service Account.',
      inputSchema: {
        type: 'object',
        properties: {
          folder_id:  { type: 'string', description: 'Folder ID from Drive URL (after /folders/). Empty = list all shared files.' },
          page_size:  { type: 'number', description: 'Max files (default 30, max 100)' },
          page_token: { type: 'string', description: 'Next page token from previous result' },
        },
      },
      handler: async ({ folder_id, page_size = 30, page_token } = {}) => {
        const sa    = requireSa();
        const limit = Math.min(page_size || 30, 100);
        let q       = 'trashed=false';
        if (folder_id) q += ` and '${folder_id.replace(/'/g, '')}' in parents`;
        const fields  = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)';
        let apiPath   = `/drive/v3/files?pageSize=${limit}&orderBy=modifiedTime desc&fields=${encodeURIComponent(fields)}&q=${encodeURIComponent(q)}&supportsAllDrives=true&includeItemsFromAllDrives=true`;
        if (page_token) apiPath += `&pageToken=${encodeURIComponent(page_token)}`;
        const data = await driveApi('GET', apiPath, null, sa);
        return {
          files: data.files?.map(f => ({
            id: f.id, name: f.name, type: f.mimeType,
            size_kb: f.size ? Math.round(f.size / 1024) : null,
            modified: f.modifiedTime, url: f.webViewLink,
          })) ?? [],
          next_page_token: data.nextPageToken ?? null,
        };
      },
    },

    gdrive_public_sheet: {
      description: 'Read a PUBLIC Google file (shared "anyone with the link") — NO Service Account, NO gdrive_setup needed.\n\n' +
        'Handles two cases automatically:\n' +
        '• Google Sheets URL (docs.google.com/spreadsheets/…) → exports as CSV + extracts in-cell hyperlinks\n' +
        '• Raw Drive file URL (drive.google.com/file/d/…) — e.g. an Excel .xlsx uploaded to Drive → downloads the binary and parses all sheets as CSV\n\n' +
        'ALWAYS try this tool first when the user gives you ANY Google Drive or Docs link and you do NOT have SA configured. ' +
        'Only fall back to gdrive_read_file / gdrive_setup when the file is private (403).',
      inputSchema: {
        type: 'object',
        required: ['url_or_id'],
        properties: {
          url_or_id: { type: 'string', description: 'Full Google Sheets/Drive URL or the bare file ID' },
          gid:       { type: 'string', description: 'Sheet/tab gid for CSV export (Google Sheets only; default first tab)' },
          max_chars: { type: 'number', description: 'Max chars to return (default 8000)' },
        },
      },
      handler: async ({ url_or_id, gid, max_chars = 8000 }) => {
        const id = parseFileId(url_or_id);
        if (!id) return { error: 'Не смог извлечь file ID из ввода', input: url_or_id };

        // Detect raw Drive file vs Google Sheet by URL pattern.
        const urlStr = String(url_or_id);
        const isRawDriveFile = /drive\.google\.com\/file\//i.test(urlStr) ||
          /drive\.usercontent\.google\.com/i.test(urlStr);
        const isGoogleSheet = /docs\.google\.com\/spreadsheets/i.test(urlStr);

        // Raw Drive file (e.g. xlsx uploaded to Drive) — download binary, parse.
        if (isRawDriveFile && !isGoogleSheet) {
          try {
            const downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
            const r = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) });
            if (r.status === 403 || r.status === 401) {
              return { error: 'private_file', message: 'Файл не публичный (403). Нужен gdrive_setup — расшарь файл с SA email.' };
            }
            if (!r.ok) throw new Error(`Download ${r.status}`);
            const ct = r.headers.get('content-type') || '';
            if (ct.includes('text/html')) {
              return { error: 'html_response', message: 'Google Drive вернул HTML-страницу (возможно требует подтверждения или файл приватный). Попробуй gdrive_setup.' };
            }
            const buf = Buffer.from(await r.arrayBuffer());
            const text = parseXlsxToText(buf);
            const truncated = text.length > max_chars;
            return {
              file_id: id,
              source: 'drive_file_download',
              csv: truncated ? text.slice(0, max_chars) : text,
              csv_truncated: truncated,
              hyperlinks: [],
              hyperlink_count: 0,
            };
          } catch (e) {
            return { error: `download_failed: ${e.message}` };
          }
        }

        const base = `https://docs.google.com/spreadsheets/d/${id}/export`;

        // CSV — visible cell text (fast, but drops in-cell hyperlinks).
        let csv = '', csvError = null;
        try {
          const csvUrl = `${base}?format=csv${gid ? `&gid=${encodeURIComponent(gid)}` : ''}`;
          const r = await fetch(csvUrl, { signal: AbortSignal.timeout(15000) });
          if (r.status === 403 || r.status === 401) {
            return { error: 'private_file', message: 'Файл не публичный (403). Это приватный файл — нужен gdrive_setup: расшарь его с SA email (gdrive_status покажет email).' };
          }
          if (!r.ok) throw new Error(`CSV ${r.status}`);
          csv = await r.text();
        } catch (e) { csvError = e.message; }

        // XLSX — preserves in-cell hyperlinks.
        let hyperlinks = [], linkError = null;
        try {
          const r = await fetch(`${base}?format=xlsx`, { signal: AbortSignal.timeout(20000) });
          if (!r.ok) throw new Error(`XLSX ${r.status}`);
          hyperlinks = extractXlsxHyperlinks(Buffer.from(await r.arrayBuffer()));
        } catch (e) { linkError = e.message; }

        const truncated = csv.length > max_chars;
        return {
          file_id: id,
          csv: truncated ? csv.slice(0, max_chars) : csv,
          csv_truncated: truncated,
          hyperlinks,
          hyperlink_count: hyperlinks.length,
          ...(csvError ? { csv_error: csvError } : {}),
          ...(linkError ? { hyperlink_error: linkError } : {}),
        };
      },
    },

    gdrive_public_folder: {
      description: 'List files in a PUBLIC Google Drive folder (shared "anyone with the link") — NO Service Account needed.\n\n' +
        'Use this when the user shares a Drive FOLDER link (drive.google.com/drive/folders/…). ' +
        'Returns a list of files with their IDs and names. After getting the list, use gdrive_public_sheet to read individual xlsx/csv files.',
      inputSchema: {
        type: 'object',
        required: ['folder_url_or_id'],
        properties: {
          folder_url_or_id: { type: 'string', description: 'Google Drive folder URL or folder ID' },
        },
      },
      handler: async ({ folder_url_or_id }) => {
        const urlStr = String(folder_url_or_id);
        // Extract folder ID from URL like drive.google.com/drive/folders/{id} or drive.google.com/drive/u/0/folders/{id}
        const fmatch = urlStr.match(/\/folders\/([A-Za-z0-9_-]{20,})/) || urlStr.match(/^([A-Za-z0-9_-]{20,})$/);
        const folderId = fmatch ? fmatch[1] : null;
        if (!folderId) return { error: 'Не смог извлечь folder ID из ввода', input: folder_url_or_id };

        // Try listing via SA if available, otherwise explain the limitation.
        const sa = parseSaJson();
        if (sa) {
          try {
            const q = `'${folderId}' in parents and trashed=false`;
            const fields = 'files(id,name,mimeType,size,modifiedTime,webViewLink)';
            const data = await driveApi('GET', `/drive/v3/files?pageSize=50&fields=${encodeURIComponent(fields)}&q=${encodeURIComponent(q)}&supportsAllDrives=true&includeItemsFromAllDrives=true`, null, sa);
            return {
              folder_id: folderId,
              files: data.files?.map(f => ({
                id: f.id, name: f.name, type: f.mimeType,
                size_kb: f.size ? Math.round(f.size / 1024) : null,
                modified: f.modifiedTime, url: f.webViewLink,
              })) ?? [],
              count: data.files?.length ?? 0,
            };
          } catch (e) {
            return { error: e.message, folder_id: folderId };
          }
        }

        // No SA — Drive API requires auth even for public folders.
        // Return a helpful message with the folder ID so the user can open it.
        return {
          folder_id: folderId,
          files: null,
          note: 'Google Drive API требует аутентификацию для листинга папок даже у публичных. ' +
            'Запусти gdrive_setup один раз и расшарь эту папку с SA email — после этого gdrive_list_files заработает. ' +
            'Если знаешь ID конкретного файла внутри — можешь попробовать gdrive_public_sheet(file_id).',
          folder_url: `https://drive.google.com/drive/folders/${folderId}`,
        };
      },
    },

    gdrive_read_file: {
      description: 'Read content of a Drive file (requires gdrive_setup / SA access). ' +
        'Supports: Google Docs → plain text, Google Sheets → CSV, Excel .xlsx/.xlsm → parsed CSV (all sheets), plain text/CSV/JSON/HTML/Markdown → as is. ' +
        'IMPORTANT: ALWAYS try this tool for Excel files — never say "I can\'t read Excel". ' +
        'For old .xls format, suggest the user open it in Google Sheets first. ' +
        'NOTE: for public files without SA, use gdrive_public_sheet (for file URLs) or gdrive_public_folder (for folders).',
      inputSchema: {
        type: 'object',
        required: ['file_id'],
        properties: {
          file_id:   { type: 'string', description: 'File ID from Drive URL or list result' },
          max_chars: { type: 'number', description: 'Max chars to return (default 8000)' },
        },
      },
      handler: async ({ file_id, max_chars = 8000 }) => {
        const sa   = requireSa();
        const meta = await driveApi('GET', `/drive/v3/files/${file_id}?fields=id,name,mimeType,size&supportsAllDrives=true`, null, sa);
        const mime = meta.mimeType;
        let content;
        if (EXCEL_MIMES.has(mime)) {
          const buf = await downloadFileBuffer(file_id, sa);
          content = parseXlsxToText(buf);
        } else if (mime === 'application/vnd.ms-excel') {
          return {
            error: 'Формат .xls (старый Excel) не поддерживается напрямую.',
            hint: 'Открой файл в Drive → правый клик → Открыть с помощью → Google Таблицы. Затем вызови gdrive_read_file с ID новой таблицы.',
            file_id, name: meta.name, mime_type: mime,
          };
        } else if (MIME_READABLE[mime] === null) {
          content = await downloadFile(file_id, sa);
        } else if (MIME_READABLE[mime]) {
          content = await exportFile(file_id, MIME_READABLE[mime], sa);
        } else {
          return { error: `Тип файла не поддерживается: ${mime}`, supported: 'Google Docs, Sheets, Excel (.xlsx/.xlsm), Slides, text, CSV, JSON, HTML, Markdown' };
        }
        const truncated = content.length > max_chars;
        return { file_id, name: meta.name, mime_type: mime, content: truncated ? content.slice(0, max_chars) : content, truncated, total_chars: content.length };
      },
    },

    gdrive_docs_get_structure: {
      description: 'Read the STRUCTURE of a Google Doc (headings, paragraphs, list items) with precise Docs-API character indices — for PRECISE editing that does not touch formatting. ' +
        'Use this before gdrive_docs_insert_text: find the paragraph you want to anchor to (a heading or an existing line), then pass its endIndex (or the next paragraph\'s startIndex) as the insert location. ' +
        'Unlike gdrive_read_file (which flattens the doc to plain text and is safe only for READING), this never modifies the file.',
      inputSchema: {
        type: 'object',
        required: ['file_id'],
        properties: {
          file_id: { type: 'string', description: 'Google Doc file ID' },
        },
      },
      handler: async ({ file_id }) => {
        const sa  = requireSa();
        const doc = await docsApi('GET', `/documents/${file_id}`, null, sa);
        const paragraphs = flattenDocStructure(doc).filter(p => p.text.trim() !== '' || p.style !== 'NORMAL_TEXT');
        return {
          file_id,
          title: doc.title,
          paragraphs: paragraphs.map(p => ({
            start_index: p.startIndex,
            end_index: p.endIndex,
            style: p.style,       // e.g. HEADING_1, HEADING_2, NORMAL_TEXT
            bullet: p.bullet,
            text: p.text,
          })),
        };
      },
    },

    gdrive_search: {
      description: 'Search files in Google Drive by name or full-text content.',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query:     { type: 'string', description: 'Search query — name or content' },
          folder_id: { type: 'string', description: 'Limit to this folder (optional)' },
          limit:     { type: 'number', description: 'Max results (default 20)' },
        },
      },
      handler: async ({ query, folder_id, limit = 20 }) => {
        const sa      = requireSa();
        const n       = Math.min(limit || 20, 50);
        const escaped = query.replace(/'/g, "\\'");
        let q         = `(name contains '${escaped}' or fullText contains '${escaped}') and trashed=false`;
        if (folder_id) q += ` and '${folder_id.replace(/'/g, '')}' in parents`;
        const fields  = 'files(id,name,mimeType,size,modifiedTime,webViewLink)';
        const data    = await driveApi('GET', `/drive/v3/files?pageSize=${n}&fields=${encodeURIComponent(fields)}&q=${encodeURIComponent(q)}&supportsAllDrives=true&includeItemsFromAllDrives=true`, null, sa);
        return {
          query,
          results: data.files?.map(f => ({ id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime, url: f.webViewLink })) ?? [],
          count: data.files?.length ?? 0,
        };
      },
    },

    gdrive_create_file: {
      description: 'Create a new text file in a Drive folder shared with your SA.',
      inputSchema: {
        type: 'object',
        required: ['name', 'content'],
        properties: {
          name:      { type: 'string', description: 'File name (e.g. report.txt)' },
          content:   { type: 'string', description: 'Text content' },
          folder_id: { type: 'string', description: 'Parent folder ID (optional)' },
        },
      },
      handler: async ({ name, content, folder_id }) => {
        const sa      = requireSa();
        const token   = await getAccessToken(sa);
        const metadata = { name, mimeType: 'text/plain' };
        if (folder_id) metadata.parents = [folder_id];
        const boundary = 'gdrive_mcp_boundary';
        const body = [
          `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
          `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', content, `--${boundary}--`,
        ].join('\r\n');
        const res = await fetch(
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
            body, signal: AbortSignal.timeout(15000),
          }
        );
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(`Create ${res.status}: ${err.error?.message || res.statusText}`); }
        const file = await res.json();
        return { created: true, file_id: file.id, name: file.name, url: file.webViewLink };
      },
    },

    // mimeTypes that render rich formatting Drive would silently flatten on a
    // plain-text media overwrite: headings, bold/italic runs, lists, tables all
    // become one plain-text blob. Never allow gdrive_update_file on these —
    // gdrive_docs_insert_text (index-based) is the safe alternative for Docs.
    gdrive_update_file: {
      description: 'Overwrite content of an existing PLAIN file (.txt, .csv, .json, .md) in Google Drive. ' +
        'REFUSES on native Google Docs/Sheets/Slides — a media overwrite flattens the whole file to plain text and destroys all formatting (headings, bold, lists, tables). ' +
        'For a Google Doc, use gdrive_docs_get_structure + gdrive_docs_insert_text instead (precise, index-based, preserves formatting).',
      inputSchema: {
        type: 'object',
        required: ['file_id', 'content'],
        properties: {
          file_id: { type: 'string', description: 'File ID to update' },
          content: { type: 'string', description: 'New text content' },
        },
      },
      handler: async ({ file_id, content }) => {
        const sa   = requireSa();
        const meta = await driveApi('GET', `/drive/v3/files/${file_id}?fields=id,name,mimeType&supportsAllDrives=true`, null, sa);
        const FORMATTED_MIMES = new Set([
          'application/vnd.google-apps.document',
          'application/vnd.google-apps.spreadsheet',
          'application/vnd.google-apps.presentation',
        ]);
        if (FORMATTED_MIMES.has(meta.mimeType)) {
          throw new Error(
            `Отказ: "${meta.name}" — это нативный Google ${meta.mimeType.split('.').pop()}, а не plain-text файл. ` +
            'gdrive_update_file перезапишет его как один текстовый блок и уничтожит всё форматирование (заголовки, списки, таблицы, жирный/курсив). ' +
            'Для Google Docs используй gdrive_docs_get_structure + gdrive_docs_insert_text — точечная вставка по индексу, не трогает остальной документ.'
          );
        }
        const token = await getAccessToken(sa);
        const res   = await fetch(
          `https://www.googleapis.com/upload/drive/v3/files/${file_id}?uploadType=media&fields=id,name,modifiedTime&supportsAllDrives=true`,
          {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain; charset=UTF-8' },
            body: content, signal: AbortSignal.timeout(15000),
          }
        );
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(`Update ${res.status}: ${err.error?.message || res.statusText}`); }
        const file = await res.json();
        return { updated: true, file_id: file.id, name: file.name, modified: file.modifiedTime };
      },
    },

    gdrive_docs_insert_text: {
      description: 'Insert text into a Google Doc at a PRECISE character index, without touching the rest of the document — formatting, headings, tables, images elsewhere are untouched. ' +
        'This is the PRECISE alternative to gdrive_update_file (which overwrites the whole doc as plain text and destroys all native formatting — never use gdrive_update_file on a real Google Doc that has headings/bold/lists/tables). ' +
        'Workflow: 1) call gdrive_docs_get_structure to find the anchor paragraph and its index range. 2) Pass index = anchor paragraph\'s end_index - 1 to insert as a new line right after that paragraph (inherits ITS style — good for adding a list item after another item). ' +
        'Pass index = the NEXT paragraph\'s start_index to insert as a new first line of the section below a heading (inherits the body-text style, not the heading style). ' +
        'Always prefix text with "\\n" unless you intend to merge into the existing line.',
      inputSchema: {
        type: 'object',
        required: ['file_id', 'index', 'text'],
        properties: {
          file_id: { type: 'string', description: 'Google Doc file ID' },
          index:   { type: 'number', description: 'Docs API character index to insert at (from gdrive_docs_get_structure)' },
          text:    { type: 'string', description: 'Text to insert (include a leading \\n to start a new paragraph/list item)' },
        },
      },
      handler: async ({ file_id, index, text }) => {
        const sa = requireSa();
        const resp = await docsApi('POST', `/documents/${file_id}:batchUpdate`, {
          requests: [{ insertText: { location: { index }, text } }],
        }, sa);
        return { inserted: true, file_id, index, chars_inserted: text.length, reply: resp.replies?.[0] ?? null };
      },
    },

    gdrive_create_spreadsheet: {
      description: 'Create a Google Spreadsheet in an explicitly supplied Shared Drive folder writable by the current service account. Service accounts cannot own files in personal My Drive. Creation is not idempotent: do not blindly retry after a timeout.',
      inputSchema: {
        type: 'object', required: ['title', 'folder_id'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          folder_id: { type: 'string', description: 'Isolated test Shared Drive folder ID (not a personal My Drive folder)' },
        },
      },
      handler: async ({ title, folder_id } = {}) => {
        if (typeof title !== 'string' || !title.trim() || title.length > 200 || !/^[A-Za-z0-9_-]{1,200}$/.test(folder_id || '')) {
          throw sheetError('SHEETS_INVALID_INPUT', 'Expected title and folder_id');
        }
        const sa = requireSa();
        const folder = await driveApi('GET', `/drive/v3/files/${folder_id}?supportsAllDrives=true&fields=id,mimeType,driveId,capabilities(canAddChildren)`, null, sa);
        if (folder.mimeType !== 'application/vnd.google-apps.folder' || !folder.driveId || !folder.capabilities?.canAddChildren) {
          throw sheetError('SHEETS_FOLDER_UNAVAILABLE', 'Expected a writable Shared Drive folder for the isolated service account');
        }
        const file = await driveApi('POST', '/drive/v3/files?supportsAllDrives=true&fields=id,name,webViewLink', {
          name: title, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [folder_id],
        }, sa);
        if (!file.id) throw sheetError('SHEETS_OUTCOME_UNKNOWN', 'creation returned without spreadsheet ID; inspect the isolated folder before retrying');
        return { created: true, spreadsheet_id: file.id, title: file.name || title, url: file.webViewLink || `https://docs.google.com/spreadsheets/d/${file.id}` };
      },
    },

    gdrive_read_sheet: {
      description: 'Read literal/evaluated values from a private Google Spreadsheet tab and bounded A1 range using the current service account. Use this to verify the specific result tab after writing; no public sharing is needed.',
      inputSchema: {
        type: 'object', required: ['spreadsheet_id', 'sheet_name'],
        properties: {
          spreadsheet_id: { type: 'string' },
          sheet_name: { type: 'string', description: 'Exact tab title, including spaces or apostrophes' },
          range: { type: 'string', default: 'A1:Z1000', description: 'Bounded A1 cell or rectangle without tab prefix; maximum 50000 cells' },
        },
      },
      handler: async ({ spreadsheet_id, sheet_name, range = 'A1:Z1000' } = {}) => {
        validateSheetTarget(spreadsheet_id, sheet_name);
        validateSheetRange(range);
        const data = await readSheetValues(spreadsheet_id, sheet_name, range, requireSa());
        return { spreadsheet_id, sheet_name, range: data.range, values: data.values || [], row_count: data.values?.length || 0 };
      },
    },

    gdrive_write_sheet: {
      description: 'Write rows to a specific tab (sheet) in a Google Spreadsheet. Creates the tab if it does not exist. ' +
        'Use this to save structured data (participants, results, reports) directly into a Google Sheet. ' +
        'rows is an array of arrays — first row should be the header.\n\n' +
        'Supply operationId for reconcile-safe result writes: a new immutable tab, literal cells and receipt are committed atomically; repeats verify instead of rewriting. Existing tabs are refused in this mode. Set source_sheet_name to guard against selecting the source tab. Without operationId the legacy USER_ENTERED/clear_first defaults are preserved.\n\n' +
        'Example: gdrive_write_sheet({ spreadsheet_id: "1abc...", sheet_name: "Lingerie Show", rows: [["Компания","Сайт","Целевая"],["Рога и копыта","rogaikopyta.ru","Да"]] })',
      inputSchema: {
        type: 'object',
        required: ['spreadsheet_id', 'sheet_name', 'rows'],
        properties: {
          spreadsheet_id: { type: 'string', description: 'Google Spreadsheet ID' },
          sheet_name:     { type: 'string', description: 'Tab name to write to (created if missing)' },
          rows:           { type: 'array',  description: 'Array of rows; each row is array of cell values. First row = header.' },
          clear_first:    { type: 'boolean', description: 'Clear existing data in the tab before writing (default true)' },
          operationId:    { type: 'string', description: 'Stable logical write ID; enables immutable new-tab writes with reconciliation and readback' },
          source_sheet_name: { type: 'string', description: 'Protected source tab; must differ from sheet_name' },
        },
      },
      handler: async ({ spreadsheet_id, sheet_name, rows, clear_first = true, operationId, source_sheet_name }) => {
        if (!spreadsheet_id || !sheet_name || !Array.isArray(rows) || rows.length === 0) {
          return { error: 'Нужны: spreadsheet_id, sheet_name, rows (непустой массив)' };
        }
        if (source_sheet_name !== undefined && source_sheet_name === sheet_name) {
          throw sheetError('SHEETS_SOURCE_PROTECTED', 'Result tab must differ from source_sheet_name');
        }
        const sa = requireSa();
        if (operationId !== undefined) return writeSheetOperation({ spreadsheet_id, sheet_name, rows, operationId }, sa);

        // 1. Get existing sheets to check if tab exists
        const meta = await sheetsApi('GET', `/spreadsheets/${spreadsheet_id}?fields=sheets.properties`, null, sa);
        const sheets = meta.sheets || [];
        const existing = sheets.find(s => s.properties?.title === sheet_name);

        let sheetId;
        if (!existing) {
          // 2. Create new tab
          const resp = await sheetsApi('POST', `/spreadsheets/${spreadsheet_id}:batchUpdate`, {
            requests: [{ addSheet: { properties: { title: sheet_name } } }],
          }, sa);
          sheetId = resp.replies?.[0]?.addSheet?.properties?.sheetId;
        } else {
          sheetId = existing.properties.sheetId;
          if (clear_first) {
            await sheetsApi('POST', `/spreadsheets/${spreadsheet_id}/values/${encodeURIComponent(quotedSheet(sheet_name))}:clear`, {}, sa);
          }
        }

        // 3. Write data
        const range = `${quotedSheet(sheet_name)}!A1`;
        await sheetsApi('PUT', `/spreadsheets/${spreadsheet_id}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
          values: rows,
        }, sa);

        return {
          written: true,
          spreadsheet_id,
          sheet_name,
          rows_written: rows.length,
          tab_created: !existing,
          url: `https://docs.google.com/spreadsheets/d/${spreadsheet_id}`,
        };
      },
    },

    gdrive_delete_file: {
      description: 'Move a file to trash in Google Drive. Pass permanent:true to delete forever.',
      inputSchema: {
        type: 'object',
        required: ['file_id'],
        properties: {
          file_id:   { type: 'string', description: 'File ID to delete' },
          permanent: { type: 'boolean', description: 'Permanently delete (default false = trash)' },
        },
      },
      handler: async ({ file_id, permanent = false }) => {
        const sa = requireSa();
        if (permanent) {
          await driveApi('DELETE', `/drive/v3/files/${file_id}?supportsAllDrives=true`, null, sa);
          return { deleted: true, file_id, permanent: true };
        }
        await driveApi('PATCH', `/drive/v3/files/${file_id}?supportsAllDrives=true`, { trashed: true }, sa);
        return { trashed: true, file_id };
      },
    },

  },
};
