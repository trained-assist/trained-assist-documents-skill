'use strict';

// One headless-Chromium launcher for every renderer in this repo (deck PDF,
// markdown → PDF). Prefers the system Chrome installed on the VM; falls back to
// the Playwright-managed browser in ~/.cache/ms-playwright.
const fs = require('fs');

const SYSTEM_CHROME = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

function playwright() {
  try { return require('playwright-core'); } catch { return require('playwright'); }
}

async function launchChromium() {
  const executablePath = SYSTEM_CHROME.find(f => fs.existsSync(f));
  return playwright().chromium.launch(executablePath ? { executablePath } : {});
}

// Run fn(browser) and always close the browser, even when fn throws.
async function withChromium(fn) {
  const browser = await launchChromium();
  try { return await fn(browser); } finally { await browser.close(); }
}

module.exports = { launchChromium, withChromium };
