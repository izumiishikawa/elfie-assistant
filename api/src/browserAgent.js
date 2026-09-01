import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const profileDir = resolve(__dirname, '..', 'browser-profile');

function isHeadless() {
  return (process.env.BROWSER_HEADLESS ?? 'true').toLowerCase() !== 'false';
}

const extensionsDir = resolve(__dirname, '..', 'browser-extensions');

function findExtensionPaths() {
  if (!existsSync(extensionsDir)) return [];
  return readdirSync(extensionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(extensionsDir, e.name))
    .filter((dir) => existsSync(join(dir, 'manifest.json')));
}

function extensionLaunchArgs() {
  const paths = findExtensionPaths();
  if (paths.length === 0) return [];
  const joined = paths.join(',');
  return [`--disable-extensions-except=${joined}`, `--load-extension=${joined}`];
}

const MAX_CHARS = 4000;
function truncate(s) {
  return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n\n[...truncated]` : s;
}

let _contextPromise = null;
let _page = null;
let _refMap = new Map();

async function getContext() {
  if (!_contextPromise) {
    _contextPromise = chromium.launchPersistentContext(profileDir, {
      headless: isHeadless(),
      viewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', ...extensionLaunchArgs()],
    });
    _contextPromise
      .then((context) => {
        context.on('close', () => {
          _contextPromise = null;
          _page = null;
        });
      })
      .catch(() => {
        _contextPromise = null;
      });
  }
  return _contextPromise;
}

async function getPage() {
  const context = await getContext();
  if (!_page || _page.isClosed()) {
    _page = context.pages()[0] ?? await context.newPage();
  }
  return _page;
}

export async function closeBrowserAgent() {
  if (!_contextPromise) return;
  try {
    await (await _contextPromise).close();
  } catch (err) {
    console.error('[browserAgent] close failed:', err.message);
  }
}

async function tagFrameElements(frame) {
  try {
    return await frame.evaluate(() => {
      document.querySelectorAll('[data-elfie-ref]').forEach((el) => el.removeAttribute('data-elfie-ref'));
      const baseSelector = 'a, button, input, textarea, select, video, [role="button"], [role="link"], [role="checkbox"], [onclick]';
      const candidates = new Set(document.querySelectorAll(baseSelector));
      document.querySelectorAll('div, span, i, svg').forEach((el) => {
        if (getComputedStyle(el).cursor === 'pointer') candidates.add(el);
      });
      const visible = Array.from(candidates).filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
      const ICON_HINTS = ['play', 'pause', 'mute', 'volume', 'fullscreen', 'next', 'prev', 'skip', 'close', 'search', 'menu'];
      return visible.map((el, i) => {
        el.setAttribute('data-elfie-ref', String(i));
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || tag;
        const inputType = tag === 'input' ? (el.getAttribute('type') || 'text') : null;
        let text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || '')
          .trim().replace(/\s+/g, ' ').slice(0, 80);
        if (!text) {
          const cls = (el.className || '').toString().toLowerCase();
          const hint = ICON_HINTS.find((h) => cls.includes(h));
          if (hint) text = `(ícone: ${hint})`;
        }
        return { ref: i, tag, role, inputType, text };
      });
    });
  } catch {
    return [];
  }
}

async function describeCurrentPage(page) {
  const title = await page.title().catch(() => '');
  const url = page.url();
  const frames = page.frames()
    .filter((f) => f.url() && f.url() !== 'about:blank')
    .slice(0, 12);

  const refMap = new Map();
  let nextRef = 0;
  const sections = [];
  for (const frame of frames) {
    const items = await tagFrameElements(frame);
    if (items.length === 0) continue;
    const label = frame === page.mainFrame() ? 'página principal' : `iframe: ${frame.url().slice(0, 70)}`;
    const lines = items.map((it) => {
      const g = nextRef++;
      refMap.set(g, { frame, localRef: it.ref });
      return `[${g}] ${it.inputType ? `input[${it.inputType}]` : it.role}: ${it.text || '(sem texto)'}`;
    });
    sections.push(`${label}:\n${lines.join('\n')}`);
  }
  _refMap = refMap;

  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 1500) ?? '').catch(() => '');
  return truncate(
    `URL: ${url}\nTítulo: ${title}\n\n`
    + `Elementos interativos (use o [n] como ref em browser_click/browser_type — inclui elementos `
    + `dentro de iframes, comuns em players de vídeo incorporados):\n${sections.join('\n\n') || '(nenhum encontrado)'}\n\n`
    + `Texto da página:\n${bodyText}`,
  );
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(700);
}

export async function browserNavigate({ url }) {
  if (!url) throw new Error('url is required.');
  const page = await getPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await settle(page);
  return describeCurrentPage(page);
}

export async function browserReadPage() {
  const page = await getPage();
  return describeCurrentPage(page);
}

function resolveRef(ref) {
  const target = _refMap.get(ref);
  if (!target) throw new Error(`ref ${ref} not found — it may be stale, read the page again first.`);
  return target;
}

export async function browserClick({ ref }) {
  if (ref === undefined || ref === null) throw new Error('ref is required.');
  const page = await getPage();
  const { frame, localRef } = resolveRef(ref);
  await frame.click(`[data-elfie-ref="${localRef}"]`, { timeout: 8000 });
  await settle(page);
  return describeCurrentPage(page);
}

export async function browserType({ ref, text, submit }) {
  if (ref === undefined || ref === null) throw new Error('ref is required.');
  if (text === undefined) throw new Error('text is required.');
  const page = await getPage();
  const { frame, localRef } = resolveRef(ref);
  const selector = `[data-elfie-ref="${localRef}"]`;
  await frame.fill(selector, text, { timeout: 8000 });
  if (submit) await frame.press(selector, 'Enter');
  await settle(page);
  return describeCurrentPage(page);
}

export async function browserScroll({ direction }) {
  const page = await getPage();
  const dy = direction === 'up' ? -800 : 800;
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(300);
  return describeCurrentPage(page);
}

export async function browserGoBack() {
  const page = await getPage();
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await settle(page);
  return describeCurrentPage(page);
}

export async function browserScreenshot() {
  const page = await getPage();
  return page.screenshot({ type: 'jpeg', quality: 85 });
}
