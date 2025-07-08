/* crawl.js — Playwright network crawler */
import { chromium }      from '@playwright/test';
import fetch             from 'node-fetch';
import { stringify }     from 'csv-stringify/sync';
import { promises as fs} from 'node:fs';              // ✅ fixes “fs is not defined”
import * as H            from './helpers.js';
import 'dotenv/config';

const COURSES    = process.env.COURSE_IDS.split(',').map(s => s.trim());
const CANVAS     = process.env.CANVAS_DOMAIN.replace(/\/$/, '');
const PAGE_LIMIT = Number(process.env.PAGE_LIMIT || 0);   // ← point 2

const OUTPUT = [];

for (const courseId of COURSES) {
  console.log(`\n🧭  Crawling Canvas course ${courseId} …`);

  /* 1️⃣ Canvas → pages */
  let pages = await H.listCanvasPages(courseId);
  if (PAGE_LIMIT) pages = pages.slice(0, PAGE_LIMIT);
  console.log(`   • visiting ${pages.length} page(s)`);

  /* 2️⃣ Playwright */
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext();

  const sessionIds = new Set();
  let   dumped     = false;                // dump only once for speed

  /* 3️⃣ watch requests + responses */
  ctx.on('request', req => {               // see outgoing URLs immediately
    const u = req.url();
    if (/Embed\.aspx/i.test(u))
      console.log('      ↳ request:', u);
  });

  ctx.on('requestfinished', async req => { // response is now available
    const u = req.url();
    const m = /Embed\.aspx.*[?&]id=([0-9a-f-]{36})/i.exec(u);
    if (!m) return;

    sessionIds.add(m[1]);

    if (!dumped) {
      dumped = true;
      try {
        const body = await req.response().text();
        console.log('\n===== first iframe response (truncated) =====');
        console.log(body.slice(0, 1500));
        console.log('=============================================\n');
      } catch (e) {
        console.warn('Could not read iframe response body:', e);
      }
    }
  });

  const page = await ctx.newPage();

  /* 4️⃣ visit each Canvas page */
  for (const p of pages) {
    const url = `${CANVAS}/courses/${courseId}/pages/${p.url}`;
    console.log('   •', url);
    await page.goto(url, { waitUntil: 'networkidle' }); // give iframe time
  }

  await browser.close();
  console.log(`   → found ${sessionIds.size} unique Panopto sessions`);

  /* 5️⃣ pull stats inside the same browser context (no OAuth needed) */
  async function fetchViewers(sessionId) {
    return await page.evaluate(async sid => {
      const r = await fetch(`/Panopto/api/v1/sessions/${sid}/viewers`,
                            { credentials: 'include' });
      return r.ok ? await r.json() : [];
    }, sessionId);
  }

  for (const id of sessionIds) {
    const viewers = await fetchViewers(id);
    OUTPUT.push({
      CourseId : courseId,
      SessionId: id,
      Viewers  : viewers.length,
      AvgComp  : viewers.length
                 ? (viewers.reduce((s,v)=>s+v.PercentCompleted,0) /
                    viewers.length).toFixed(1)
                 : 0
    });
  }
}

/* 6️⃣ write CSV */
const csv = stringify(OUTPUT, { header: true });
await fs.writeFile('panopto_engagement.csv', csv);
console.log('\n✅  wrote panopto_engagement.csv');
