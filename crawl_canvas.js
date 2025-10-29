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
  CANVAS_METRICS_FILE = 'canvas_course_metrics' // base name - run id will be appended
} = process.env;

if (!CANVAS_DOMAIN || !CANVAS_TOKEN || !COURSE_IDS)
  throw new Error('❌  Missing CANVAS_DOMAIN, CANVAS_TOKEN or COURSE_IDS in .env');

const COURSES = COURSE_IDS.split(',').map(s => s.trim());
const PAGE_LIMIT_N = +PAGE_LIMIT;
const SINGLE_PAGE_SLUG = SINGLE_PAGE && SINGLE_PAGE.trim();  

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

// Ensure CSV header exists (single-header per run)
if (!fs.existsSync) {
  // old Node versions: fs.existsSync is on require('fs'), but 'fs' here is promises – use helpers to create header if file missing:
}
try {
  // If metricsCsvPath doesn't exist, append header
  try {
    await fs.access(metricsCsvPath);
  } catch (_) {
    const header = ['courseId','courseName','studentsCount','pagesPublished','pagesWithPanopto','panoptoVideos','pagesWithH5P','h5pItems','meanPercentViewed','medianPercentViewed','pctPagesViewedOnce','noOfQuizzes','quizzesSubmittedPct','noOfUngradedSurvey','ungradedSurveyPct','noOfOtherAssignments','otherAssignmentsSubmittedPct','noOfDiscussionTopics','meanPctStudentsPosting','pagesFailed','runId','timestamp'].join(',');
    H.appendCsvLineAtomic(metricsCsvPath, header);
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
        
        const reqs = [];
        const h = r => reqs.push(r.url());
        const panoptoResponseUrls = new Set();
        page._panoptoResponseMap = page._panoptoResponseMap || new Map();
        
        const guidPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
        const ogMetaRegex = new RegExp(`<meta[^>]*property=["']og:url["'][^>]*content=["'][^"']*id=(${guidPattern})[^"']*["'][^>]*>`, 'i');
        const formActionRegex = new RegExp(`<form[^>]*action=["'][^"']*id=(${guidPattern})[^"']*["'][^>]*>`, 'ig');
        
        const respHandler = async (res) => {
          try {
            const u = res.url();
            if (!/panopto|embed\.aspx|Viewer\.aspx|EmbedSession/i.test(u)) return;
            if (panoptoResponseUrls.has(u)) return;
            panoptoResponseUrls.add(u);
            let text = '';
            try { text = await res.text(); } catch (e) { return; }
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
            console.error('    error in panopto response handler', err);
          }
        };

        try {
          console.log(`      (${i + 1}/${pagesToScan.length}) Visiting: ${p.url} (Attempt ${pass + 1})`);
          
          page.on('request', h);
          page.on('response', respHandler);
          await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
          try { await page.waitForTimeout(800); } catch(e){} 
          page.off('request', h);
          page.off('response', respHandler);

          const html = await page.content();
          const h5pRegex = /<iframe[^>]*src="[^"]*h5p\.com(?:%2F|\/)+content(?:%2F|\/)+([0-9]+)[^"]*"/ig;
          const h5p  = [...html.matchAll(h5pRegex)];
          const panoGuidsPerFrame = await H.extractPanoptoSessionGuids(page);

          if (panoGuidsPerFrame.length) {
            panoPageCount++;
            panoEmbeds += panoGuidsPerFrame.length;
            panoGuidsPerFrame.forEach(g => { if (g) sessionSet.add(g); });
            for (let j = 0; j < panoGuidsPerFrame.length; j++) {
              const guid = panoGuidsPerFrame[j] || '';
              SESSION_ROWS.push({ courseId, sessionId: guid });
            }
          }

          console.log(`        Panopto: ${panoGuidsPerFrame.length}, H5P: ${h5p.length}`);
          if (h5p.length)  { h5pPageCount++;  h5pEmbeds  += h5p.length;  }
          
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
      noOfDiscussionTopics: noOfDiscussionTopics,
      meanPctStudentsPosting: meanPctStudentsPosting,
      pagesFailed: pagesFailed
    });

    // --- Persist one CSV row for this course (atomic append) ---
    const lastMetric = METRICS[METRICS.length - 1];
    lastMetric.runId = runId;
    lastMetric.timestamp = (new Date()).toISOString();

    const csvCols = [
      lastMetric.courseId,
      `"${(lastMetric.courseName || '').replace(/"/g, '""')}"`,
      lastMetric.students,
      lastMetric.pagesPublished,
      lastMetric.pagesWithPanopto,
      lastMetric.panoptoVideos,
      lastMetric.pagesWithH5P,
      lastMetric.h5pItems,
      lastMetric.meanPercentViewed,
      lastMetric.medianPercentViewed,
      lastMetric.pctPagesViewedOnce,
      lastMetric.noOfQuizzes,
      lastMetric.quizzesSubmittedPct,
      lastMetric.noOfUngradedSurvey,
      lastMetric.ungradedSurveyPct,
      lastMetric.noOfOtherAssignments,
      lastMetric.otherAssignmentsSubmittedPct,
      lastMetric.noOfDiscussionTopics || 0,
      lastMetric.meanPctStudentsPosting || 0,
      lastMetric.pagesFailed || pagesFailed || 0,
      runId,
      lastMetric.timestamp
    ];
    const csvLine = csvCols.join(',');

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
  await fs.writeFile(panoptoCsvPath, stringify(SESSION_ROWS, { header: true }));
  console.log(`\n✅  appended course metrics to ${metricsCsvPath} and wrote panopto_session_ids-${runId}.csv in ${runDir}`);
} catch (e) {
  console.warn('Warning: could not write panopto session CSV for run:', e.message);
}
