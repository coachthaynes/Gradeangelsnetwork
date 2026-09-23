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

## Grade Angel setup

A Grade Angel must finish three steps on `/grade-angel-setup.html` before
the server lets them accept work (see `netlify/lib/grade-angel.mts`):

1. Profile plus the confidentiality agreement
2. A clear background check (Checkr, or recorded by an admin through
   `POST /api/admin/background-check` with `user_id` and `status`)
3. A Stripe Connect account that can receive payouts

Environment variables used: `SESSION_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `CHECKR_API_KEY`, `CHECKR_WEBHOOK_SECRET`, and
optionally `CHECKR_PACKAGE`. On a real deploy both webhooks refuse every
request until their secret is set; only local `netlify dev` skips the check.
