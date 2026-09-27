'use strict';

// Google auth for the per-profile Drive Service Account — the one copy shared by
// the gdrive MCP tools (src/mcp-skills/tools/50-gdrive.js) and the Drive watcher
// (src/gdrive/drive-watcher.js, run in core's process via siblingLib).
//
// Each profile gets its own SA in the dedicated GCP project below (it has no org
// policies blocking key creation, unlike the main project). The SA key lives at
// <AGENT_TOKENS_DIR>/<profile>/gdrive, mode 0600. SAs are created/deleted with the
// VM's own credentials (ADC via the metadata server).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { tokensRoot } = require('../data-paths');

const GCP_PROJECT = 'trained-assist-gdrive-sa';
// drive (full) is required: drive.readonly misses externally-shared files.
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
].join(' ');

const profileTokenDir = (profileId) => path.join(tokensRoot(), String(profileId));
const saKeyPath = (profileId) => path.join(profileTokenDir(profileId), 'gdrive');

// ── VM credentials (ADC) — only for SA create/delete ─────────────────────────

async function getAdcToken() {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error(`GCP metadata ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

// ── SA key file ───────────────────────────────────────────────────────────────

/** The profile's SA key JSON, or null when Drive is not set up (or the file is broken). */
function readServiceAccount(profileId) {
  if (!profileId) return null;
  let raw;
  try { raw = fs.readFileSync(saKeyPath(profileId), 'utf8').trim(); } catch { return null; }
  try {
    const sa = JSON.parse(raw);
    return sa && sa.client_email && sa.private_key ? sa : null;
  } catch { return null; }
}

function writeServiceAccount(profileId, saJson) {
  fs.mkdirSync(profileTokenDir(profileId), { recursive: true });
  fs.writeFileSync(saKeyPath(profileId), JSON.stringify(saJson), { mode: 0o600 });
}

function getSaEmail(profileId) {
  const sa = readServiceAccount(profileId);
  return sa ? sa.client_email : null;
}

// ── SA → access token (JWT bearer grant), cached per SA for ~1h ──────────────

const tokenCache = new Map();

function makeJwt(sa, now = Math.floor(Date.now() / 1000)) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPES,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const data = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(data);
  return `${data}.${sign.sign(sa.private_key, 'base64url')}`;
}

async function getAccessToken(sa) {
  const cached = tokenCache.get(sa.client_email);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${makeJwt(sa)}`,
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Google OAuth ошибка: ${JSON.stringify(data)}`);
  tokenCache.set(sa.client_email, { token: data.access_token, expiresAt: Date.now() + 3_600_000 });
  return data.access_token;
}

// ── SA lifecycle ──────────────────────────────────────────────────────────────

// Deletes the profile's GCP Service Account (core's revoke flow calls this).
// Best-effort — errors are returned, not thrown: the local key file is the source of truth.
async function deleteServiceAccount(profileId) {
  const saEmail = getSaEmail(profileId);
  if (!saEmail) return { deleted: false, reason: 'no_sa_configured' };
  let adcToken;
  try { adcToken = await getAdcToken(); }
  catch (e) { return { deleted: false, reason: `adc_error: ${e.message}` }; }
  const url = `https://iam.googleapis.com/v1/projects/${GCP_PROJECT}/serviceAccounts/${encodeURIComponent(saEmail)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${adcToken}` },
    signal: AbortSignal.timeout(10000),
  });
  if (res.ok || res.status === 404) return { deleted: true };
  const err = await res.json().catch(() => ({}));
  return { deleted: false, reason: `gcp_${res.status}: ${err.error?.message || res.statusText}` };
}

module.exports = {
  GCP_PROJECT,
  SCOPES,
  profileTokenDir,
  saKeyPath,
  getAdcToken,
  readServiceAccount,
  writeServiceAccount,
  getSaEmail,
  makeJwt,
  getAccessToken,
  deleteServiceAccount,
};
