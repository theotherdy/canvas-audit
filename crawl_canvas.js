/* crawl_canvas.js — collect every Panopto session GUID
   ----------------------------------------------------- */
import { chromium }        from '@playwright/test';
import { stringify }       from 'csv-stringify/sync';
import { promises as fs }  from 'node:fs';
import * as H              from './helpers.js';
import 'dotenv/config';

const { CANVAS_DOMAIN, COURSE_IDS, PAGE_LIMIT = 0, STORAGE_FILE } = process.env;
const COURSES = COURSE_IDS.split(',').map(s => s.trim());
const OUT     = [];

/* one-off login cookie jar (Canvas only) */
await H.ensureStorageState({ canvasDomain: CANVAS_DOMAIN,
                             storageFile : STORAGE_FILE });

const browser = await chromium.launch({ headless: true });
const ctx     = await browser.newContext({ storageState: STORAGE_FILE });
const page    = await ctx.newPage();

/* grab Canvas → session IDs */
for (const courseId of COURSES) {
  let pages = await H.listCanvasPages(courseId);
  if (+PAGE_LIMIT) pages = pages.slice(0, +PAGE_LIMIT);

  for (const p of pages) {
    const url = `${CANVAS_DOMAIN}/courses/${courseId}/pages/${p.url}`;
    if(url=="https://canvas.ox.ac.uk/courses/262596/pages/neurology"){

        /* collect requests that fire **during this navigation** */
        const captured = [];
        const handler  = req => captured.push(req.url());
        page.on('request', handler);

        await page.goto(url, { waitUntil: 'networkidle' });
        page.off('request', handler);               // stop listening

        captured
        .filter(u => /Embed\.aspx/i.test(u))
        .forEach(u => {
            const m = /[?&]id=([0-9a-f-]{36})/i.exec(u);
            if (m) OUT.push({ courseId, sessionId: m[1] });
        });
    }
  }
}

await browser.close();
await fs.writeFile('panopto_session_ids.csv', stringify(OUT, { header: true }));
console.log('✅  wrote panopto_session_ids.csv');