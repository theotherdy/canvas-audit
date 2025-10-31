// crawl_panopto.js (patched) — paste into browser console
(async () => {
  // --- CONFIG: put human-friendly dates here ---
  // Examples: '2024-10-01', '1 Oct 2024', 'Oct 1 2024 09:00', '2024-10-01T09:00'
  const START_DATE_INPUT = '2024-10-01';   // inclusive start
  const END_DATE_INPUT   = '2025-09-30';   // inclusive end

  /*************************************************************************
   * Helper: convert many human date formats to a UTC ISO 8601 string
   * Returns e.g. "2024-10-01T00:00:00Z"
   * Will try to be forgiving:
   *  - If input is YYYY-MM-DD it treats as that date at 00:00 UTC.
   *  - If input already contains a time or timezone, it's parsed and converted to UTC.
   *  - Throws on invalid date.
   *************************************************************************/
  function toUtcIso(input, isEnd = false) {
    if (!input || typeof input !== 'string') {
      throw new Error('Invalid date input: must be a non-empty string');
    }

    const trimmed = input.trim();

    // ISO date-only 'YYYY-MM-DD' (common case)
    const dateOnlyMatch = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);

    if (dateOnlyMatch) {
      // start of day for startDate, end of day for endDate (so inclusive)
      if (isEnd) {
        // end of day: 23:59:59.999 -> convert to ISO but Panopto may expect second precision — we use 23:59:59Z to be safe
        return new Date(trimmed + 'T23:59:59Z').toISOString();
      } else {
        return new Date(trimmed + 'T00:00:00Z').toISOString();
      }
    }

    // If input already contains a timezone or time, let Date parse it.
    // Note: Date parsing can be implementation-dependent, but this is flexible for many human strings.
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      // Try adding UTC marker if user provided 'YYYY/MM/DD' or other ambiguous formats
      // Fallback: try Date.parse with replacement of '/' to '-'
      const alt = new Date(trimmed.replace(/\//g, '-'));
      if (!Number.isNaN(alt.getTime())) {
        if (isEnd && /^\d{4}-\d{2}-\d{2}$/.test(alt.toISOString().slice(0,10))) {
          // If alt parsed to date-only, set end-of-day
          return new Date(alt.toISOString().slice(0,10) + 'T23:59:59Z').toISOString();
        }
        return alt.toISOString();
      }
      throw new Error(`Could not parse date input: "${input}"`);
    }

    // If user supplied a date-time without timezone, `new Date()` interprets as local time.
    // Convert to ISO UTC which includes timezone conversion.
    // If user supplied a plain date-time and meant local => this will convert to UTC (good).
    // For an inclusive end date, if they passed a date-only with time omitted, user should pass 'YYYY-MM-DD' which was handled above.
    if (isEnd) {
      // If user passed a plain date like '1 Oct 2024' (not matched earlier), they probably expect end-of-day.
      // We'll detect if their string included a time component. If not, set to end-of-day in that date's UTC.
      const hasTimeComponent = /T|\d:\d/.test(trimmed);
      if (!hasTimeComponent) {
        // get the parsed date's YYYY-MM-DD in UTC and set 23:59:59Z
        const ymd = parsed.toISOString().slice(0, 10);
        return new Date(ymd + 'T23:59:59Z').toISOString();
      }
    }

    return parsed.toISOString();
  }

  // Convert inputs to ISO UTC
  let START_ISO, END_ISO;
  try {
    START_ISO = toUtcIso(START_DATE_INPUT, false);
    END_ISO   = toUtcIso(END_DATE_INPUT, true);
  } catch (err) {
    console.error('Date parsing error:', err.message);
    return;
  }

  console.log('Using date range (UTC ISO):', START_ISO, '→', END_ISO);

  /* ── 0. Read the CSV from disk via a file-picker ─────────── */
  const [file] = await new Promise(r => {
    const i = Object.assign(document.createElement('input'),
       {type:'file', accept:'.csv'});
    i.onchange = () => r(i.files); i.click();
  });
  const text  = await file.text();
  const rows  = text.trim().split(/\r?\n/).slice(1)   // skip header
                    .map(r => r.split(','));
  const jobs  = rows.map(([courseId, sessionId]) => ({ courseId, sessionId }));

  /* ── 1. Helper – fetch all pages (pageNumber) ─────────────  */
  async function viewers(sessionId, startIso, endIso) {
    const pageSize = 100;
    let page = 0, out = [];

    // encode the dates so they can safely go in a URL
    const s = encodeURIComponent(startIso);
    const e = encodeURIComponent(endIso);

    while (true) {
      const r = await fetch(
        `/Panopto/api/v1/sessions/${sessionId}/viewers?pageNumber=${page}&pageSize=${pageSize}&startDate=${s}&endDate=${e}`,
        { credentials:'include' });
      if (!r.ok) {
        throw new Error(`Panopto viewers fetch failed: ${r.status} ${r.statusText}`);
      }
      const b = await r.json();
      const chunk = Array.isArray(b) ? b : b.Results ?? [];
      out = out.concat(chunk);
      if (chunk.length < pageSize) return out;
      page += 1;
    }
  }

  /* ── 2. Process every session ─────────────────────────────  */
  const outLines = ['courseId,sessionId,viewers,finished,finishedPct'];
  for (const j of jobs) {
    try {
      const v   = await viewers(j.sessionId, START_ISO, END_ISO);
      const fin = v.filter(x => x.PercentCompleted >= 90).length;
      outLines.push(
        [j.courseId, j.sessionId, v.length, fin,
         v.length ? (fin/v.length*100).toFixed(1) : 0].join(',')
      );
      console.log(`✓ ${j.sessionId} (${v.length} rows)`);
    } catch (err) {
      console.error(`✖ ${j.sessionId} — error fetching viewers:`, err.message);
      outLines.push([j.courseId, j.sessionId, 'ERROR', '', ''].join(','));
    }
  }

  /* ── 3. Download CSV ─────────────────────────────────────── */
  const blob = new Blob([outLines.join('\n')], {type:'text/csv'});
  const a    = Object.assign(document.createElement('a'),
                {download:`panopto_stats_${START_ISO.slice(0,10)}_to_${END_ISO.slice(0,10)}.csv`,
                 href: URL.createObjectURL(blob)});
  a.click(); URL.revokeObjectURL(a.href);
})();
