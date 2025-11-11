### Setup

```bash
npm install
cp .env.example .env    # then fill in your values
```

### Collect Panopto session IDs from Canvas

```bash
node run crawl_canvas
```

The first run opens a browser – log in to Canvas and click a Panopto link
so the cookies cover both domains. Close the window; cookies are saved to
`authStorage.json`.

**NOTE: Will only prompt for relogin to Canvas if authStorage.json is not present. Delete this file if getting 401 errors**

### Fetch viewer analytics in Panopto

1. Open your Panopto instance (e.g https://abc.cloud.panopto.eu) and log in.
2. Press F12 → Console.
3. Change START_DATE_INPUT and END_DATE_INPUT (need to restrict by date otherwise returns _all_ data on the video
4. Paste `crawl_panopto.js` and follow the prompt to choose apropriate `panopto_session_ids-*` file – it downloads `panopto_stats.csv`.

### Merge panopto data back into course data

```bash
npx electron merge_panopto_simple_picker.js
```
Pick appropriate `panopto_stats_*.csv` and `canvas_course_metrics-*.csv`
