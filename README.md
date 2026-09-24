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

A Grade Angel's account goes live, and the server lets them accept work, only
after five steps on `/grade-angel-setup.html`, done in order (see
`netlify/lib/grade-angel.mts`):

1. Personal information (legal name, phone, city, state, ZIP)
2. Teaching background (experience, degree, certificate, subjects, bio)
3. Agreements (confidentiality, plus the independent contractor agreement
   signed by typing their full legal name)
4. A clear background check (Checkr, or recorded by staff on the admin
   dashboard's user page)
5. A Stripe Connect account that can receive payouts

Until they are live they can still sign in, use their dashboard, and browse
open assignments. While `CHECKR_API_KEY` or `STRIPE_SECRET_KEY` is not set,
steps 4 and 5 show as opening soon, so Grade Angels can finish steps 1 to 3
now; those steps switch on by themselves once the keys are added.

Environment variables used: `SESSION_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `CHECKR_API_KEY`, `CHECKR_WEBHOOK_SECRET`,
`OWNER_EMAILS`, and optionally `CHECKR_PACKAGE`. On a real deploy both webhooks refuse every
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

## Payouts

The platform keeps 20% (`PLATFORM_FEE_RATE` in `netlify/lib/grade-angel.mts`).
The teacher pays the full amount through Stripe Checkout into the platform's
Stripe balance. When the teacher marks the work complete,
`netlify/lib/payouts.mts` transfers the other 80% to the Grade Angel's
connected Stripe account. Stripe's card fees come out of the platform's share.

* Each transfer names the teacher's charge as its `source_transaction`, so it
  waits for those funds to settle instead of failing.
* A lock on the payment row, plus a check for an existing transfer, keeps a
  Grade Angel from ever being paid twice for the same assignment.
* If the Grade Angel's Stripe account is not ready, the payout is `held`.
* `payouts-retry` runs hourly. It releases held payouts once the Grade Angel's
  account is ready and retries failed ones up to 24 times. After that, an
  admin can retry with `POST /api/admin/payouts/retry` and an `assignment_id`.

## Profiles and reviews

Everyone has an About me with a photo, bio, star rating, and reviews, shown
on their dashboard banner and on `/profile.html?id=`. Teachers choose a
display name; Grade Angels only ever see that, never the teacher's real
name, school, or contact details.

After an assignment is completed, the teacher and the Grade Angel can each
leave one review (1 to 5 stars and a comment) with `POST /api/reviews`. A
review stays private until the other person reviews too, or 14 days pass
(`REVIEW_REVEAL_DAYS` in `netlify/lib/profiles.mts`), so neither side
writes theirs in reaction to the other's. Reviews have a `hidden` flag for
future admin moderation.

Photos are cropped to a square and shrunk to 400 pixels in the browser,
stored in Netlify Blobs under `avatars/`, and only served to signed in
members.

## Assignment chat

The teacher and the Grade Angel on an assignment can message each other
from the assignment page (`/api/messages`). The chat opens when a Grade
Angel accepts and becomes read only once they are paid out, or if the
assignment is cancelled (`netlify/lib/chat.mts`). Each thread belongs to one
Grade Angel, so a new Grade Angel after a hand back starts fresh. Email
addresses and phone numbers are replaced with "[contact info removed]".
The page checks for new messages every 4 seconds while visible and every 30
seconds in the background, and stops once the chat closes. Dashboards show
unread counts.

## Admin dashboard

`/admin.html` is for staff. It has an overview (headline numbers, money,
sign ups, and a needs attention list), plus Users, Assignments, Payouts,
Reviews, Staff, Activity log, and My account tabs.

Staff are users with role `admin` and a `staff_level`:

* support: view everything, hide reviews, suspend users, record background checks
* manager: support, plus retry payouts, cancel unpaid assignments, download the payments spreadsheet
* owner: everything on the dashboard except staff access

Only the master admin approves staff and changes access, from the Master
admin tab. haynes.tenise@gmail.com is built in as master admin
(`netlify/lib/staff.mts`); more can be added with the `MASTER_EMAILS`
setting. The master admin signs up on the normal Create account page with
that email and becomes master admin automatically.

Other staff request access from the Staff sign in page (footer link). They
cannot sign in until the master admin approves them, unless their email was
pre-approved. Approval, level, and suspension are read from the database on
every request (`requireStaff`, `isActiveStaff`), so changes apply on the
next click, and a pending request gets no extra access anywhere.
Every staff action goes to `admin_actions`, shown in the Activity log.

Suspended accounts cannot sign in, are signed out on their next page load,
and are refused by every endpoint that changes anything.
