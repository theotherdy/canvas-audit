/* crawl.js — Playwright network crawler */
import { chromium }      from '@playwright/test';
import fetch             from 'node-fetch';
import { stringify }     from 'csv-stringify/sync';
import { promises as fs } from 'node:fs';
import * as H            from './helpers.js';
import 'dotenv/config';

const COURSES       = process.env.COURSE_IDS.split(',').map(s => s.trim());
const CANVAS        = process.env.CANVAS_DOMAIN.replace(/\/$/, '');
const PAGE_LIMIT    = Number(process.env.PAGE_LIMIT || 0);
const STORAGE_FILE  = 'canvasStorage.json';          // ← persistent cookies here
const OUTPUT        = [];

/* ──────────────────────────────────────────────────────────── */
/* 0️⃣  Ensure we have an authenticated storage-state file     */
/* ──────────────────────────────────────────────────────────── */
async function ensureStorageState () {
  try {
    await fs.access(STORAGE_FILE);                   // file already present
    console.log(`🔒  Using existing ${STORAGE_FILE}`);
    return;
  } catch { /* file does not exist */ }

  console.log(`🔑  ${STORAGE_FILE} not found – launching login browser…`);
  const browser = await chromium.launch({ headless: false });
  const ctx     = await browser.newContext();
  const page    = await ctx.newPage();

  // open Canvas; you’ll be redirected to SSO – log in manually
  await page.goto(`${CANVAS}/login`, { waitUntil: 'domcontentloaded' });

  console.log('\n🖱️  Please complete login in the opened window.');
  console.log('   When the Canvas dashboard is visible, close the window ');
  console.log('   (or press CTRL-C here) – cookies will be saved.\n');

  // wait until you close the window after logging in
  // • timeout: 0  = no limit  (Playwright waits forever)
  // • or pick a bigger value in ms, e.g. 180_000 for 3 minutes
  await page.waitForEvent('close', { timeout: 0 });
  await ctx.storageState({ path: STORAGE_FILE });
  await browser.close();

  console.log(`✅  Saved storage state ➜  ${STORAGE_FILE}\n`);
}

await ensureStorageState();

/* ──────────────────────────────────────────────────────────── */
/* 1️⃣  Crawl each course                                       */
/* ──────────────────────────────────────────────────────────── */
for (const courseId of COURSES) {
  console.log(`\n🧭  Crawling Canvas course ${courseId} …`);

  /* Canvas → pages */
  let pages = await H.listCanvasPages(courseId);
  if (PAGE_LIMIT) pages = pages.slice(0, PAGE_LIMIT);
  console.log(`   • visiting ${pages.length} page(s)`);

  /* Playwright (authenticated) */
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ storageState: STORAGE_FILE });
  const page    = await ctx.newPage();

  const sessionIds = new Set();
  let   dumped     = false;           // only dump once

  /* watch requests */
  ctx.on('request', req => {
    const u = req.url();
    /*if (/Embed\.aspx/i.test(u))
      console.log('      ↳ request:', u);*/
  });

  ctx.on('requestfinished', req => {
    const m = /Embed\.aspx.*[?&]id=([0-9a-f-]{36})/i.exec(req.url());
    if (m) sessionIds.add(m[1]);
  });

  /* visit Canvas pages (single page for now) */
  for (const p of pages) {
    const url = `${CANVAS}/courses/${courseId}/pages/${p.url}`;
    if (url !== 'https://canvas.ox.ac.uk/courses/262596/pages/neurology')
      continue;

    console.log('   •', url);
    await page.goto(url, { waitUntil: 'networkidle' });

    if (!dumped) {
      await H.dumpMainFrameHTML(page);          // full HTML (debug)
      dumped = await H.dumpPanoptoDebugFrame(page); // try iframe dump
    }
    if (dumped) break;                          // stop after first dump
  }

  /* pull stats inside the same browser context (no OAuth needed) */
  /*async function fetchViewers(sessionId) {
    return await page.evaluate(async sid => {
      const r = await fetch(`/Panopto/api/v1/sessions/${sid}/viewers`,
                            { credentials: 'include' });
      return r.ok ? await r.json() : [];
    }, sessionId);
  }*/

  /*for (const id of sessionIds) {
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
  }*/

  await browser.close();
  console.log(`   → found ${sessionIds.size} unique Panopto sessions`);

    /*****************************************************************
   * 0.  Get an access-token once per run
   *****************************************************************/
  async function getPanoptoToken () {
    console.log(process.env.PANOPTO_CLIENT_SECRET);
    const creds = Buffer.from(
      `${process.env.PANOPTO_CLIENT_ID}:${process.env.PANOPTO_CLIENT_SECRET}`
    ).toString('base64');

    const r = await fetch('https://ox.cloud.panopto.eu/Panopto/oauth2/connect/token', {
      method : 'POST',
      headers: { 'Authorization': `Basic ${creds}`,
                'Content-Type': 'application/x-www-form-urlencoded' },
      body   : 'grant_type=client_credentials&scope=api'
    });
    const { access_token } = await r.json();
    console.log(access_token);
    return access_token;
  }

  const token = await getPanoptoToken();
  

  /*****************************************************************
   * 1.  Fetch per-viewer analytics for every session you found
   *****************************************************************/
  async function fetchViewers(sessionId) {
    const r = await fetch(
      `https://ox.cloud.panopto.eu/Panopto/api/v1/sessions/${sessionId}/viewers`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    return r.ok ? await r.json() : [];
  }

  /*****************************************************************
   * 2.  Aggregate per-course engagement
   *****************************************************************/
  for (const id of sessionIds) {
    const viewers = await fetchViewers(id);

    // pctCompleted is per viewer; consider “finished” ≥ 90 %
    const finished = viewers.filter(v => v.PercentCompleted >= 90).length;

    OUTPUT.push({
      CourseId    : courseId,
      SessionId   : id,
      Viewers     : viewers.length,
      Finished    : finished,
      FinishedPct : viewers.length
                  ? (finished / viewers.length * 100).toFixed(1)
                  : 0
    });
  }

  
}

/* write CSV */
const csv = stringify(OUTPUT, { header: true });
await fs.writeFile('panopto_engagement.csv', csv);
console.log('\n✅  wrote panopto_engagement.csv');
