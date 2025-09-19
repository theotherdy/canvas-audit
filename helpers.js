import { chromium } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { URL } from 'node:url';
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

/* ---------- Canvas pagination helper ---------------- */
export async function fetchAll(firstUrl) {
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

/* --- Decode the url= parameter: --- */
export async function extractPanoptoSessionGuids(page) {
  //console.log("🔎 Page:", page);
  const guids = new Set();

  const allFrames = page.frames();
  console.log("🔎 All frames:", allFrames.map(f => f.url()));
  
  // Grab all Panopto iframes
  const frames = page.frames().filter(f => f.url().includes("panopto"));
  console.log("🔎 Panopto frames:", frames.map(f => f.url()));
  for (const f of frames) {
    try {
      const bodyHtml = await f.content();
      const matches = [...bodyHtml.matchAll(/Embed\.aspx[^"']*id=([0-9a-f-]{36})/ig)];
      matches.forEach(m => guids.add(m[1]));
    } catch (e) {
      console.warn("Panopto iframe parse failed:", e.message);
    }
  }

  return [...guids];
}

/**
 * Get active student IDs for a course
 * (filters out concluded, dropped, and duplicates across sections).
 *
 * @param {string} courseId
 * @param {string} canvasDomain
 * @param {string} token
 * @returns {Promise<Set<number>>}
 */
export async function getActiveStudentSet(courseId, canvasDomain, token) {
  async function fetchAll(url) {
    const out = [];
    let nextUrl = url;
    const next = /<([^>]+)>;\s*rel="next"/;

    while (nextUrl) {
      const res = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} ← ${nextUrl}`);

      const data = await res.json();
      out.push(...data);

      const link = res.headers.get("Link");
      nextUrl = link && next.test(link) ? next.exec(link)[1] : null;
    }
    return out;
  }

  const rows = await fetchAll(
    `${canvasDomain}/api/v1/courses/${courseId}/enrollments?type[]=StudentEnrollment&per_page=100`
  );

  return new Set(
    rows
      .filter(
        e => e.type === "StudentEnrollment" && e.enrollment_state === "active"
      )
      .map(e => e.user_id)
  );
}

/**
 * Get wiki page slugs a student has viewed in a given course,
 * using the web endpoint /courses/:id/users/:id/usage.json
 *
 * @param {object} page Playwright Page (authenticated context)
 * @param {string|number} courseId
 * @param {string|number} userId
 * @returns {Promise<Set<string>>}
 */
export async function getStudentPageUsageWeb(page, courseId, userId, canvasDomain) {
  try {
    const url = `${canvasDomain}/courses/${courseId}/users/${userId}/usage.json`;
    const res = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (!res) {
      console.warn(`⚠️ no response from ${url}`);
      return new Set();
    }
    const body = await res.text();
    //console.log(body);
    const rows = JSON.parse(body);

    const slugs = new Set();
    for (const row of rows) {
      if (row.asset_group_code?.includes(`course_${courseId}_wiki_page`)) {
        const m = row.asset_code.match(/course_\d+_wiki_page_(.+)$/);
        if (m) slugs.add(m[1]);
      }
    }
    return slugs;
  } catch (e) {
    console.warn(`⚠️ usage.json fetch failed for student ${userId} in course ${courseId}:`, e.message);
    return new Set();
  }
}

/**
 * Run async tasks with limited concurrency
 *
 * @param {Array<Function>} tasks - array of functions returning a Promise
 * @param {number} limit - max number of concurrent tasks
 * @returns {Promise<Array>}
 */
export async function runWithConcurrency(tasks, limit = 5) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const current = idx++;
      try {
        results[current] = await tasks[current]();
      } catch (e) {
        console.warn("⚠️ Task failed:", e.message);
        results[current] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}





