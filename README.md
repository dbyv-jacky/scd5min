# GitHub Worker Pack

Board: `親子五分鐘` (`scd5min`)

Exported: 2026-04-22T07:04:27.822Z

This generated repo now follows the older `social media wall` layout more closely while deploying as a Cloudflare Worker with static assets. Source runtime files live at the repo root, `scripts/build-worker-assets.js` rebuilds `dist/`, and `wrangler deploy` publishes the Worker.

## What is included

- `wrangler.jsonc`
- `worker/index.mjs`
- `index.html`
- `embed.html`
- `app.js`
- `styles.css`
- `board.config.json`
- `collector.config.json`
- `feed.json` as the current feed
- `feed.seed.json` as the builder-side seed copy
- `collected-feed.test.json` as the old-wall style sample fallback
- `board.data.json` as the current precomputed runtime payload
- `.collector-cache/` media captured with the saved board revision
- `content-collector.js`
- `scripts/build-worker-assets.js`
- `scripts/refresh-board.js`
- `.github/workflows/refresh-and-deploy.yml`
- `dist/` with the current built site

## Update schedule

The generated workflow refreshes and deploys this board at:

- 12:30 PM Asia/Hong_Kong
- 5:00 PM Asia/Hong_Kong

GitHub Actions cron values:

- `30 4 * * *`
- `0 9 * * *`

## Required GitHub Actions secrets and variables

- Secret: `CLOUDFLARE_API_TOKEN`
- Secret: `CLOUDFLARE_ACCOUNT_ID`
- Variable: `PRODUCTION_SITE_URL=https://scd5min.jacky-167.workers.dev/`

This pack is already configured to deploy the Worker named `scd5min` from `wrangler.jsonc`. Keep that name unchanged to preserve the live URL `https://scd5min.jacky-167.workers.dev/`.

## Local run

```bash
npm ci
npm run build
npm run preview
```

Local validation before publish:

```bash
npm run validate:worker
```

Local Worker publish:

```bash
npm run deploy:worker
```

Optional refresh-only run:

```bash
npm run refresh:local
```

Generated repo root:

`/Users/jcm2/Documents/Codex/social board builder/generated-packages/scd5min/github-pack`

Built static site:

`/Users/jcm2/Documents/Codex/social board builder/generated-packages/scd5min/github-pack/dist`
