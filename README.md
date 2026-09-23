# Grade Angels Network

Marketplace connecting teachers with Grade Angels who grade their work for pay.

Colors: white, seafoam green, and black. The palette lives at the top of `public/css/app.css`.

## Layout

* `public/` static pages, styles, and the shared `js/api.js` helper
* `netlify/functions/` API endpoints served under `/api/...`
* `netlify/lib/` shared helpers for the database, auth, Stripe, Checkr, and file storage
* `netlify/database/migrations/` Postgres schema

## Adding the logo

1. Put the logo file in `public/img/` (for example `public/img/logo.svg`).
2. In `public/js/api.js`, set `SITE_LOGO` to its path, for example `"/img/logo.svg"`.
3. Optionally replace `public/img/favicon.svg` for the browser tab icon.

## Running locally

```
npm install
npx netlify dev
```

## Deploying

In the Netlify project settings for grade angels network, link this
repository. No base directory is needed; Netlify reads `netlify.toml` at the
top of the repo. Set a `SESSION_SECRET` environment variable before going live.
