// End to end test of the real Netlify functions against a local Postgres.
// Needs a throwaway Postgres with every migration applied. Point TEST_DB_URL
// at it. Everything in that database is wiped at the start of each run.
import pg from 'pg';
const DB_URL = process.env.TEST_DB_URL;
if (!DB_URL) {
  console.error('Set TEST_DB_URL to a throwaway Postgres database (it gets wiped).');
  process.exit(2);
}
process.env.NETLIFY_DB_URL = DB_URL;
process.env.SESSION_SECRET = 'test-secret';
globalThis.Netlify = { env: { get: (k) => process.env[k] } };

const OUT = new URL('./.out/', import.meta.url);
const handlers = {};
async function fn(name) {
  if (!handlers[name]) handlers[name] = (await import(new URL(`${name}.mjs`, OUT))).default;
  return handlers[name];
}

let failures = 0;
function check(label, ok, extra = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && extra ? '  >> ' + extra : ''}`);
}

// A signed in person: keeps their session cookie between calls.
function client(label) {
  let cookie = '';
  return {
    label,
    async call(name, method, path, { json, form } = {}) {
      const headers = {};
      if (cookie) headers.cookie = cookie;
      let body;
      if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
      if (form) body = form;
      const req = new Request(`https://ga.test${path}`, { method, headers, body });
      const res = await (await fn(name))(req, { deploy: { context: 'production' } });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const type = res.headers.get('content-type') || '';
      const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
      return { status: res.status, data };
    },
  };
}

const db = new pg.Client({ connectionString: DB_URL });
await db.connect();
const q = (text, params) => db.query(text, params).then((r) => r.rows);

// Fresh data for every run.
await q(`TRUNCATE users, assignments, payments, reviews, assignment_pages, assignment_events, assignment_messages,
         assignment_chat_reads, admin_actions, staff_invites, leads, email_sends RESTART IDENTITY CASCADE`);
// The cleanup above cascades into tables that reference users (templates,
// settings, calendar), so reload their starting rows from the migration.
import fs from 'fs';
await q(`TRUNCATE email_templates, site_settings, marketing_posts RESTART IDENTITY CASCADE`);
await db.query(fs.readFileSync(new URL('../netlify/database/migrations/20261001000000_marketing/migration.sql', import.meta.url), 'utf8'));

// ---------- Accounts ----------
const teacher = client('teacher');
const angel = client('angel');
const master = client('master');
const staffer = client('staffer');
const stranger = client('stranger');

let r = await teacher.call('auth-signup', 'POST', '/api/auth/signup', { json: { role: 'teacher', full_name: 'Tia Haynes', email: 'tia@example.com', password: 'password1' } });
check('teacher signs up', r.status === 201 && r.data.user.role === 'teacher', JSON.stringify(r.data));
r = await angel.call('auth-signup', 'POST', '/api/auth/signup', { json: { role: 'grade_angel', full_name: 'Jordan Lee', email: 'jordan@example.com', password: 'password1' } });
check('grade angel signs up', r.status === 201, JSON.stringify(r.data));
r = await master.call('auth-signup', 'POST', '/api/auth/signup', { json: { role: 'teacher', full_name: 'Tenise Haynes', email: 'haynes.tenise@gmail.com', password: 'Te20nisX' } });
check('master email becomes approved master admin', r.status === 201 && r.data.user.role === 'admin' && r.data.user.staff_level === 'owner', JSON.stringify(r.data));
r = await teacher.call('auth-me', 'GET', '/api/auth/me');
check('auth me returns teacher', r.data.user?.email === 'tia@example.com');

// ---------- Grade Angel setup ----------
r = await angel.call('grade-angel-profile', 'POST', '/api/grade-angel/profile', { json: { step: 'background' } });
check('cannot skip to step 2', r.status === 409, JSON.stringify(r.data));
r = await angel.call('grade-angel-profile', 'POST', '/api/grade-angel/profile', { json: { step: 'personal', full_name: 'Jordan Lee', phone: '904 555 0123', city: 'Middleburg', state: 'FL', zip: '32068' } });
check('step 1 personal', r.status === 200 && r.data.status.personal_complete, JSON.stringify(r.data));
r = await angel.call('grade-angel-profile', 'POST', '/api/grade-angel/profile', { json: { step: 'background', qualifications: 'retired_teacher', highest_degree: 'master', teaching_certificate: 'current', certification_state: 'FL', years_experience: 22, subjects: ['Math', 'Reading'], grade_levels: ['elementary'], assignment_types: ['combo', 'multiple_choice'], bio: 'Retired fourth grade teacher, 22 years.' } });
check('step 2 background', r.status === 200 && r.data.status.profile_complete, JSON.stringify(r.data));
r = await angel.call('grade-angel-profile', 'POST', '/api/grade-angel/profile', { json: { step: 'agreement', confidentiality_agreed: true, contractor_agreed: true, signature_name: 'Wrong Name' } });
check('wrong signature rejected', r.status === 400);
r = await angel.call('grade-angel-profile', 'POST', '/api/grade-angel/profile', { json: { step: 'agreement', confidentiality_agreed: true, contractor_agreed: true, signature_name: 'jordan  lee' } });
check('step 3 agreements', r.status === 200 && r.data.status.info_complete && !r.data.status.ready, JSON.stringify(r.data));
r = await angel.call('grade-angel-setup', 'GET', '/api/grade-angel/setup');
check('setup shows checkr and stripe not connected', r.data.status.checkr_available === false && r.data.status.stripe_available === false);
r = await angel.call('background-check-invite', 'POST', '/api/background-check/invite', { json: {} });
check('background check says not connected', r.status === 501, JSON.stringify(r.data));

// ---------- Staff approval ----------
r = await staffer.call('staff-request', 'POST', '/api/staff/request', { json: { full_name: 'Maria Lopez', email: 'maria@example.com', password: 'password1' } });
check('staff request created, not approved', r.status === 201 && r.data.approved === false, JSON.stringify(r.data));
r = await staffer.call('auth-login', 'POST', '/api/auth/login', { json: { email: 'maria@example.com', password: 'password1' } });
check('unapproved staff cannot sign in', r.status === 403, JSON.stringify(r.data));
r = await master.call('admin-master', 'GET', '/api/admin/master');
check('master sees pending request', r.status === 200 && r.data.pending.length === 1, JSON.stringify(r.data).slice(0, 300));
const mariaId = r.data.pending[0]?.id;
r = await master.call('admin-master', 'POST', '/api/admin/master', { json: { action: 'approve', user_id: mariaId, staff_level: 'support' } });
check('master approves as support', r.status === 200);
r = await staffer.call('auth-login', 'POST', '/api/auth/login', { json: { email: 'maria@example.com', password: 'password1' } });
check('approved staff signs in', r.status === 200 && r.data.user.role === 'admin', JSON.stringify(r.data));
r = await staffer.call('admin-master', 'GET', '/api/admin/master');
check('support cannot open master admin', r.status === 403);
r = await staffer.call('admin-overview', 'GET', '/api/admin/overview');
check('support sees overview', r.status === 200 && r.data.users.grade_angels === 1, JSON.stringify(r.data).slice(0, 300));

// Support records the background check; payouts ready is set directly (no Stripe here).
const angelId = (await q(`SELECT id FROM users WHERE email = 'jordan@example.com'`))[0].id;
r = await staffer.call('admin-users', 'POST', '/api/admin/users', { json: { user_id: angelId, action: 'set_background_check', status: 'clear' } });
check('support records background check clear', r.status === 200, JSON.stringify(r.data));
await q(`UPDATE users SET stripe_payouts_ready = true, stripe_account_id = 'acct_test' WHERE id = $1`, [angelId]);
r = await angel.call('grade-angel-setup', 'GET', '/api/grade-angel/setup');
check('grade angel is live', r.data.status.ready === true, JSON.stringify(r.data.status));

// ---------- Profiles ----------
r = await teacher.call('profile-me', 'POST', '/api/profile', { json: { bio: 'Fourth grade, Middleburg.', display_name: 'Ms. Haynes' } });
check('teacher saves display name', r.status === 200 && r.data.profile.public_name === 'Ms. Haynes', JSON.stringify(r.data));
const photo = new FormData();
photo.set('file', new File([new Uint8Array([255, 216, 255, 224, 1, 2, 3])], 'p.jpg', { type: 'image/jpeg' }));
r = await angel.call('profile-photo', 'POST', '/api/profile/photo', { form: photo });
check('grade angel uploads photo', r.status === 200 && r.data.photo_url, JSON.stringify(r.data));
r = await teacher.call('grade-angels-list', 'GET', '/api/grade-angels');
check('teacher sees live grade angel with photo', r.data.grade_angels?.length === 1 && r.data.grade_angels[0].photo_url, JSON.stringify(r.data));

// ---------- Posting an assignment ----------
r = await teacher.call('assignments-create', 'POST', '/api/assignments/create', { json: { title: 'Fractions quiz', subject: 'Math', grade_level: '5th grade', assignment_type: 'combo', rate_per_page_cents: 100, turnaround_hours: 48, instructions: 'Key on last page' } });
check('create draft', r.status === 201 && r.data.assignment.status === 'draft', JSON.stringify(r.data));
const aid = r.data.assignment.id;
for (let i = 0; i < 3; i++) {
  const f = new FormData();
  f.set('assignment_id', String(aid)); f.set('page_index', String(i)); f.set('width', '100'); f.set('height', '130');
  f.set('file', new File([new Uint8Array([255, 216, 255, i])], `p${i}.jpg`, { type: 'image/jpeg' }));
  r = await teacher.call('assignments-pages-upload', 'POST', '/api/assignments/pages/upload', { form: f });
}
check('upload pages', r.status === 200, JSON.stringify(r.data));
r = await teacher.call('assignments-publish', 'POST', '/api/assignments/publish', { json: { assignment_id: aid, expected_pages: 4 } });
check('publish refuses missing page', r.status === 409);
r = await teacher.call('assignments-publish', 'POST', '/api/assignments/publish', { json: { assignment_id: aid, expected_pages: 3 } });
check('publish', r.status === 200 && r.data.assignment.page_count === 3, JSON.stringify(r.data));

r = await angel.call('assignments-list', 'GET', '/api/assignments/list?scope=open');
check('grade angel sees open work with earnings and teacher display name', r.data.assignments?.[0]?.earnings_cents === 240 && r.data.assignments[0].teacher_name === 'Ms. Haynes', JSON.stringify(r.data).slice(0, 400));
r = await angel.call('assignments-page', 'GET', `/api/assignments/page?assignment_id=${aid}&page=1`);
check('preview page 2 allowed', r.status === 200);
r = await angel.call('assignments-page', 'GET', `/api/assignments/page?assignment_id=${aid}&page=2`);
check('page 3 blocked before accepting', r.status === 403);
r = await stranger.call('assignments-get', 'GET', `/api/assignments/get?id=${aid}`);
check('signed out cannot view', r.status === 401);

// ---------- Accept, chat, submit ----------
r = await angel.call('assignments-accept', 'POST', '/api/assignments/accept', { json: { assignment_id: aid } });
check('accept', r.status === 200 && r.data.assignment.due_at, JSON.stringify(r.data));
r = await angel.call('assignments-page', 'GET', `/api/assignments/page?assignment_id=${aid}&page=2`);
check('all pages after accepting', r.status === 200);
r = await angel.call('messages', 'POST', `/api/messages?after_id=0`, { json: { assignment_id: aid, body: 'Hi! Call me at 904 555 0123 with questions.' } });
check('grade angel sends chat, phone removed', r.status === 201 && r.data.messages[0].body.includes('[contact info removed]') && r.data.messages[0].redacted, JSON.stringify(r.data).slice(0, 300));
r = await teacher.call('assignments-list', 'GET', '/api/assignments/list');
check('teacher sees 1 unread message', r.data.assignments?.[0]?.unread_messages === 1, JSON.stringify(r.data.assignments?.[0]));
r = await teacher.call('messages', 'GET', `/api/messages?assignment_id=${aid}&after_id=0`);
check('teacher reads chat', r.status === 200 && r.data.chat.open && r.data.messages.length === 1);
r = await teacher.call('assignments-list', 'GET', '/api/assignments/list');
check('unread cleared after reading', r.data.assignments?.[0]?.unread_messages === 0);
const graded = new FormData();
graded.set('assignment_id', String(aid)); graded.set('file', new File([new Uint8Array([37, 80, 68, 70])], 'graded.pdf', { type: 'application/pdf' }));
r = await angel.call('assignments-submit', 'POST', '/api/assignments/submit', { form: graded });
check('submit graded work', r.status === 200 && r.data.assignment.status === 'submitted', JSON.stringify(r.data));

// ---------- Pay and complete (Stripe not connected here) ----------
r = await teacher.call('assignments-pay', 'POST', '/api/assignments/pay', { json: { assignment_id: aid, success_url: 'https://ga.test/x' } });
check('pay says Stripe not connected', r.status === 501, JSON.stringify(r.data));
await q(`INSERT INTO payments (assignment_id, amount_cents, platform_fee_cents, status, paid_at) VALUES ($1, 300, 60, 'paid', NOW())`, [aid]);
r = await teacher.call('assignments-complete', 'POST', '/api/assignments/complete', { json: { assignment_id: aid } });
check('complete runs, payout fails without Stripe', r.status === 200 && r.data.assignment.status === 'completed', JSON.stringify(r.data));
const pay = (await q(`SELECT payout_status, payout_attempts FROM payments WHERE assignment_id = $1`, [aid]))[0];
check('payout recorded as failed for retry', pay.payout_status === 'failed' && pay.payout_attempts === 1, JSON.stringify(pay));
r = await teacher.call('messages', 'GET', `/api/messages?assignment_id=${aid}`);
check('chat still open until paid out', r.data.chat.open === true);
await q(`UPDATE payments SET payout_status = 'transferred' WHERE assignment_id = $1`, [aid]);
r = await angel.call('messages', 'POST', `/api/messages`, { json: { assignment_id: aid, body: 'thanks' } });
check('chat closed after payout', r.status === 409);

// ---------- Reviews ----------
r = await teacher.call('reviews-create', 'POST', '/api/reviews', { json: { assignment_id: aid, rating: 5, comment: 'Fast and careful' } });
check('teacher reviews grade angel', r.status === 201, JSON.stringify(r.data));
r = await teacher.call('user-profile', 'GET', `/api/users/profile?id=${angelId}`);
check('review hidden until both review', r.data.profile.rating.count === 0, JSON.stringify(r.data.profile.rating));
r = await angel.call('reviews-create', 'POST', '/api/reviews', { json: { assignment_id: aid, rating: 4 } });
check('grade angel reviews teacher', r.status === 201);
r = await teacher.call('user-profile', 'GET', `/api/users/profile?id=${angelId}`);
check('both reviews now visible', r.data.profile.rating.count === 1 && r.data.profile.rating.average === 5 && r.data.profile.assignments_completed === 1, JSON.stringify(r.data.profile).slice(0, 300));
r = await teacher.call('reviews-create', 'POST', '/api/reviews', { json: { assignment_id: aid, rating: 1 } });
check('cannot review twice', r.status === 409);

// ---------- Admin ----------
r = await staffer.call('admin-assignments', 'GET', '/api/admin/assignments?q=frac');
check('admin search assignments', r.data.assignments?.length === 1, JSON.stringify(r.data).slice(0, 200));
r = await staffer.call('admin-payments', 'GET', '/api/admin/payments');
check('admin payments list', r.data.payments?.length === 1);
r = await staffer.call('admin-payments', 'GET', '/api/admin/payments?format=csv');
check('support cannot export csv', r.status === 403);
r = await master.call('admin-payments', 'GET', '/api/admin/payments?format=csv');
check('master exports csv', r.status === 200 && new TextDecoder().decode(r.data).startsWith('id,assignment_id'));
r = await staffer.call('admin-users', 'GET', `/api/admin/users?id=${angelId}`);
check('admin user detail', r.data.user?.email === 'jordan@example.com' && r.data.assignments.length === 1);
r = await staffer.call('admin-users', 'POST', '/api/admin/users', { json: { user_id: angelId, action: 'suspend', reason: 'Testing suspension' } });
check('suspend user', r.status === 200);
r = await angel.call('auth-me', 'GET', '/api/auth/me');
check('suspended user signed out', r.data.user === null && r.data.suspended);
r = await angel.call('auth-login', 'POST', '/api/auth/login', { json: { email: 'jordan@example.com', password: 'password1' } });
check('suspended user cannot sign in', r.status === 403);
r = await staffer.call('admin-users', 'POST', '/api/admin/users', { json: { user_id: angelId, action: 'unsuspend' } });
r = await master.call('admin-activity', 'GET', '/api/admin/activity');
check('activity log records actions', r.data.actions?.length >= 4, JSON.stringify(r.data.actions?.map((a) => a.action)));
r = await master.call('admin-master', 'POST', '/api/admin/master', { json: { action: 'revoke', user_id: mariaId } });
r = await staffer.call('admin-overview', 'GET', '/api/admin/overview');
check('revoked staff blocked on next request', r.status === 403);
r = await master.call('admin-overview', 'GET', '/api/admin/overview');
check('master overview money', r.data.money?.fees_cents === 60 && r.data.me.is_master === true, JSON.stringify(r.data.money));

// ---------- Password ----------
r = await teacher.call('account-password', 'POST', '/api/account/password', { json: { current_password: 'password1', new_password: 'newpassword2' } });
check('change password', r.status === 200);
r = await client('t2').call('auth-login', 'POST', '/api/auth/login', { json: { email: 'tia@example.com', password: 'newpassword2' } });
check('sign in with new password', r.status === 200);

// ---------- Hourly payout job ----------
await q(`UPDATE payments SET payout_status = 'failed' WHERE assignment_id = $1`, [aid]);
await (await fn('payouts-retry'))(new Request('https://ga.test/'), {});
const pay2 = (await q(`SELECT payout_status, payout_attempts FROM payments WHERE assignment_id = $1`, [aid]))[0];
check('payout retry job runs and records attempt', pay2.payout_attempts === 2, JSON.stringify(pay2));


// ---------- Marketing: campaigns, leads, unsubscribe ----------
const sentEmails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.resend.com')) {
    const b = JSON.parse(init.body);
    sentEmails.push(b);
    return new Response(JSON.stringify({ id: 'em_' + sentEmails.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};
process.env.RESEND_API_KEY = 're_test';
process.env.EMAIL_FROM = 'hello@gradeangels.test';
await q(`UPDATE site_settings SET value = '2020-01-01T00:00:00Z' WHERE key = 'campaigns_started_at'`);
await q(`UPDATE site_settings SET value = '1226 Summer Springs, Middleburg, FL 32068' WHERE key = 'email_mailing_address'`);

const newTeacher = client('newTeacher');
r = await newTeacher.call('auth-signup', 'POST', '/api/auth/signup', { json: { role: 'teacher', full_name: 'Ana Ruiz', email: 'ana@example.com', password: 'password1', source: 'tiktok', medium: 'social', campaign: 'launch' } });
check('signup with source', r.status === 201);
const welcome = sentEmails.find((e) => e.to[0] === 'ana@example.com');
check('teacher welcome sent immediately', welcome && /Welcome to Grade Angels/.test(welcome.subject) && welcome.html.includes('Hi Ana,') && welcome.html.includes('Summer Springs') && welcome.html.includes('/api/email/unsubscribe'), JSON.stringify(welcome?.subject));
check('welcome has no dashes in text', welcome && !/[—–]/.test(welcome.text));

r = await client('lead').call('leads', 'POST', '/api/leads', { json: { email: 'Lead@Example.com', name: 'Lee', role: 'teacher', source: 'instagram' } });
check('lead captured', r.status === 200 && r.data.checklist_url === '/checklist.html');
check('checklist email sent to lead', sentEmails.some((e) => e.to[0] === 'lead@example.com' && /Checklist/.test(e.subject)));
r = await client('lead').call('leads', 'POST', '/api/leads', { json: { email: 'lead@example.com' } });
check('same lead twice sends only once', sentEmails.filter((e) => e.to[0] === 'lead@example.com').length === 1);
r = await client('bot').call('leads', 'POST', '/api/leads', { json: { email: 'bot@example.com', website: 'spam' } });
check('honeypot ignores bots', (await q(`SELECT 1 FROM leads WHERE email = 'bot@example.com'`)).length === 0);

// Age the new teacher 3 days with no posts: the trust email is due.
await q(`UPDATE users SET created_at = NOW() - INTERVAL '3 days' WHERE email = 'ana@example.com'`);
let before = sentEmails.length;
r = await master.call('admin-marketing', 'POST', '/api/admin/marketing', { json: { action: 'run_now' } });
check('run campaigns sends the 2 day email', r.status === 200 && sentEmails.slice(before).some((e) => e.to[0] === 'ana@example.com' && /vetting/.test(e.subject)), JSON.stringify(r.data));
before = sentEmails.length;
r = await master.call('admin-marketing', 'POST', '/api/admin/marketing', { json: { action: 'run_now' } });
check('running again sends nothing twice', sentEmails.length === before, JSON.stringify(sentEmails.slice(before).map((e) => e.subject)));

// A teacher who already posted does not get the reminder.
await q(`UPDATE users SET created_at = NOW() - INTERVAL '3 days' WHERE email = 'tia@example.com'`);
await master.call('admin-marketing', 'POST', '/api/admin/marketing', { json: { action: 'run_now' } });
check('teacher who posted gets no reminder', !sentEmails.some((e) => e.to[0] === 'tia@example.com' && /vetting/.test(e.subject)));

// The grade angel is live (from earlier): the you are live email goes out.
check('grade angel live email sent', sentEmails.some((e) => e.to[0] === 'jordan@example.com' && /approved/.test(e.subject)), sentEmails.map((e) => e.to[0] + ':' + e.subject).join(' | '));

// Unsubscribe link.
const link = welcome.text.match(/Unsubscribe: (\S+)/)[1].replace(/^https?:\/\/[^/]+/, '');
r = await client('x').call('email-unsubscribe', 'GET', link);
check('unsubscribe link works', r.status === 200 && (await q(`SELECT email_opt_out_at FROM users WHERE email = 'ana@example.com'`))[0].email_opt_out_at);
r = await client('x').call('email-unsubscribe', 'GET', link.replace(/t=[0-9a-f]+/, 't=forged'));
check('forged unsubscribe refused', r.status === 400);
await q(`UPDATE users SET created_at = NOW() - INTERVAL '8 days' WHERE email = 'ana@example.com'`);
before = sentEmails.length;
await master.call('admin-marketing', 'POST', '/api/admin/marketing', { json: { action: 'run_now' } });
check('unsubscribed person gets nothing more', !sentEmails.slice(before).some((e) => e.to[0] === 'ana@example.com'));

// Admin marketing views and edits.
r = await master.call('admin-marketing', 'GET', '/api/admin/marketing?view=overview');
check('marketing overview with sources', r.status === 200 && r.data.email_connected && r.data.sources.some((x) => x.source === 'tiktok' && x.teachers === 1) && r.data.sources.some((x) => x.source === 'instagram' && x.leads === 1), JSON.stringify(r.data.sources));
r = await master.call('admin-marketing', 'GET', '/api/admin/marketing?view=campaigns');
check('campaign list with counts', r.data.templates?.length === 11 && r.data.templates.find((t) => t.key === 'teacher_welcome').sent >= 1);
r = await master.call('admin-marketing', 'POST', '/api/admin/marketing', { json: { action: 'save_template', key: 'teacher_welcome', subject: 'Hello {{first_name}}', body: 'Hi {{first_name}},\n\n* one\n* two', cta_label: 'Go', cta_path: '/x' } });
check('edit campaign email', r.status === 200);
r = await master.call('admin-marketing', 'POST', '/api/admin/marketing', { json: { action: 'test_send', key: 'teacher_welcome' } });
check('test send goes to me', r.status === 200 && sentEmails.at(-1).to[0] === 'haynes.tenise@gmail.com' && sentEmails.at(-1).subject === '[Test] Hello Tenise' && sentEmails.at(-1).html.includes('<ul'), JSON.stringify(sentEmails.at(-1)?.subject));
r = await master.call('admin-marketing', 'POST', '/api/admin/marketing', { json: { action: 'toggle_template', key: 'teacher_welcome', enabled: false } });
check('turn email off', r.status === 200 && (await q(`SELECT enabled FROM email_templates WHERE key = 'teacher_welcome'`))[0].enabled === false);
r = await master.call('admin-marketing', 'GET', '/api/admin/marketing?view=calendar');
check('content calendar seeded', r.data.posts?.length === 18);
r = await master.call('admin-marketing', 'POST', '/api/admin/marketing', { json: { action: 'save_post', title: 'Test post', channels: 'TikTok', planned_for: '2026-10-05', status: 'ready', caption: 'Hi' } });
check('add calendar post', r.status === 200 && (await q(`SELECT 1 FROM marketing_posts WHERE title = 'Test post'`)).length === 1);
r = await master.call('admin-marketing', 'POST', '/api/admin/marketing', { json: { action: 'save_settings', email_reply_to: 'help@gradeangels.test' } });
check('save settings', r.status === 200);
r = await master.call('admin-marketing', 'GET', '/api/admin/marketing?view=leads&format=csv');
check('export leads csv', r.status === 200 && new TextDecoder().decode(r.data).includes('lead@example.com'));
r = await teacher.call('admin-marketing', 'GET', '/api/admin/marketing?view=overview');
check('teachers cannot see marketing', r.status === 403);
// Sandbox mode: only test sends; campaigns wait for a real domain.
process.env.EMAIL_FROM = 'onboarding@resend.dev';
let sandboxBefore = sentEmails.length;
r = await client('sb').call('auth-signup', 'POST', '/api/auth/signup', { json: { role: 'teacher', full_name: 'Sam Box', email: 'sam@example.com', password: 'password1' } });
check('sandbox: no welcome email to real sign up', r.status === 201 && sentEmails.length === sandboxBefore);
r = await master.call('admin-marketing', 'POST', '/api/admin/marketing', { json: { action: 'run_now' } });
check('sandbox: campaigns wait', /Sandbox/.test(r.data.skipped_reason || ''), JSON.stringify(r.data));
check('sandbox: nothing recorded as failed for Sam', (await q(`SELECT 1 FROM email_sends s JOIN users u ON u.id = s.user_id WHERE u.email = 'sam@example.com'`)).length === 0);
r = await master.call('admin-marketing', 'POST', '/api/admin/marketing', { json: { action: 'test_send', key: 'teacher_trust' } });
check('sandbox: test send still works', r.status === 200 && sentEmails.at(-1).from.includes('onboarding@resend.dev'));
r = await master.call('admin-marketing', 'GET', '/api/admin/marketing?view=overview');
check('sandbox: overview says test mode', r.data.email_sandbox === true);
process.env.EMAIL_FROM = 'hello@gradeangels.test';
await master.call('admin-marketing', 'POST', '/api/admin/marketing', { json: { action: 'toggle_template', key: 'teacher_welcome', enabled: true } });
await master.call('admin-marketing', 'POST', '/api/admin/marketing', { json: { action: 'run_now' } });
check('after real domain: sandbox sign up gets their welcome', (await q(`SELECT 1 FROM email_sends s JOIN users u ON u.id = s.user_id WHERE u.email = 'sam@example.com' AND s.template_key = 'teacher_welcome' AND s.status = 'sent'`)).length === 1);
globalThis.fetch = realFetch;

await db.end();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
