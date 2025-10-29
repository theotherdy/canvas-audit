// merge_panopto_simple_picker.js  (ESM)
// Run: npx electron merge_panopto_simple_picker.js
// Requires: npm i electron csv-parse csv-stringify

import { app, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

app.whenReady().then(async () => {
  const panoptoPick = await dialog.showOpenDialog({
    title: 'Select panopto_stats.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['openFile']
  });
  const panoptoPath = panoptoPick.filePaths && panoptoPick.filePaths[0];
  if (!panoptoPath) return app.quit();

  const metricsPick = await dialog.showOpenDialog({
    title: 'Select canvas_course_metrics-<run>.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['openFile']
  });
  const metricsPath = metricsPick.filePaths && metricsPick.filePaths[0];
  if (!metricsPath) return app.quit();

  // --- Read both CSVs ---
  const panoptoText = fs.readFileSync(panoptoPath, 'utf8');
  const metricsText = fs.readFileSync(metricsPath, 'utf8');
  const panoptoRows = parse(panoptoText, { columns: true, skip_empty_lines: true });
  const metricsRows = parse(metricsText, { columns: true, skip_empty_lines: true });

  // --- Aggregate Panopto data per course ---
  const agg = {};
  for (const r of panoptoRows) {
    const courseId = (r.courseId || r.courseid || '').trim();
    if (!courseId) continue;

    const viewers = Number(r.viewers ?? r.Viewers ?? 0);
    const finPct = Number(r.finishedPct ?? r.finishedPct ?? r.finished ?? 0);

    if (!agg[courseId]) agg[courseId] = { sumFinishedPct: 0, sessions: 0, maxViewers: 0 };
    if (!isNaN(finPct)) { agg[courseId].sumFinishedPct += finPct; agg[courseId].sessions++; }
    if (!isNaN(viewers) && viewers > agg[courseId].maxViewers) agg[courseId].maxViewers = viewers;
  }

  // --- Merge into Canvas metrics file ---
  const existingCols = Object.keys(metricsRows[0] || {});
  const newCols = ['meanPanoptoFinishedPct', 'maxPanoptoViewers'];
  const outCols = existingCols.concat(newCols);

  let coursesWithPanopto = 0;
  const totalCourses = metricsRows.length;

  const outRows = metricsRows.map(row => {
    const courseId = (row.courseId || row.courseid || '').toString();
    const a = agg[courseId];
    const out = { ...row };

    if (!a || a.sessions === 0) {
      out.meanPanoptoFinishedPct = '';
      out.maxPanoptoViewers = '';
    } else {
      out.meanPanoptoFinishedPct = (a.sumFinishedPct / a.sessions).toFixed(1);
      out.maxPanoptoViewers = a.maxViewers;
      coursesWithPanopto++;
    }
    return out;
  });

  // --- Write new CSV ---
  const outCsv = stringify(outRows, { header: true, columns: outCols });
  const outPath = path.join(
    path.dirname(metricsPath),
    path.basename(metricsPath, '.csv') + '-with-panopto.csv'
  );
  fs.writeFileSync(outPath, 'utf8');
  fs.writeFileSync(outPath, outCsv, 'utf8');

  // --- Summary log ---
  const coursesWithoutPanopto = totalCourses - coursesWithPanopto;
  console.log('\n📊 === Panopto Merge Summary ===');
  console.log(`Courses in metrics file:      ${totalCourses}`);
  console.log(`Courses with Panopto data:    ${coursesWithPanopto}`);
  console.log(`Courses without Panopto data: ${coursesWithoutPanopto}`);
  console.log('Output file:                  ' + outPath + '\n');

  await dialog.showMessageBox({
    type: 'info',
    message: '✅ Panopto metrics merged successfully!',
    detail:
      `Courses processed: ${totalCourses}\n` +
      `With Panopto data: ${coursesWithPanopto}\n` +
      `Without data: ${coursesWithoutPanopto}\n\n` +
      `Saved to:\n${outPath}`
  });

  app.quit();
});
