import { chromium } from '@playwright/test';
import { promises as fs } from 'node:fs';
import 'dotenv/config';
import fetch from 'node-fetch';

/* ---------- env & constants ------------------------ */
const CANVAS  = process.env.CANVAS_DOMAIN.replace(/\/$/, '');
const CV_PAT  = process.env.CANVAS_TOKEN;

//const PANOPTO = process.env.PANOPTO_DOMAIN.replace(/\/$/, '');
////const PAN_ID  = process.env.PANOPTO_CLIENT_ID;
//const PAN_SEC = process.env.PANOPTO_CLIENT_SECRET;
//const PAN_SC  = (process.env.PANOPTO_SCOPES ||
 //                'sessions.read viewers.read folders.read')
  //               .split(/\s+/);

const delay = ms => new Promise(r => setTimeout(r, ms));

/* ──────────────────────────────────── *
 * 0.  Storage-state bootstrap (Canvas + Panopto cookies)
 * ──────────────────────────────────── */
export async function ensureStorageState({
  canvasDomain,
  storageFile
}) {
  try {
    await fs.access(storageFile);           // already exists
    console.log(`🔒  Using ${storageFile}`);
    return;
  } catch { /* file missing */ }

  console.log(`🔑  First-time run – please sign in …`);
  const browser = await chromium.launch({ headless: false });
  const ctx     = await browser.newContext();
  const page    = await ctx.newPage();

  await page.goto(`${canvasDomain}/login`, { waitUntil: 'domcontentloaded' });

  console.log(
    `   ① Complete SSO for Canvas\n` +
    `   ② Click any Panopto link so cookies initialise\n` +
    `   ③ Close the window → cookies will be saved\n`
  );

  await page.waitForEvent('close', { timeout: 0 });

  await ctx.storageState({ path: storageFile });
  await browser.close();
  console.log(`✅  Saved storage → ${storageFile}\n`);
}

/* ──────────────────────────────────── *
 * 1.  Build Cookie header for Panopto REST
 * ──────────────────────────────────── */
/*export function panoptoCookieHeader(storageObj, panoptoDomain) {
  return storageObj.cookies
    .filter(c => c.domain.includes(new URL(panoptoDomain).hostname))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}*/

/* ---------- generic Canvas fetch with 429-retry ------ */
async function fetchJSON(url, opts = {}) {
  const hdrs = { ...(opts.headers || {}) };
  if (url.startsWith(CANVAS) && CV_PAT)
    hdrs.Authorization = `Bearer ${CV_PAT}`;

  while (true) {
    const res = await fetch(url, { ...opts, headers: hdrs });
    if (res.status !== 429) {
      if (!res.ok)
        throw new Error(`${res.status} ${res.statusText} ← ${url}`);
      return { data: await res.json(), headers: res.headers };
    }
    const retry = +res.headers.get('Retry-After') || 2;
    await delay(retry * 1_000);
  }
}

/* ──────────────────────────────────── *
 * 2.  Pull **all** /viewers pages (pageNumber pagination)
 * ──────────────────────────────────── */
//import fetch from 'node-fetch';

/*export async function fetchAllViewers({
  api,                 // <-- the APIRequestContext
  sessionId,
  pageSize = 100
}) {
  let pageNumber = 0;
  const out = [];
  const headers = {
    // these two lines make the request look like it came from Panopto pages
    Origin : api._options?.baseURL,          // e.g. https://ox.cloud.panopto.eu
    Referer: `${api._options?.baseURL}/Panopto/`
  };

  while (true) {
    const res = await api.get(
      `/Panopto/api/v1/sessions/${sessionId}/viewers` +
      `?pageNumber=${pageNumber}&pageSize=${pageSize}`,
      { headers }
    );
    if (!res.ok())
      throw new Error(`Panopto ${res.status()}: ${await res.text()}`);

    const body = await res.json();
    const rows = Array.isArray(body) ? body : body.Results ?? [];
    out.push(...rows);

    if (rows.length < pageSize) break;        // last page
    pageNumber += 1;
  }
  return out;
}*/

/* ---------- Canvas pagination helper ---------------- */
async function fetchAll(firstUrl) {
  const out   = [];
  let   url   = firstUrl;
  const next  = /<([^>]+)>;\s*rel="next"/;

  while (url) {
    const { data, headers } = await fetchJSON(url);
    out.push(...data);

    const link = headers.get('Link');
    url = link && next.test(link) ? next.exec(link)[1] : null;
  }
  return out;
}

/* ---------- PUBLIC: list all Canvas pages ----------- */
export async function listCanvasPages(courseId) {
  const rows = await fetchAll(
    `${CANVAS}/api/v1/courses/${courseId}/pages?per_page=100`
  );
  return rows.map(p => ({ title: p.title, url: p.url }));  // minimal
}

/**
 * Tries to locate ONE iframe whose src contains "custom_context_delivery".
 * Searches every descendant frame, keeps scrolling until it appears,
 * and retries for up to 30 s.
 *
 * Returns true once the HTML dump happens, false otherwise.
 */
/*export async function dumpPanoptoDebugFrame(page, file = 'panopto_iframe.html') {
  const deadline = Date.now() + 30_000;          // 30 s hard limit
  let alreadyScrolled = false;

  while (Date.now() < deadline) {
    // 1️⃣  Look in the main page and every sub-frame we can reach.
    for (const frame of page.frames()) {
      const handle = await frame.$('iframe[src*="custom_context_delivery"]');
      if (handle) {
        const child = await handle.contentFrame();
        if (!child) continue;                    // not ready yet

        await child.waitForLoadState('domcontentloaded');
        const html = await child.evaluate(() => document.documentElement.outerHTML);

        //console.log('\n===== BEGIN Panopto iframe HTML =====\n');
        //console.log(html);
        //console.log('\n=====  END Panopto iframe HTML  =====\n');

        await fs.writeFile(file, html, 'utf8');
        console.log(`\n📝  Full iframe HTML written to ${file}\n`);

        return true;
      }
    }

    // 2️⃣  If not found, give the page a little nudge:
    //     –> Scroll once to trigger lazy-loading
    //     –> Wait a bit before next pass
    if (!alreadyScrolled) {
      await page.mouse.wheel(0, 400);            // single “page down”
      alreadyScrolled = true;
    }
    await page.waitForTimeout(500);              // short back-off
  }

  console.warn('[Panopto-debug] No iframe with custom_context_delivery found after 30 s');
  return false;
}*/

/** Build an APIRequestContext that re-uses your authStorage.json */
/*export async function panoptoApi({ storageFile, panoptoDomain }) {
  return await pwRequest.newContext({
    baseURL: panoptoDomain,
    storageState: storageFile
  });
}*/

/**
 * Dump the outer HTML of the **main** frame Playwright is on
 * and save it to disk for inspection.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} [file]  destination filename
 */
/*export async function dumpMainFrameHTML(page, file = 'playwright_mainframe.html') {
  const html = await page.content();                 // same as document.documentElement.outerHTML
  await fs.writeFile(file, html);
  console.log(`\n📝  Wrote full page HTML ➜  ${file}\n`);
}*/




