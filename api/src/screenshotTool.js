import { chromium } from "playwright";

// Own single-page, fire-and-forget Chromium instance — separate from browserAgent.js's
// persistent, click/type-driven session. Shared by chats.controller.js (browse_screenshot)
// and inworldRealtime.js (same tool, wired into the Inworld voice bridge).
let _browserPromise = null;
function getBrowser() {
  if (!_browserPromise) {
    _browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  }
  return _browserPromise;
}

// No SIGTERM/SIGINT handler here — this module is imported into the same process as
// chats.controller.js (both loaded by api/server.js), whose existing shutdown handler
// calls closeScreenshotBrowser() below before process.exit(). A second independent
// handler here would race that one: process.exit() doesn't wait for other listeners'
// pending awaits, so whichever handler happened to finish first could kill this
// browser's close() mid-flight.
export async function closeScreenshotBrowser() {
  if (!_browserPromise) return;
  try {
    await (await _browserPromise).close();
  } catch {}
}

export async function executeScreenshot(url, fullPage) {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(url, { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(800);
    return await page.screenshot({ fullPage: !!fullPage, type: "jpeg", quality: 85 });
  } finally {
    await page.close();
  }
}
