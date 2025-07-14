(async () => {
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
  async function viewers(sessionId) {
    const pageSize = 100;
    let page = 0, out = [];
    while (true) {
      const r = await fetch(
        `/Panopto/api/v1/sessions/${sessionId}/viewers?pageNumber=${page}&pageSize=${pageSize}`,
        { credentials:'include' });
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
    const v   = await viewers(j.sessionId);
    const fin = v.filter(x => x.PercentCompleted >= 90).length;
    outLines.push(
      [j.courseId, j.sessionId, v.length, fin,
       v.length ? (fin/v.length*100).toFixed(1) : 0].join(',')
    );
    console.log(`✓ ${j.sessionId} (${v.length} rows)`);
  }

  /* ── 3. Download CSV ─────────────────────────────────────── */
  const blob = new Blob([outLines.join('\n')], {type:'text/csv'});
  const a    = Object.assign(document.createElement('a'),
                {download:'panopto_stats.csv',
                 href: URL.createObjectURL(blob)});
  a.click(); URL.revokeObjectURL(a.href);
})();
