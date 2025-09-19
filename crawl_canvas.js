/*
 * crawl_canvas.js — combined Canvas audit + Panopto session collector
 * -----------------------------------------------------------------
 * One single pass over every course gathers ⤵︎
 *   • core roster info
 *   • page‑level scan for Panopto & H5P embeds
 *   • quiz / assignment counts & submission %
 *   • Panopto <iframe> GUIDs for later analytics
 *
 * Outputs
 *   canvas_course_metrics.csv   (audit metrics)
 *   panopto_session_ids.csv     (courseId,sessionId)
 */
import { chromium }          from '@playwright/test';
import { stringify }         from 'csv-stringify/sync';
import { promises as fs }    from 'node:fs';
import fetch                 from 'node-fetch';
import * as H                from './helpers.js';
import 'dotenv/config';

/* ─── env ------------------------------------------------------------------------------------------------- */
const {
  CANVAS_DOMAIN,
  CANVAS_TOKEN,
  COURSE_IDS,
  PAGE_LIMIT = 0,
  STORAGE_FILE,
  SINGLE_PAGE  // new: optionally specify single page slug to audit
} = process.env;

if (!CANVAS_DOMAIN || !CANVAS_TOKEN || !COURSE_IDS)
  throw new Error('❌  Missing CANVAS_DOMAIN, CANVAS_TOKEN or COURSE_IDS in .env');

const COURSES = COURSE_IDS.split(',').map(s => s.trim());
const PAGE_LIMIT_N = +PAGE_LIMIT;
const SINGLE_PAGE_SLUG = SINGLE_PAGE && SINGLE_PAGE.trim();  

/* ─── tiny logger ----------------------------------------------------------------------------------------- */
function logApi(method, url) {
  console.log(`       ↳ [${method}] ${url}`);
}

/* ─── Canvas REST wrapper -------------------------------------------------------------------------------- */
const API_ROOT = `${CANVAS_DOMAIN}/api/v1`;
async function api(url, qs = '') {
  const full = `${API_ROOT}${url}${qs}`;
  logApi('GET', full);
  const res = await fetch(full, {
    headers: { Authorization: `Bearer ${CANVAS_TOKEN}` }
  });
  if (res.ok) return res.json();

  if (res.status === 404) {
    console.warn(`       ⚠️  404 ${url} – treating as empty`);
    return [];
  }
  const body = await res.text();
  throw new Error(`Canvas ${res.status} – ${body}`);
}

/* ─── metric helpers ------------------------------------------------------------------------------------- */
async function rosterSize(courseId) {
  const activeStudents = await H.getActiveStudentSet(
    courseId,
    CANVAS_DOMAIN,
    CANVAS_TOKEN
  );
  return activeStudents.size;
}

async function listQuizzes(courseId) {
  const all = await api(`/courses/${courseId}/quizzes`, '?per_page=100');
  const classic = all.filter(q => q.published);
  const ass = await api(`/courses/${courseId}/assignments`, '?per_page=100');
  const newQuiz = ass.filter(a => a.submission_types.includes('online_quiz') && a.published);
  return { classic, newQuiz };
}

async function listOtherAssignments(courseId) {
  const ass = await api(`/courses/${courseId}/assignments`, '?per_page=100');
  return ass.filter(a => a.published &&
    !a.submission_types.includes('online_quiz') &&
    !a.submission_types.includes('discussion_topic') &&
    !a.submission_types.includes('external_tool'));
}

async function submissionsPct(items, activeStudentIds) {
  let pctSum = 0;

  for (const it of items) {
    const subs = await H.fetchAll(
      `${CANVAS_DOMAIN}/api/v1/courses/${it.course_id}/assignments/${it.id}/submissions?per_page=100`
    );

    const subsFromActive = subs.filter(s => activeStudentIds.has(s.user_id));
    const done = subsFromActive.filter(
      s => s.workflow_state !== "unsubmitted"
    ).length;

    const denom = activeStudentIds.size || 1;
    pctSum += done / denom;
  }

  return items.length ? ((pctSum / items.length) * 100).toFixed(1) : 0;
}

/* ─── main ----------------------------------------------------------------------------------------------- */
await H.ensureStorageState({ canvasDomain: CANVAS_DOMAIN, storageFile: STORAGE_FILE });
const browser = await chromium.launch({ headless: true });
const ctx     = await browser.newContext({ storageState: STORAGE_FILE });
const page    = await ctx.newPage();

const METRICS = [];    
const SESSION_ROWS = [];

for (const courseId of COURSES) {
  console.log(`\n🧭  Course ${courseId}`);

  /* roster */
  const activeStudents = await H.getActiveStudentSet(courseId, CANVAS_DOMAIN, CANVAS_TOKEN);
  const students = activeStudents.size;
  console.log(`   • students: ${students}`);

  let pages;
  if (SINGLE_PAGE_SLUG) {
    console.log(`   • SINGLE_PAGE set: only processing page slug "${SINGLE_PAGE_SLUG}"`);
    // Build a minimal page object; your process assumes page has .url and maybe .view_count etc
    pages = [ { url: SINGLE_PAGE_SLUG, view_count: 0 /* or null/undefined if not used */ } ];
  } else {
    pages = await H.listCanvasPages(courseId);
    if (PAGE_LIMIT_N) pages = pages.slice(0, PAGE_LIMIT_N);
    console.log(`   • published pages: ${pages.length}`);
  }

  //let viewedTotal = 0;
  //let viewersSum = 0;
  // Build page -> set of student IDs who viewed it
  const pageViewers = {};
  let panoPageCount = 0, panoEmbeds = 0;
  let h5pPageCount  = 0, h5pEmbeds  = 0;
  const sessionSet = new Set();

  for (const p of pages) {
    if (!p.url) continue;
    const url = `${CANVAS_DOMAIN}/courses/${courseId}/pages/${p.url}`;

    /* capture requests made during navigation */
    const reqs = [];
    const h = r => reqs.push(r.url());
    page.on('request', h);

    await page.goto(url, { waitUntil: 'networkidle' });

    page.off('request', h);

    const html = await page.content();

    for (const uid of activeStudents) {
      const slugs = await H.getStudentPageUsageWeb(page, courseId, uid, CANVAS_DOMAIN);
      for (const slug of slugs) {
        if (!pageViewers[slug]) pageViewers[slug] = new Set();
        pageViewers[slug].add(uid);
      }
    }
     
    /* count embeds */
    const h5p  = [...html.matchAll(/h5p(?:\.com|_embed).*?id=([0-9]+)/ig)];

    //console.log(html);
    const panoGuids = await H.extractPanoptoSessionGuids(page);
    if (panoGuids.length) {
      panoPageCount++;
      panoEmbeds += panoGuids.length;
      panoGuids.forEach(id => sessionSet.add(id));
    }
    console.log(`        Panopto: ${panoGuids.length}`);



    if (h5p.length)  { h5pPageCount++;  h5pEmbeds  += h5p.length;  }

    console.log(`      · ${url}`);
    //console.log(`        Panopto: ${pano.length}  H5P: ${h5p.length}`);
  }

  /* quizzes / assignments */
  const { classic, newQuiz } = await listQuizzes(courseId);
  const otherAss = await listOtherAssignments(courseId);

  const classicPct = await submissionsPct(classic, activeStudents);
  const newPct     = await submissionsPct(newQuiz, activeStudents);
  const otherPct   = await submissionsPct(otherAss, activeStudents);

  let totalPct = 0;
  const numPages = Object.keys(pageViewers).length;
  for (const viewers of Object.values(pageViewers)) {
    totalPct += viewers.size / activeStudents.size;
  }

  const meanPercentViewed = numPages
    ? ((totalPct / numPages) * 100).toFixed(1)
    : 0;

  //const pagesViewedPct = pages.length ? ((viewedTotal / pages.length) / students * 100).toFixed(1) : 0;
  /*const pagesViewedPct =
  pages.length && activeStudents.size
    ? ((viewersSum / (pages.length * activeStudents.size)) * 100).toFixed(1)
    : 0;*/

  METRICS.push({
    courseId,
    students,
    pagesPublished: pages.length,
    meanPercentViewed,  
    quizzesClassic: classic.length,
    quizzesNew: newQuiz.length,
    quizzesSubmittedPctClassic: classicPct,
    quizzesSubmittedPctNew: newPct,
    otherAssignments: otherAss.length,
    otherAssignmentsSubmittedPct: otherPct,
    pagesWithPanopto: panoPageCount,
    panoptoVideos: panoEmbeds,
    pagesWithH5P: h5pPageCount,
    h5pItems: h5pEmbeds
  });

  sessionSet.forEach(s => SESSION_ROWS.push({ courseId, sessionId: s }));
}

await browser.close();

await fs.writeFile('canvas_course_metrics.csv', stringify(METRICS, { header: true }));
await fs.writeFile('panopto_session_ids.csv', stringify(SESSION_ROWS, { header: true }));
console.log('\n✅  wrote canvas_course_metrics.csv & panopto_session_ids.csv');
