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

## Assignment pages and flow

Teachers add pages as phone photos, scans, or PDFs. The browser converts
every page to a JPEG no larger than 1700 pixels on its long side (usually
200 to 400 KB) and uploads one page per request, because Netlify functions
cap a single request at about 6 MB. PDFs are split into pages with pdf.js.

Posting is three calls: `POST /api/assignments/create` (saves a draft),
`POST /api/assignments/pages/upload` once per page, then
`POST /api/assignments/publish`. Pages are served one at a time from
`GET /api/assignments/page`, with the same access rules as the assignment.

* Teachers choose a turnaround (24 to 96 hours). The due time starts when a
  Grade Angel accepts.
* Teachers can send an assignment to one Grade Angel. That Grade Angel can
  accept it or decline with a reason, which reopens it to everyone.
* A Grade Angel who cannot finish hands the work back with a reason.
* Teachers can cancel drafts and unaccepted assignments, which deletes the
  pages right away.
* Before accepting, a vetted Grade Angel can preview only the first two
  pages. Grade Angels never see the teacher's name.
* `assignment_events` keeps a history of every step and reason.

pdf.js and pdf-lib are served from `public/vendor/` rather than a CDN, so
school web filters that block outside script hosts do not break uploads.
