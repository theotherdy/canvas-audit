// helpers.js
import { chromium } from '@playwright/test';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import { URL } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import 'dotenv/config';
import fetch from 'node-fetch';

/* ---------- env & constants ------------------------ */
const CANVAS  = process.env.CANVAS_DOMAIN.replace(/\/$/, '');
const CV_PAT  = process.env.CANVAS_TOKEN;
// helpers.js — add after existing env/constants
export const PANOPTO_DELETED_TOKEN = process.env.PANOPTO_DELETED_TOKEN || '__PANOPTO_DELETED__';

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
  return rows;
}

/*------------------------------------------------------
* START DISCUSSION METRICS
*-------------------------------------------------------*/
/**
 * List discussion topics for a course (published + unpublished).
 * Uses the Canvas API /discussion_topics endpoint (paginated).
 *
 * @param {string|number} courseId
 * @returns {Promise<Array>}
 */
export async function listDiscussionTopics(courseId) {
  return await fetchAll(`${CANVAS}/api/v1/courses/${courseId}/discussion_topics?per_page=100`);
}

/**
 * Fetch entries (top-level posts) for a topic using the Canvas entries endpoint.
 * Returns an array of entry objects; replies (if present) are inside each entry.replies
 *
 * @param {string|number} courseId
 * @param {string|number} topicId
 * @returns {Promise<Array>}
 */
export async function fetchDiscussionEntries(courseId, topicId) {
  return await fetchAll(`${CANVAS}/api/v1/courses/${courseId}/discussion_topics/${topicId}/entries?per_page=100`);
}

/**
 * Compute simplified discussion metrics:
 * - noOfDiscussionTopics: number of published discussion topics
 * - meanPctStudentsPosting: mean across topics of (unique active posters / active students) * 100
 *
 * Only attributes posters to IDs present in activeStudentSet (so it matches how you treat other metrics).
 *
 * @param {string|number} courseId
 * @param {Set<number>} activeStudentSet - Set of active student user_ids
 * @param {number} [concurrency=5] - concurrency for fetching topic entries
 * @returns {Promise<{noOfDiscussionTopics:number, meanPctStudentsPosting:string}>}
 */
export async function discussionMetricsSimple(courseId, activeStudentSet = new Set(), concurrency = 5) {
  // 1) list topics
  const topics = await listDiscussionTopics(courseId);
  // consider only published topics to match 'offer' semantics
  const publishedTopics = topics.filter(t => t.published === true);
  const noOfDiscussionTopics = publishedTopics.length;

  if (!publishedTopics.length) {
    return {
      noOfDiscussionTopics: 0,
      meanPctStudentsPosting: 0
    };
  }

  // 2) prepare tasks to fetch entries for each topic
  const tasks = publishedTopics.map(t => async () => {
    try {
      const entries = await fetchDiscussionEntries(courseId, t.id);
      return { topicId: t.id, entries: Array.isArray(entries) ? entries : [] };
    } catch (e) {
      console.warn(`⚠️ discussionMetricsSimple: failed to fetch entries for topic ${t.id}: ${e.message}`);
      return { topicId: t.id, entries: [] };
    }
  });

  const results = await runWithConcurrency(tasks, concurrency);

  // 3) for each topic compute percent of active students who posted at least once
  const topicPercents = [];
  for (const r of results) {
    if (!r || !Array.isArray(r.entries)) {
      topicPercents.push(0);
      continue;
    }

    const posters = new Set();

    for (const e of r.entries) {
      const uid = e.user_id || (e.user && e.user.id) || null;
      if (uid && activeStudentSet.has(uid)) posters.add(uid);

      if (Array.isArray(e.replies) && e.replies.length) {
        for (const rep of e.replies) {
          const ruid = rep.user_id || (rep.user && rep.user.id) || null;
          if (ruid && activeStudentSet.has(ruid)) posters.add(ruid);
        }
      }
      // Some Canvas responses may not include full replies; we intentionally ignore those for this simple metric
    }

    const denom = activeStudentSet.size || 1;
    const pct = (posters.size / denom) * 100;
    topicPercents.push(pct);
  }

  const meanPct = topicPercents.length ? (topicPercents.reduce((a, b) => a + b, 0) / topicPercents.length) : 0;

  return {
    noOfDiscussionTopics,
    meanPctStudentsPosting: Number(meanPct).toFixed(1) // string like other metrics (1 d.p.)
  };
}

/*------------------------------------------------------
* END DISCUSSION METRICS
*-------------------------------------------------------*/

/* GetPanopto SessionIDs from the loaded iFrame */
export async function extractPanoptoSessionGuids(page) {
  const out = [];

  try {
    const frames = page.frames().filter(f => /panopto/i.test(f.url()));
    //console.log("🔎 Panopto frames (order):", frames.map(f => f.url()));

    if (!frames.length) {
      console.log("    ▶ no panopto frames found.");
      return out;
    }

    const respMap = page._panoptoResponseMap || new Map();
    if (!respMap.size) {
      console.log("    ▶ no panopto network responses captured (respMap empty).");
      for (let i = 0; i < frames.length; i++) out.push('');
      return out;
    }

    const respUrls = [...respMap.keys()];

    for (const f of frames) {
      const fu = f.url();
      let bestMatch = null;
      for (const ru of respUrls) {
        if (fu && ru && (fu.includes(ru) || ru.includes(fu))) { bestMatch = ru; break; }
      }
      if (!bestMatch) {
        const tryHost = (u) => {
          try { return new URL(u).host; } catch(e){ return null; }
        };
        const fHost = tryHost(fu);
        if (fHost) {
          bestMatch = respUrls.find(ru => tryHost(ru) === fHost) || null;
        }
      }

      let chosenGuid = '';
      if (bestMatch) {
        const guids = respMap.get(bestMatch) || [];
        if (guids.length) chosenGuid = guids[0];
        //console.log(`    frame ${fu} -> matched response ${bestMatch} -> guid:`, chosenGuid || '(none)');
      } else {
        console.log(`    frame ${fu} -> no matching panopto response found`);
      }

      out.push(chosenGuid);
    }

    console.log('    ▶ extractPanoptoSessionGuids (per-frame strict) ->', out.length, 'items:', out);
    return out;
  } catch (e) {
    console.warn('⚠️ extractPanoptoSessionGuids error:', e);
    try {
      const frames = page.frames().filter(f => /panopto/i.test(f.url()));
      return frames.map(_ => '');
    } catch (ee) {
      return [];
    }
  }
}

//manages retries to get Panopto session_ids if not found initially.
export async function extractPanoptoWithBoundedRetries(page, opts = {}) {
  // opts: { inPlaceAttempts = 3, baseWaitMs = 3000, pageOpTimeoutMs = 15000, finalReload = true }
  const inPlaceAttempts = Number.isInteger(opts.inPlaceAttempts) ? opts.inPlaceAttempts : 3;
  const baseWaitMs = opts.baseWaitMs || 3000;
  const pageOpTimeoutMs = opts.pageOpTimeoutMs || 15000;
  const finalReload = opts.finalReload === undefined ? true : !!opts.finalReload;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // --- EARLY EXIT: if there are no panopto frames on the page, don't attempt retries ---
  try {
    const frames = page.frames().filter(f => /panopto/i.test(f.url()));
    if (!frames || frames.length === 0) {
      // No frames -> immediate, cheap return. Caller should treat attempts==0 as "no frames".
      return { guidsPerFrame: [], attempts: 0, reloaded: false, deletedDetected: false };
    }
  } catch (err) {
    // If frames call fails for some reason, fall through to normal behavior (defensive)
  }

  let lastGuids = [];
  let attempts = 0;
  let reloaded = false;
  let deletedDetected = false;

  // Only call extractPanoptoSessionGuids when we know frames exist.
  for (let i = 0; i < inPlaceAttempts; i++) {
    attempts++;
    try {
      const guids = await Promise.race([
        extractPanoptoSessionGuids(page),
        new Promise((_, rej) => setTimeout(() => rej(new Error('extract timeout')), pageOpTimeoutMs))
      ]);
      lastGuids = Array.isArray(guids) ? guids : [];

      // if deleted token present, short-circuit
      if (lastGuids.some(g => g === PANOPTO_DELETED_TOKEN)) {
        deletedDetected = true;
        return { guidsPerFrame: lastGuids, attempts, reloaded, deletedDetected };
      }

      // success if every frame has a non-empty guid
      const allFound = lastGuids.length > 0 && lastGuids.every(g => typeof g === 'string' && g.trim() !== '');
      if (allFound) return { guidsPerFrame: lastGuids, attempts, reloaded, deletedDetected };

    } catch (err) {
      // treat as a blank extract and continue to retry
      lastGuids = lastGuids || [];
    }

    // If not last in-place attempt, wait progressive backoff
    if (i < inPlaceAttempts - 1) {
      const waitMs = baseWaitMs * (i + 1); // 1x, 2x, 3x
      await sleep(waitMs);
    }
  }

  // After in-place attempts, single extra wait then one final in-place extraction
  attempts++;
  try {
    await sleep(baseWaitMs);
    const finalInPlace = await Promise.race([
      extractPanoptoSessionGuids(page),
      new Promise((_, rej) => setTimeout(() => rej(new Error('extract timeout')), pageOpTimeoutMs))
    ]);
    lastGuids = Array.isArray(finalInPlace) ? finalInPlace : lastGuids;

    if (lastGuids.some(g => g === PANOPTO_DELETED_TOKEN)) {
      deletedDetected = true;
      return { guidsPerFrame: lastGuids, attempts, reloaded, deletedDetected };
    }

    const allFound = lastGuids.length > 0 && lastGuids.every(g => typeof g === 'string' && g.trim() !== '');
    if (allFound) return { guidsPerFrame: lastGuids, attempts, reloaded, deletedDetected };
  } catch (err) {
    // continue to final reload if configured
  }

  // Single reload fallback (bounded) — only one reload and one final extract
  if (finalReload) {
    try {
      reloaded = true;
      await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(()=>{});
      // allow a short settling time
      await sleep(baseWaitMs);
      attempts++;
      const postReload = await Promise.race([
        extractPanoptoSessionGuids(page),
        new Promise((_, rej) => setTimeout(() => rej(new Error('extract timeout')), pageOpTimeoutMs))
      ]);
      lastGuids = Array.isArray(postReload) ? postReload : lastGuids;
      if (lastGuids.some(g => g === PANOPTO_DELETED_TOKEN)) {
        deletedDetected = true;
      }
    } catch (err) {
      // swallow: we give up after this one final attempt
    }
  }

  return { guidsPerFrame: lastGuids || [], attempts, reloaded, deletedDetected };
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
 * Fetches all classic quizzes and assignments, then categorizes them
 * into quizzes, ungraded surveys, and other assignments.
 * @param {string} courseId
 */
export async function categorizeAssignments(courseId) {
  const assignments = await fetchAll(
    `${CANVAS}/api/v1/courses/${courseId}/assignments?per_page=100`
  );
  const classicQuizzes = await fetchAll(
    `${CANVAS}/api/v1/courses/${courseId}/quizzes?per_page=100`
  );

  console.log(`\n--- Debugging categorizeAssignments for course ${courseId} ---`);
  console.log(`  Fetched ${assignments.length} total assignments (from /assignments)`);
  console.log(`  Fetched ${classicQuizzes.length} total classic quizzes (from /quizzes)`);

  const allQuizzes = [];
  const ungradedSurveys = [];
  const otherAssignments = [];

  const classicQuizAssignmentIds = new Set();

  console.log('\n  Processing Classic Quizzes (from /quizzes)...');
  for (const q of classicQuizzes.filter(q => q.published)) {
    if (q.quiz_type === 'survey' || q.quiz_type === 'graded_survey') {
      console.log(`    [+] Pushing to ungradedSurveys: "${q.title}" (type: ${q.quiz_type})`);
      ungradedSurveys.push(q);
      if (q.assignment_id) {
        classicQuizAssignmentIds.add(q.assignment_id);
      }
    } else {
      console.log(`    [+] Pushing to allQuizzes: "${q.title}" (type: ${q.quiz_type})`);
      allQuizzes.push(q);
      if (q.assignment_id) {
        classicQuizAssignmentIds.add(q.assignment_id);
      }
    }
  }

  console.log('\n  Processing Assignments (from /assignments)...');
  for (const a of assignments.filter(a => a.published)) {
    if (classicQuizAssignmentIds.has(a.id)) {
      console.log(`    [S] Skipping Assignment: "${a.name}" (already processed as Classic Quiz)`);
      continue;
    }

    const isNewQuiz = a.submission_types.includes('online_quiz') || a.is_quiz_lti_assignment === true;

    if (isNewQuiz) {
      if (a.grading_type === 'not_graded') {
        console.log(`    [+] Pushing to ungradedSurveys: "${a.name}" (type: New Quiz [${a.submission_types.join(', ')}], not_graded)`);
        ungradedSurveys.push(a);
      } else {
        console.log(`    [+] Pushing to allQuizzes: "${a.name}" (type: New Quiz [${a.submission_types.join(', ')} / LTI: ${a.is_quiz_lti_assignment}], graded)`);
        allQuizzes.push(a);
      }
    } else if (
      !a.submission_types.includes('discussion_topic') &&
      !a.submission_types.includes('external_tool')
    ) {
      if (a.grading_type === 'not_graded') {
        console.log(`    [+] Pushing to ungradedSurveys: "${a.name}" (type: Other Assignment, not_graded)`);
        ungradedSurveys.push(a);
      } else {
        console.log(`    [+] Pushing to otherAssignments: "${a.name}" (type: Other Assignment, graded)`);
        otherAssignments.push(a);
      }
    } else {
      console.log(`    [?] Ignoring Assignment: "${a.name}" (type: ${a.submission_types.join(', ')})`);
    }
  }

  console.log('\n  --- Final Counts ---');
  console.log(`  noOfQuizzes: ${allQuizzes.length}`);
  console.log(`  noOfUngradedSurvey: ${ungradedSurveys.length}`);
  console.log(`  noOfOtherAssignments: ${otherAssignments.length}`);
  console.log('---------------------------------------------------\n');

  return { allQuizzes, ungradedSurveys, otherAssignments };
}

/**
 * Get submission percentage for a list of assignments/quizzes
 * @param {Array<object>} items - List of assignment or quiz objects
 * @param {Set<number>} activeStudentIds
 * @param {string} courseId - Fallback course ID
 * @returns {Promise<string>}
 */
export async function submissionsPct(items, activeStudentIds, courseId) {
  let pctSum = 0;
  let processedItemCount = 0;

  console.log(`\n--- Debugging submissionsPct (for ${items.length} items) ---`);
  console.log(`  Total active students: ${activeStudentIds.size}`);

  for (const it of items) {
    const cid = it.course_id || courseId;
    if (!cid) {
      console.warn('      ⚠️ submissionsPct: no course id available for item', it.id);
      continue;
    }

    const assignmentId = it.quiz_type ? it.assignment_id : it.id;
    const itemName = it.title || it.name;

    if (!assignmentId) {
      console.log(`\n  Processing item: "${itemName}" (ID: null)`);
      console.warn(`      ⚠️ submissionsPct: no assignment ID found for item "${itemName}" (type: ${it.quiz_type || 'assignment'}). Skipping.`);
      continue;
    }

    console.log(`\n  Processing item: "${itemName}" (ID: ${assignmentId})`);

    const subs = await fetchAll(
      `${CANVAS}/api/v1/courses/${cid}/assignments/${assignmentId}/submissions?per_page=100`
    );

    const subsFromActive = subs.filter(s => activeStudentIds.has(s.user_id));
    const done = subsFromActive.filter(s => s.workflow_state !== "unsubmitted").length;

    const denom = activeStudentIds.size || 1;
    const itemPct = done / denom;
    pctSum += itemPct;
    processedItemCount++;

    console.log(`    Total submissions fetched: ${subs.length}`);
    console.log(`    Submissions from active students: ${subsFromActive.length}`);
    console.log(`    Active students who submitted ("done"): ${done}`);
    console.log(`    Item percentage (done / active): ${(itemPct * 100).toFixed(1)}%`);
  }

  const finalAvgPct = processedItemCount ? ((pctSum / processedItemCount) * 100).toFixed(1) : 0;

  console.log(`\n  --- Final Average Pct for this category ---`);
  console.log(`  Total Pct Sum: ${pctSum * 100}`);
  console.log(`  Items Processed (divisor): ${processedItemCount}`);
  console.log(`  Average Pct: ${finalAvgPct}%`);
  console.log('---------------------------------------------------\n');

  return finalAvgPct;
}

/**
 * Fetches all pages for a paginated JSON endpoint that requires Playwright auth.
 * Uses the lightweight context.request API instead of opening new pages.
 *
 * @param {object} context - Playwright browser context (with auth state)
 * @param {string} url - The base URL of the endpoint (without page param).
 * @returns {Promise<Array>} - A single array containing results from all pages.
 */
export async function fetchAllPagesPlaywright(context, url) {
  const allResults = [];
  let pageNum = 1;
  const baseUrl = new URL(url);

  console.log(`  ... fetchAllPagesPlaywright (using context.request) starting for: ${baseUrl.pathname}`);

  while (true) {
    try {
      baseUrl.searchParams.set('page', pageNum);
      const pageUrl = baseUrl.href;

      const response = await context.request.get(pageUrl);

      if (!response.ok()) {
        console.warn(`⚠️  fetchAllPagesPlaywright: Request failed for ${pageUrl} with status ${response.status()}`);
        break;
      }

      const data = await response.json();

      if (Array.isArray(data) && data.length === 0) {
        console.log(`  ... fetchAllPagesPlaywright complete. Fetched ${pageNum - 1} pages.`);
        break;
      }

      if (Array.isArray(data)) {
        allResults.push(...data);
      } else {
        allResults.push(data);
        console.log(`  ... fetchAllPagesPlaywright complete. Fetched non-array paged result.`);
        break;
      }

      pageNum++;
      await delay(100);

    } catch (error) {
       console.error(`❌  fetchAllPagesPlaywright: Error during fetch for ${baseUrl.pathname} (page ${pageNum})`, error);
       break;
    }
  }

  return allResults;
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

/* --------------------------------------------- 
* START Helpers for run & resume functionality 
* -----------------------------------------------*/

/**
 * Generate a short random hex id.
 *
 * @param {number} [n=6] Number of hex characters to return.
 * @returns {string} Short hex id.
 */
export function shortId(n = 6) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

/**
 * Atomically write `content` to `filePath` by writing to a temporary file and renaming.
 *
 * @param {string} filePath
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${Date.now()}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

/**
 * Create or load a run manifest and return run metadata.
 *
 * If `runIdFromEnv` is `'0'` or falsy, a new runId will be generated:
 *   run-<ISO-timestamp>-<shortId>
 *
 * @param {string} runIdFromEnv
 * @param {Object} [opts]
 * @param {string} [opts.baseDir] - base run directory, defaults to process.env.RUN_DIR or 'runs'
 * @param {string} [opts.metricsFileBase] - base name for metrics file, defaults to process.env.CANVAS_METRICS_FILE or 'canvas_course_metrics'
 * @returns {Promise<{runId:string, runDir:string, manifestPath:string, manifest:Object, metricsCsvPath:string}>}
 */
export async function loadOrCreateRun(runIdFromEnv, opts = {}) {
  const baseDir = opts.baseDir || process.env.RUN_DIR || 'runs';
  const metricsFileBase = opts.metricsFileBase || process.env.CANVAS_METRICS_FILE || 'canvas_course_metrics';
  await fs.mkdir(baseDir, { recursive: true });

  let runId = runIdFromEnv && runIdFromEnv !== '0' ? runIdFromEnv : null;
  if (!runId) {
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    runId = `run-${iso}-${shortId(6)}`;
  }

  const runDir = path.join(baseDir, runId);
  await fs.mkdir(runDir, { recursive: true });

  const manifestPath = path.join(runDir, 'manifest.json');
  let manifest = null;
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    manifest = {
      runId,
      startedAt: new Date().toISOString(),
      config: {},
      courses: {}
    };
    await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
  }

  const metricsCsvPath = path.join(runDir, `${metricsFileBase}-${runId}.csv`);
  return { runId, runDir, manifestPath, manifest, metricsCsvPath };
}

/**
 * Atomically write the manifest file to disk.
 *
 * @param {string} manifestPath
 * @param {Object} manifest
 * @returns {Promise<void>}
 */
export async function writeManifest(manifestPath, manifest) {
  await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * Append a CSV line to `csvPath` synchronously and ensure directory exists.
 *
 * @param {string} csvPath
 * @param {string} line
 * @returns {void}
 */
export function appendCsvLineAtomic(csvPath, line) {
  const dir = path.dirname(csvPath);
  fsSync.mkdirSync(dir, { recursive: true });
  fsSync.appendFileSync(csvPath, line + '\n', 'utf8');
}

/* --------------------------------------------- 
* END Helpers for run & resume functionality 
* -----------------------------------------------*/
