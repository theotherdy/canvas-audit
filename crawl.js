import { chromium }          from '@playwright/test';
import fetch                 from 'node-fetch';
import { stringify }         from 'csv-stringify/sync';
import { promises as fs }    from 'node:fs';
import * as H                from './helpers.js';
import 'dotenv/config';

/* ── env ------------------------------------------------------------------ */
const {
  COURSE_IDS,
  CANVAS_DOMAIN,
  PANOPTO_DOMAIN,
  PAGE_LIMIT,
  STORAGE_FILE
} = process.env;

const COURSES    = COURSE_IDS.split(',').map(s => s.trim());
const PAGE_LIMIT_N = Number(PAGE_LIMIT || 0);
const OUTPUT     = [];

/* ── one-off login bootstrap --------------------------------------------- */
await H.ensureStorageState({
  canvasDomain: CANVAS_DOMAIN,
  storageFile : STORAGE_FILE
});

const storageObj          = JSON.parse(await fs.readFile(STORAGE_FILE, 'utf8'));
//const cookieHeaderPanopto = H.panoptoCookieHeader(storageObj, PANOPTO_DOMAIN);

const api = await H.panoptoApi({
  storageFile: STORAGE_FILE,
  panoptoDomain: PANOPTO_DOMAIN
});

/* ── crawl each course ---------------------------------------------------- */
for (const courseId of COURSES) {
  console.log(`\n🧭  Crawling course ${courseId}`);

  let pages = await H.listCanvasPages(courseId);        // ← existing helper
  if (PAGE_LIMIT_N) pages = pages.slice(0, PAGE_LIMIT_N);

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ storageState: STORAGE_FILE });
  const page    = await ctx.newPage();

  const sessionIds = new Set();

  ctx.on('requestfinished', req => {
    const m = /Embed\.aspx.*[?&]id=([0-9a-f-]{36})/i.exec(req.url());
    if (m) sessionIds.add(m[1]);
  });

  for (const p of pages) {
    
    const url = `${CANVAS_DOMAIN}/courses/${courseId}/pages/${p.url}`;
    if(url=="https://canvas.ox.ac.uk/courses/262596/pages/neurology"){
      await page.goto(url, { waitUntil: 'networkidle' });
      console.log(url);
    }
  }
  await browser.close();

  console.log(`   → ${sessionIds.size} Panopto sessions`);

  /* ── per-session analytics -------------------------------------------- */
  for (const id of sessionIds) {
    /*const viewers = await H.fetchAllViewers({
      panoptoDomain: PANOPTO_DOMAIN,
      sessionId    : id,
      cookieHeader : cookieHeaderPanopto
    });*/

    const viewers = await H.fetchAllViewers({
      api,
      sessionId: id
    });

    const finished = viewers.filter(v => v.PercentCompleted >= 90).length;
    OUTPUT.push({
      CourseId     : courseId,
      SessionId    : id,
      Viewers      : viewers.length,
      Finished     : finished,
      FinishedPct  : viewers.length
                     ? (finished / viewers.length * 100).toFixed(1)
                     : 0
    });
  }
}

/* ── CSV ------------------------------------------------------------------ */
await fs.writeFile('panopto_engagement.csv',
                   stringify(OUTPUT, { header: true }));
console.log('\n✅  wrote panopto_engagement.csv');
