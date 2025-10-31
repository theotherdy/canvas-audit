// crawl_canvas.js — combined Canvas audit + Panopto session collector
import { chromium }          from '@playwright/test';
import { stringify }         from 'csv-stringify/sync';
import { promises as fs }    from 'node:fs';
//import fetch                 from 'node-fetch'; // Already available globally
import * as H                from './helpers.js';
import 'dotenv/config';
import path from 'node:path';

/* ─── env ------------------------------------------------------------------------------------------------- */
const {
  CANVAS_DOMAIN,
  CANVAS_TOKEN,
  COURSE_IDS,
  PAGE_LIMIT = 0,
  STORAGE_FILE,
  SINGLE_PAGE,                 // optional single page slug to audit
  CONTINUE_WITH_RUN_ID = '0',  // '0' => start a new run; otherwise reuse this runId
  RUN_DIR = 'runs',            // base run directory
  CANVAS_METRICS_FILE = 'canvas_course_metrics', // base name - run id will be appended
  NAV_TIMEOUT_MS = '60000',
  PAGE_OPERATION_TIMEOUT_MS = '15000',
  PAGE_INITIAL_WAIT_MS = '3000',
  BASE_WAIT_MS = '3000',
  MAX_PAGE_ATTEMPTS = '4',
  FINAL_RELOAD = 'true'
} = process.env;

if (!CANVAS_DOMAIN || !CANVAS_TOKEN || !COURSE_IDS)
  throw new Error('❌  Missing CANVAS_DOMAIN, CANVAS_TOKEN or COURSE_IDS in .env');

const COURSES = COURSE_IDS.split(',').map(s => s.trim());
const PAGE_LIMIT_N = +PAGE_LIMIT;
const SINGLE_PAGE_SLUG = SINGLE_PAGE && SINGLE_PAGE.trim();  

// === Canonical CSV header (single source of truth for CSV column order) ===
const HEADERS = [
  'courseId','courseName','studentsCount','pagesPublished',
  'meanPercentViewed','medianPercentViewed','pctPagesViewedOnce',
  'pagesWithPanopto','panoptoVideos',
  'pagesWithYouTube','youTubeVideos','pagesWithH5P','h5pItems',
  'pagesWithMSForms','msForms',
  'pagesWithCSlide','cslideItems',
  'noOfQuizzes','quizzesSubmittedPct','noOfUngradedSurvey','ungradedSurveyPct',
  'noOfOtherAssignments','otherAssignmentsSubmittedPct','noOfDiscussionTopics',
  'meanPctStudentsPosting','pagesFailed','runId','timestamp'
];

const NAV_TIMEOUT = Number.parseInt(NAV_TIMEOUT_MS, 10) || 60000;
const PAGE_OP_TIMEOUT = Number.parseInt(PAGE_OPERATION_TIMEOUT_MS, 10) || 15000;
const PAGE_INITIAL_WAIT = Number.parseInt(PAGE_INITIAL_WAIT_MS, 10) || 3000;
const BASE_WAIT = Number.parseInt(BASE_WAIT_MS, 10) || 3000;
const MAX_PAGE_ATTEMPTS_N = Number.parseInt(MAX_PAGE_ATTEMPTS, 10) || 4;
const FINAL_RELOAD_BOOL = /^(1|true|yes)$/i.test(String(FINAL_RELOAD));


/* ─── main ----------------------------------------------------------------------------------------------- */
await H.ensureStorageState({ canvasDomain: CANVAS_DOMAIN, storageFile: STORAGE_FILE });
const browser = await chromium.launch({ headless: true });
const ctx     = await browser.newContext({ storageState: STORAGE_FILE });
const page    = await ctx.newPage();

const METRICS = [];    
const SESSION_ROWS = [];
const MAX_RETRIES = 2; // Number of *retry* passes (so 1 initial + 2 retries = 3 total attempts)

/* ------------------ Run init: create/load run manifest & per-run CSV ------------------ */
const { runId, runDir, manifestPath, manifest, metricsCsvPath } = await H.loadOrCreateRun(CONTINUE_WITH_RUN_ID, { baseDir: RUN_DIR, metricsFileBase: CANVAS_METRICS_FILE });

// --- record failed pages into the existing manifest (helpers provides writeManifest) ---
manifest.failedPages = manifest.failedPages || [];
let pagesFailed = manifest.pagesFailed || 0; // keep and reuse any previously recorded count

// Persist configured course list into manifest.config.courses if missing
manifest.config = manifest.config || {};
manifest.config.courses = (manifest.config.courses && manifest.config.courses.length) ? manifest.config.courses : COURSES;
await H.writeManifest(manifestPath, manifest);

console.log(`\nRun ID: ${runId}`);
console.log(`Run dir: ${runDir}`);
console.log(`Manifest: ${manifestPath}`);
console.log(`Metrics CSV for run: ${metricsCsvPath}`);

//Used to call extraction or other per-page activities so they fail fast and let your retry loop try again or give up gracefully.
function withTimeout(promise, ms, label = 'operation') {
  let id;
  const timeout = new Promise((_, reject) => {
    id = setTimeout(() => reject(new Error(`Timed out after ${ms}ms (${label})`)), ms);
  });
  return Promise.race([
    Promise.resolve(promise).then(res => { clearTimeout(id); return res; }),
    timeout
  ]);
}

// Ensure CSV header exists (single-header per run)
try {
  try {
    await fs.access(metricsCsvPath);
  } catch (_) {
    // write canonical header (one line) if file missing
    H.appendCsvLineAtomic(metricsCsvPath, HEADERS.join(','));
  }
} catch (e) {
  console.warn('Warning while ensuring metrics CSV header:', e.message);
}

/* ------------------ Per-course processing loop ------------------ */
for (const courseId of COURSES) {
  console.log(`\n🧭  Course ${courseId}`);

  // If this run's manifest already has this course done, skip it (resume support)
  const courseEntry = manifest.courses && manifest.courses[courseId];
  if (courseEntry && courseEntry.status === 'done') {
    console.log(`   • Skipping course ${courseId} — already done in run ${runId}`);
    continue;
  }

  // Mark course as in_progress and persist
  manifest.courses = manifest.courses || {};
  manifest.courses[courseId] = { status: 'in_progress', startedAt: (new Date()).toISOString(), lastUpdated: (new Date()).toISOString(), error: null };
  await H.writeManifest(manifestPath, manifest);

  /* Get course name */
  let courseName = '';
  try {
    const courseUrl = `${CANVAS_DOMAIN}/api/v1/courses/${courseId}`;
    const res = await fetch(courseUrl, {
      headers: { Authorization: `Bearer ${CANVAS_TOKEN}` }
    });
    if (res.ok) {
      const courseData = await res.json();
      courseName = courseData.name || '';
      console.log(`   • course name: ${courseName}`);
    } else {
      console.warn(`   ⚠️  Could not fetch course name for ${courseId}`);
    }
  } catch (e) {
    console.error(`   ❌  Error fetching course name: ${e.message}`);
  }

  try {
    /* roster */
    const activeStudents = await H.getActiveStudentSet(courseId, CANVAS_DOMAIN, CANVAS_TOKEN);
    const students = activeStudents.size;
    console.log(`   • students: ${students}`);

    // --- Discussion metrics (simple: count of topics + mean pct students posting per topic)
    let noOfDiscussionTopics = 0;
    let meanPctStudentsPosting = 0;

    try {
      const d = await H.discussionMetricsSimple(courseId, activeStudents, 5); // concurrency 5 (tune as needed)
      noOfDiscussionTopics = d.noOfDiscussionTopics || 0;
      meanPctStudentsPosting = d.meanPctStudentsPosting || 0;
      console.log(`   • Discussions: topics=${noOfDiscussionTopics}, meanPctStudentsPosting=${meanPctStudentsPosting}%`);
    } catch (e) {
      console.warn('   ⚠️  discussion metrics failed:', e.message);
    }

    /* Get all pages for the course */
    let allPagesInCourse = [];

    if (SINGLE_PAGE_SLUG) {
      console.log(`   • SINGLE_PAGE set: only processing page slug "${SINGLE_PAGE_SLUG}"`);
      try {
        const url = `${CANVAS_DOMAIN}/api/v1/courses/${courseId}/pages/${SINGLE_PAGE_SLUG}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${CANVAS_TOKEN}` }
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const pageData = await res.json();

        if (pageData && pageData.published) {
          allPagesInCourse = [pageData];
          console.log(`   • Found and will process single page: "${pageData.title || pageData.url}"`);
        } else {
          console.log(`   • Page "${SINGLE_PAGE_SLUG}" is not published or is front page — it will be skipped for page-scanning.`);
          // still leave allPagesInCourse empty so rest of processing works but page-scans do nothing
        }
      } catch (e) {
        console.error(`   ❌  Could not fetch single page data for ${SINGLE_PAGE_SLUG}:`, e.message);
        // leave allPagesInCourse empty so downstream logic knows there are no pages to scan
      }
    } else {
      const allPages = await H.listCanvasPages(courseId);
      allPagesInCourse = allPages.filter(p => p.published === true);
      console.log(`   • Total pages found in API: ${allPages.length}`);
      console.log(`   • Counting only PUBLISHED pages (excl. front page): ${allPagesInCourse.length}`);
    }

    /* NOTE:
      - We DO NOT 'continue' the course when SINGLE_PAGE is set and the page can't be fetched:
        we still want the other metrics (roster, assignments, quizzes, etc.) to run.
      - But downstream page-scanning and page-view gathering will operate over allPagesInCourse,
        which will contain at most the single page when SINGLE_PAGE is set.
    */

    // =================================================================================
    // === 1. EFFICIENT PAGE VIEW GATHERING (API-based)
    // =================================================================================
    
    const pageIdToSlugMap = {};
    let pagesAddedToMap = 0;

    allPagesInCourse.forEach(p => {
      if (p.page_id && p.url) { 
        pageIdToSlugMap[p.page_id] = p.url;
        pagesAddedToMap++;
      }
    });

    console.log(`   [DEBUG] Map build report:`);
    console.log(`     - Total filtered pages: ${allPagesInCourse.length}`);
    console.log(`     - Pages added to map: ${pagesAddedToMap}`);

    const pageViewers = {};
    allPagesInCourse.forEach(p => {
      if (p.url) {
        pageViewers[p.url] = new Set();
      }
    });

    if (students > 0) {
      console.log(`   • Fetching usage data for ${students} students...`);
      let usageFetchCounter = 0;

      const tasks = [...activeStudents].map(uid => {
        const url = `${CANVAS_DOMAIN}/courses/${courseId}/users/${uid}/usage.json`;
        return async () => {
            const currentFetchNum = ++usageFetchCounter;
            try {
                const allPagesData = await H.fetchAllPagesPlaywright(ctx, url);
                if (currentFetchNum % 25 === 0 || currentFetchNum === students || students < 10) {
                    console.log(`     · [${currentFetchNum}/${students}] Fetched ALL paginated usage for student ${uid}`);
                }
                return allPagesData;
            } catch (e) {
                console.warn(`     · [${currentFetchNum}/${students}] ❌ ERROR fetching paginated usage for student ${uid}: ${e.message}`);
                return null; 
            }
        };
      });
      
      const allUsageReports = (await H.runWithConcurrency(tasks, 10)).filter(Boolean);

      console.log(`   • Processing ${allUsageReports.length} usage reports...`);

      for (const report of allUsageReports) {
        if (!Array.isArray(report)) continue;

        for (const item of report) {
          const access = item.asset_user_access;
          if (!access) continue;

          if (access.asset_category === 'wiki' && access.asset_code) {
            const pageId = access.asset_code.replace('wiki_page_', '');
            const slug = pageIdToSlugMap[pageId]; 
            
            if (slug && pageViewers[slug] && access.view_score > 0) {
              pageViewers[slug].add(access.user_id);
            }
          }
        }
      }
    } else {
      console.log('   • No students to fetch usage data for.');
    }

    // =================================================================================
    // === 2. ROBUST PAGE EMBED SCANNING (with Retries)
    // =================================================================================
    
    let panoPageCount = 0, panoEmbeds = 0;
    let h5pPageCount  = 0, h5pEmbeds  = 0;
    let ytPageCount   = 0, ytEmbeds   = 0; 
    let msFormsPageCount = 0, msFormsEmbeds = 0;
    let cslidePageCount = 0, cslideEmbeds = 0;

    const sessionSet = new Set();
    
    let pagesToScan = [...allPagesInCourse];
    if (SINGLE_PAGE_SLUG) {
      // Single-page mode: explicitly scan only that page (if present)
      console.log(`   • SINGLE_PAGE mode — scanning only the selected page (${pagesToScan.length} page(s) available) for embeds...`);
    } else if (PAGE_LIMIT_N > 0) {
      console.log(`   • Scanning first ${PAGE_LIMIT_N} pages (of ${allPagesInCourse.length} total) for embeds...`);
      pagesToScan = pagesToScan.slice(0, PAGE_LIMIT_N);
    } else {
      console.log(`   • Scanning all ${pagesToScan.length} filtered pages for embeds...`);
    }
    
    let failedPages = []; 

    for (let pass = 0; pass <= MAX_RETRIES; pass++) {
      if (pass > 0) {
        if (pagesToScan.length === 0) break; 
        console.log(`\n   --- RETRY PASS ${pass}/${MAX_RETRIES} ---`);
        console.log(`   • Retrying ${pagesToScan.length} failed pages...`);
        try { await page.waitForTimeout(5000); } catch(e){} 
      }

      failedPages = []; 

      for (let i = 0; i < pagesToScan.length; i++) {
        const p = pagesToScan[i];
        
        if (!p.url) {
            if (pass === 0) { 
               console.warn(`   ⚠️  Page object (index ${i}) has no 'url' property. Cannot scan. Object: ${JSON.stringify(p)}`);
            }
            continue; 
        }

        const url = `${CANVAS_DOMAIN}/courses/${courseId}/pages/${p.url}`;
        
        //const reqs = [];
        //const h = r => reqs.push(r.url());
        //const panoptoResponseUrls = new Set();
        //page._panoptoResponseMap = page._panoptoResponseMap || new Map();
        
        const guidPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
        const ogMetaRegex = new RegExp(`<meta[^>]*property=["']og:url["'][^>]*content=["'][^"']*id=(${guidPattern})[^"']*["'][^>]*>`, 'i');
        const formActionRegex = new RegExp(`<form[^>]*action=["'][^"']*id=(${guidPattern})[^"']*["'][^>]*>`, 'ig');
        
        try {
          console.log(`      (${i + 1}/${pagesToScan.length}) Visiting: ${p.url} (Attempt ${pass + 1})`);
          
          // START: per-page bounded progressive-wait + extraction loop

          page._panoptoResponseMap = page._panoptoResponseMap || new Map();
          const reqs = [];
          const h = r => reqs.push(r.url());
          const panoptoResponseUrls = new Set();

          // --- panopto response handler (must be defined AFTER panoptoResponseUrls) ---
          const respHandler = async (res) => {
            try {
              const u = res.url();
              if (!/panopto|embed\.aspx|Viewer\.aspx|EmbedSession/i.test(u)) return;
              if (panoptoResponseUrls.has(u)) return;
              panoptoResponseUrls.add(u);
              let text = '';
              try { text = await res.text(); } catch (e) { return; }

              // Check for the "deleted" message in the iframe's response
              if (text.includes('This video is no longer available.')) {
                // Use the special token from helpers.js
                page._panoptoResponseMap.set(u, [H.PANOPTO_DELETED_TOKEN]);
                return; // Stop processing this response
              }
              
              const found = new Set();
              const ogMatch = text.match(ogMetaRegex);
              if (ogMatch && ogMatch[1]) found.add(ogMatch[1]);
              let m;
              while ((m = formActionRegex.exec(text)) !== null) {
                if (m[1]) found.add(m[1]);
              }
              if (found.size) {
                page._panoptoResponseMap.set(u, [...found]);
              } else {
                page._panoptoResponseMap.set(u, []);
              }
            } catch (err) {
              // defensive: ensure this handler never throws to the top-level event emitter
              console.error('    error in panopto response handler', err && err.message ? err.message : err);
            }
          };

          page.on('request', h);
          page.on('response', respHandler);

          // navigate with env-backed NAV_TIMEOUT (ensure NAV_TIMEOUT is defined earlier)
          try {
            await withTimeout(page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT }), NAV_TIMEOUT + 2000, 'page.goto');
          } catch (navErr) {
            // propagate to existing catch handling below (so the outer retry machinery can catch it)
            page.off('request', h);
            page.off('response', respHandler);
            throw navErr;
          }

          // initial short wait (bounded by PAGE_OP_TIMEOUT)
          try { await withTimeout(page.waitForTimeout(PAGE_INITIAL_WAIT), PAGE_OP_TIMEOUT, 'initial-wait'); } catch(e){ /* ignore initial wait timeout */ }

          const boundedOpts = {
            inPlaceAttempts: MAX_PAGE_ATTEMPTS_N,                 // three in-place tries (you asked for 3)
            baseWaitMs: BASE_WAIT,              // uses your existing BASE_WAIT
            pageOpTimeoutMs: PAGE_OP_TIMEOUT,   // keep page op timeout consistent with file top-level constants
            finalReload: FINAL_RELOAD_BOOL      // follow existing env-driven behavior
          };

          const boundedResult = await H.extractPanoptoWithBoundedRetries(page, boundedOpts);
          let panoGuidsPerFrame = Array.isArray(boundedResult.guidsPerFrame) ? boundedResult.guidsPerFrame : [];
          const attemptsMade = boundedResult.attempts || 0;
          const didReload = !!boundedResult.reloaded;
          const deletedDetected = !!boundedResult.deletedDetected;

          // --- Panopto extraction outcome handling (updated, replaces old if/else) ---
          if (attemptsMade === 0) {
            // No Panopto frames found on this page — detach handlers and log once.
            page.off('request', h);
            page.off('response', respHandler);
            console.log('    ▶ no panopto frames found.');
            panoGuidsPerFrame = []; // ensure it's empty so nothing gets counted later
          } else {
            // There were Panopto frames (attemptsMade > 0). Handle deleted / blank / success cases.

            // Case A: Deleted marker detected — treat as definitive and record once
            if (deletedDetected) {
              console.warn(`        ⚠️  Detected Panopto deleted page — aborting retries for ${p.url || 'unknown-url'}.`);
              manifest.panoptoNoGuidPages = manifest.panoptoNoGuidPages || [];
              manifest.panoptoNoGuidPages.push({
                url: p.url || (p && p.pageUrl) || 'unknown-url',
                reason: 'panopto_deleted',
                attempts: attemptsMade,
                reloaded: didReload,
                detectedAt: new Date().toISOString(),
                courseId
              });
              try { await H.writeManifest(manifestPath, manifest); } catch (mw) {
                console.warn('   ⚠️  Could not persist manifest for panopto-deleted page:', mw.message);
              }
              page.off('request', h);
              page.off('response', respHandler);
              continue; // skip this page entirely
            }

            // Case B: Frames exist but all GUIDs blank — record and skip
            const framesFound = page.frames().filter(f => /panopto/i.test(f.url()));
            const allBlankGuids =
              framesFound.length > 0 &&
              (panoGuidsPerFrame.length === 0 || panoGuidsPerFrame.every(g => !g || g.trim() === ''));
            if (framesFound.length > 0 && allBlankGuids) {
              console.warn(`        ⚠️  Panopto GUIDs still empty after bounded attempts for ${p.url}. Recording in manifest.`);
              manifest.panoptoNoGuidPages = manifest.panoptoNoGuidPages || [];
              manifest.panoptoNoGuidPages.push({
                url: p.url || (p && p.pageUrl) || 'unknown-url',
                reason: 'no_guid_after_attempts',
                attempts: attemptsMade,
                finalReloadAttempted: didReload,
                recordedAt: new Date().toISOString(),
                courseId
              });
              try { await H.writeManifest(manifestPath, manifest); } catch (mw) {
                console.warn('   ⚠️  Could not persist manifest for no-guid page:', mw.message);
              }
              page.off('request', h);
              page.off('response', respHandler);
              continue; // move to next page
            }

            // Case C: One or more GUIDs found — push only non-empty GUIDs
            if (Array.isArray(panoGuidsPerFrame) && panoGuidsPerFrame.length > 0) {
              const nonEmptyGuids = panoGuidsPerFrame.filter(g => g && String(g).trim() !== '');
              if (nonEmptyGuids.length > 0) {
                panoPageCount++;
                panoEmbeds += nonEmptyGuids.length;
                nonEmptyGuids.forEach(g => sessionSet.add(g));
                for (const guid of nonEmptyGuids) {
                  SESSION_ROWS.push({ courseId, sessionId: guid });
                }
              } else {
                console.warn(`        ⚠️  All extracted GUIDs were empty for ${p.url} despite frames being present.`);
              }
            } else {
              console.warn(`        ⚠️  Unexpected: attemptsMade=${attemptsMade} but panoGuidsPerFrame missing or not an array for ${p.url}`);
            }

            // Always detach handlers before moving on
            page.off('request', h);
            page.off('response', respHandler);
          }

          // --- record / log results (keeps your existing behavior) ---
          const html = await page.content();
          // Count H5Ps 
          const h5pRegex = /<iframe[^>]*src="[^"]*h5p\.com(?:%2F|\/)+content(?:%2F|\/)+([0-9]+)[^"]*"/ig;
          const h5p  = [...html.matchAll(h5pRegex)];
          // Count YouTube iframes
          const ytRegex = /<iframe[^>]*src="[^"]*(youtube\.com\/embed\/|youtube-nocookie\.com\/embed\/|yout-ube\.com\/embed\/)[^"]*"/ig;
          const ytMatches = [...html.matchAll(ytRegex)];
          const ytCount = ytMatches.length;
          // Count Microsoft Forms embedded via iframe
          const msFormsRegex = /<iframe[^>]*src="[^"]*(?:forms\.office\.com|forms\.microsoft\.com)[^"]*"/ig;
          const msFormsMatches = [...html.matchAll(msFormsRegex)];
          const msFormsCount = msFormsMatches.length;
          // Count CSlide iframes // <-- ADD THIS BLOCK
          const cslideRegex = /<iframe[^>]*src="[^"]*learntech\.medsci\.ox\.ac\.uk\/cslide\/[^"]*"/ig;
          const cslideMatches = [...html.matchAll(cslideRegex)];
          const cslideCount = cslideMatches.length;

          /*if (panoGuidsPerFrame.length) {
            panoPageCount++;
            panoEmbeds += panoGuidsPerFrame.length;
            panoGuidsPerFrame.forEach(g => { if (g) sessionSet.add(g); });
            for (let j = 0; j < panoGuidsPerFrame.length; j++) {
              const guid = panoGuidsPerFrame[j] || '';
              SESSION_ROWS.push({ courseId, sessionId: guid });
            }
          }*/

          console.log(`        Panopto: ${panoGuidsPerFrame.length}, H5P: ${h5p.length}, YouTube: ${ytCount}, MSForms: ${msFormsCount}, CSlide: ${cslideCount}`);

          if (h5p.length)  { h5pPageCount++;  h5pEmbeds  += h5p.length;  }
          if (ytCount > 0) { ytPageCount++;   ytEmbeds   += ytCount;   }
          if (msFormsCount > 0) {msFormsPageCount++; msFormsEmbeds += msFormsCount;} 
          if (cslideCount > 0) { cslidePageCount++; cslideEmbeds += cslideCount; }         
        } catch (err) {
          if (err.message.includes('Target page, context or browser has been closed')) {
              console.error(`   ❌  FATAL ERROR: Browser context closed unexpectedly. Stopping scan for this course.`);
              failedPages.push(p); 
              failedPages.push(...pagesToScan.slice(i + 1));
              pagesToScan = []; 
              break; 
          } else {
              console.warn(`   ⚠️  SKIPPING (Pass ${pass}): Failed to load ${p.url} due to: ${err.name} (${err.message.split('\n')[0]})`);
              failedPages.push(p);
              // If this was the final attempt, record as a permanent failure into the run manifest
              if (pass === MAX_RETRIES) {
                const urlToRecord = p.url || (p && p.pageUrl) || 'unknown-url';
                pagesFailed += 1;
                manifest.failedPages.push(urlToRecord);
                manifest.pagesFailed = pagesFailed;
                try {
                  await H.writeManifest(manifestPath, manifest); // atomic write helper from helpers.js
                  console.log(`   • Recorded permanent failure: ${urlToRecord}`);
                } catch (mw) {
                  console.warn('   ⚠️  Could not persist manifest for failed page:', mw.message);
                }
              }
          }
        }
      } 
      
      if (pagesToScan.length === 0) {
          break; 
      }
      pagesToScan = failedPages; 
    } 

    if (failedPages.length > 0) {
      console.error(`\n   ❌  PERMANENTLY FAILED: ${failedPages.length} pages failed embed scan.`);
      for (const p of failedPages) {
        console.error(`     - ${p.url || 'Page with no URL'}`);
      }
    }

    // =================================================================================
    // === 3. FINAL METRIC CALCULATION
    // =================================================================================

    let allQuizzes = [], ungradedSurveys = [], otherAssignments = [];
    let quizzesPct = 0, surveyPct = 0, otherPct = 0;

    try {
      const assignmentsData = await H.categorizeAssignments(courseId);
      allQuizzes = assignmentsData.allQuizzes;
      ungradedSurveys = assignmentsData.ungradedSurveys;
      otherAssignments = assignmentsData.otherAssignments;

      quizzesPct = await H.submissionsPct(allQuizzes, activeStudents, courseId);
      surveyPct  = await H.submissionsPct(ungradedSurveys, activeStudents, courseId);
      otherPct   = await H.submissionsPct(otherAssignments, activeStudents, courseId);

    } catch (err) {
      console.error(`   ❌  ERROR processing assignments/quizzes: ${err.message}`);
      console.error(`      Assignment/Quiz metrics will be 0 for this course.`);
    }

    const numPages = allPagesInCourse.length || 0;
    
    let meanPercentViewed = 0;
    let medianPercentViewed = 0;
    let pctPagesViewedOnce = 0;
    
    console.log(`\n   --- [DEBUG] Final Calculation Inputs ---`);
    console.log(`   Total filtered pages (numPages): ${numPages}`);
    console.log(`   Active students (activeStudents.size): ${students}`);
    console.log(`   --------------------------------------`);

    if (numPages && students > 0) {
      const allPagePercentScores = [];
      let pagesViewedAtLeastOnce = 0;
      let totalPct = 0;

      for (const p of allPagesInCourse) { 
        if (p.url) {
          const slug = p.url;
          const viewers = pageViewers[slug] ? pageViewers[slug].size : 0;
          const percentScore = (viewers / students) * 100;
          
          allPagePercentScores.push(percentScore);
          totalPct += percentScore;

          if (viewers > 0) {
            pagesViewedAtLeastOnce++;
          }
        }
      }

      pctPagesViewedOnce = (pagesViewedAtLeastOnce / numPages) * 100;
      meanPercentViewed = totalPct / numPages;

      allPagePercentScores.sort((a, b) => a - b);
      const mid = Math.floor(allPagePercentScores.length / 2);
      medianPercentViewed = allPagePercentScores.length % 2 === 0 
        ? (allPagePercentScores[mid - 1] + allPagePercentScores[mid]) / 2 
        : allPagePercentScores[mid];
    }

    METRICS.push({
      courseId,
      courseName, 
      students,
      pagesPublished: numPages, 
      meanPercentViewed: meanPercentViewed.toFixed(1),
      medianPercentViewed: medianPercentViewed.toFixed(1),
      pctPagesViewedOnce: pctPagesViewedOnce.toFixed(1),
      noOfQuizzes: allQuizzes.length,
      quizzesSubmittedPct: quizzesPct,
      noOfUngradedSurvey: ungradedSurveys.length,
      ungradedSurveyPct: surveyPct,
      noOfOtherAssignments: otherAssignments.length,
      otherAssignmentsSubmittedPct: otherPct,
      pagesWithPanopto: panoPageCount, 
      panoptoVideos: panoEmbeds,     
      pagesWithH5P: h5pPageCount,    
      h5pItems: h5pEmbeds,
      pagesWithMSForms: msFormsPageCount,  
      msForms: msFormsEmbeds,    
      pagesWithCSlide: cslidePageCount, 
      cslideItems: cslideEmbeds,          
      pagesWithYouTube: ytPageCount, 
      youTubeVideos: ytEmbeds,       
      noOfDiscussionTopics: noOfDiscussionTopics,
      meanPctStudentsPosting: meanPctStudentsPosting,
      pagesFailed: pagesFailed
    });

    // --- Persist one CSV row for this course (atomic append) ---
    const lastMetric = METRICS[METRICS.length - 1];
    lastMetric.runId = runId;
    lastMetric.timestamp = (new Date()).toISOString();

    // Ensure lastMetric has any aliased/derived keys expected by HEADERS
    // (some parts of the code used `students` — we normalise to studentsCount)
    lastMetric.studentsCount = lastMetric.studentsCount ?? lastMetric.students ?? students;
    lastMetric.pagesPublished = lastMetric.pagesPublished ?? lastMetric.pagesPublished ?? lastMetric.pagesPublished; // noop but explicit

    // Build row using canonical HEADERS (handles quoting for courseName)
    const csvLine = HEADERS.map(key => {
      if (key === 'courseName') {
        return `"${(lastMetric.courseName || '').replace(/"/g, '""')}"`;
      }
      if (key === 'runId') return runId;
      const v = lastMetric[key];
      return (v === undefined || v === null) ? '' : String(v);
    }).join(',');

    try {
      H.appendCsvLineAtomic(metricsCsvPath, csvLine);
      manifest.courses[courseId] = {
        status: 'done',
        startedAt: manifest.courses[courseId].startedAt,
        finishedAt: (new Date()).toISOString(),
        lastUpdated: (new Date()).toISOString(),
        error: null
      };
      await H.writeManifest(manifestPath, manifest);
      console.log(`   • Course ${courseId} metrics appended to ${metricsCsvPath}`);
    } catch (e) {
      console.error(`   ❌  Failed to append metrics for course ${courseId}: ${e.message}`);
      manifest.courses[courseId] = { status: 'failed', lastUpdated: (new Date()).toISOString(), error: String(e) };
      await H.writeManifest(manifestPath, manifest);
      continue;
    }

  } catch (err) {
    console.error(`   ❌  Course ${courseId} failed: ${err.message}`);
    manifest.courses[courseId] = { status: 'failed', lastUpdated: (new Date()).toISOString(), error: String(err) };
    await H.writeManifest(manifestPath, manifest);
    // continue to next course (do not abort whole run)
    continue;
  }
}

manifest.summary = manifest.summary || {};
manifest.summary.pagesFailed = pagesFailed;
manifest.summary.failedPagesCount = (manifest.failedPages || []).length;
manifest.summary.finishedAt = new Date().toISOString();
await H.writeManifest(manifestPath, manifest);
console.log(`• Run manifest updated with ${manifest.summary.failedPagesCount} failed pages`);

await browser.close();

// Write panopto session ids into run dir CSV
try {
  const panoptoCsvPath = path.join(runDir, `panopto_session_ids-${runId}.csv`);

  // Create a Set of unique strings (e.g., "1234|guid-abc")
  const uniqueSessionStrings = new Set(
    SESSION_ROWS.map(row => `${row.courseId}|${row.sessionId}`)
  );

  // Map the unique strings back to { courseId, sessionId } objects
  const uniqueSessionRows = [...uniqueSessionStrings].map(s => {
    const [courseId, sessionId] = s.split('|');
    return { courseId, sessionId };
  });
  
  // Write the de-duplicated array to the CSV
  await fs.writeFile(panoptoCsvPath, stringify(uniqueSessionRows, { header: true }));
  console.log(`\n✅  appended course metrics to ${metricsCsvPath} and wrote ${uniqueSessionRows.length} unique panopto_session_ids in ${runDir}`);
} catch (e) {
  console.warn('Warning: could not write panopto session CSV for run:', e.message);
}
