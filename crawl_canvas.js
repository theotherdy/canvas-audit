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
  STORAGE_FILE
} = process.env;

if (!CANVAS_DOMAIN || !CANVAS_TOKEN || !COURSE_IDS)
  throw new Error('❌  Missing CANVAS_DOMAIN, CANVAS_TOKEN or COURSE_IDS in .env');

const COURSES = COURSE_IDS.split(',').map(s => s.trim());
const PAGE_LIMIT_N = +PAGE_LIMIT;

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
  const enrs = await api(`/courses/${courseId}/enrollments`, '?type[]=StudentEnrollment&per_page=100');
  return new Set(enrs.map(e => e.user_id)).size;
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

async function submissionsPct(items, students) {
  let submitted = 0;
  for (const it of items) {
    const subs = await api(`/courses/${it.course_id}/assignments/${it.id}/submissions`, '?per_page=100');
    const done = subs.filter(s => s.workflow_state !== 'unsubmitted').length;
    submitted += done / students;
  }
  return items.length ? ((submitted / items.length) * 100).toFixed(1) : 0;
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
  const students = await rosterSize(courseId);
  console.log(`   • students: ${students}`);

  /* pages */
  let pages = await H.listCanvasPages(courseId);
  if (PAGE_LIMIT_N) pages = pages.slice(0, PAGE_LIMIT_N);
  console.log(`   • published pages: ${pages.length}`);

  //let viewedTotal = 0;
  let viewersSum = 0;
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

    /* page views – Canvas Page object already returns view_count */
    //if (typeof p.view_count === 'number') viewedTotal += p.view_count ? 1 : 0;
    if (typeof p.view_count === 'number') viewersSum += Math.min(p.view_count, students);

    /* page views (may 404 on older sites) */
    /*try {
      const views = await api(`/courses/${courseId}/pages/${p.url}/views`,
                              '?per_page=100');
      viewersSum += new Set(views.map(v => v.user_id)).size;
    } catch {  }*/

    /* count embeds */
    const pano = [...html.matchAll(/Embed\.aspx[^"']*id=([0-9a-f-]{36})/ig)];
    const h5p  = [...html.matchAll(/h5p(?:\.com|_embed).*?id=([0-9]+)/ig)];

    if (pano.length) { panoPageCount++; panoEmbeds += pano.length; pano.forEach(m => sessionSet.add(m[1])); }
    if (h5p.length)  { h5pPageCount++;  h5pEmbeds  += h5p.length;  }

    console.log(`      · ${url}`);
    console.log(`        Panopto: ${pano.length}  H5P: ${h5p.length}`);
  }

  /* quizzes / assignments */
  const { classic, newQuiz } = await listQuizzes(courseId);
  const otherAss = await listOtherAssignments(courseId);

  const classicPct = await submissionsPct(classic, students);
  const newPct     = await submissionsPct(newQuiz, students);
  const otherPct   = await submissionsPct(otherAss, students);

  //const pagesViewedPct = pages.length ? ((viewedTotal / pages.length) / students * 100).toFixed(1) : 0;
  const pagesViewedPct =
  pages.length && students
    ? (viewersSum / (pages.length * students) * 100).toFixed(1)
    : 0;

  METRICS.push({
    courseId,
    students,
    pagesPublished: pages.length,
    pagesViewedPct,
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
