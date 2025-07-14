import { readFile, writeFile } from 'node:fs/promises';
import { parse }               from 'csv-parse/sync';
import { stringify }           from 'csv-stringify/sync';

/* read both CSVs */
const sessions = parse(await readFile('panopto_session_ids.csv'), { columns: true });
const stats    = parse(await readFile('panopto_stats.csv'), { columns: true });

/* join on sessionId */
const map = Object.fromEntries(stats.map(s => [s.sessionId, s]));
const joined = sessions.map(s => ({
  courseId     : s.courseId,
  sessionId    : s.sessionId,
  viewers      : map[s.sessionId]?.viewers      ?? 0,
  finished     : map[s.sessionId]?.finished     ?? 0,
  finishedPct  : map[s.sessionId]?.finishedPct  ?? 0
}));

await writeFile('course_panopto_engagement.csv',
                stringify(joined, { header: true }));
console.log('✅  wrote course_panopto_engagement.csv');
