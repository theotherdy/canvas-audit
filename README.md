### Setup

```bash
npm install
cp .env.example .env    # then fill in your values

### Collect Panopto session IDs from Canvas

```bash
npm run crawl:canvas

The first run opens a browser – log in to Canvas and click a Panopto link
so the cookies cover both domains. Close the window; cookies are saved to
authStorage.json.

### Fetch viewer analytics in Panopto

1. Open your Panopto instance (e.g https://abc.cloud.panopto.eu) and log in.

2. Press F12 → Console.

3. Paste scripts/pano_console_fetch.js and follow the prompt – it downloads
panopto_stats.csv.

### Merge both CSVs

```bash
npm run merge    