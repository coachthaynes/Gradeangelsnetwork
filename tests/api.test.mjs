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
await q(`TRUNCATE gifts, gift_ledger RESTART IDENTITY CASCADE`);
await q(`UPDATE gift_fund SET balance_cents = 0`);
// The cleanup above cascades into tables that reference users (templates,
// settings, calendar), so reload their starting rows from the migration.
import fs from 'fs';
await q(`TRUNCATE email_templates, site_settings, marketing_posts RESTART IDENTITY CASCADE`);
await db.query(fs.readFileSync(new URL('../netlify/database/migrations/20261001000000_marketing/migration.sql', import.meta.url), 'utf8'));
// Older checks use small stacks; the minimum total is tested on its own below.
await q(`INSERT INTO site_settings (key, value) VALUES ('min_total_cents', '0'), ('min_rate_per_page_cents', '10') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

// ---------- Accounts ----------
const teacher = client('teacher');
const angel = client('angel');
const master = client('master');
const staffer = client('staffer');
const stranger = client('stranger');

let r = await teacher.call('auth-signup', 'POST', '/api/auth/signup', { json: { role: 'teacher', full_name: 'Tia Haynes', email: 'tia@example.com', password: 'password1', accept_terms: true } });
check('teacher signs up', r.status === 201 && r.data.user.role === 'teacher', JSON.stringify(r.data));
r = await angel.call('auth-signup', 'POST', '/api/auth/signup', { json: { role: 'grade_angel', full_name: 'Jordan Lee', email: 'jordan@example.com', password: 'password1', accept_terms: true } });
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
r = await staffer.call('staff-request', 'POST', '/api/staff/request', { json: { full_name: 'Maria Lopez', email: 'maria@example.com', password: 'password1', accept_terms: true } });
check('staff request created, not approved', r.status === 201 && r.data.approved === false, JSON.stringify(r.data));
r = await staffer.call('auth-login', 'POST', '/api/auth/login', { json: { email: 'maria@example.com', password: 'password1', accept_terms: true } });
check('unapproved staff cannot sign in', r.status === 403, JSON.stringify(r.data));
r = await master.call('admin-master', 'GET', '/api/admin/master');
check('master sees pending request', r.status === 200 && r.data.pending.length === 1, JSON.stringify(r.data).slice(0, 300));
const mariaId = r.data.pending[0]?.id;
r = await master.call('admin-master', 'POST', '/api/admin/master', { json: { action: 'approve', user_id: mariaId, staff_level: 'support' } });
check('master approves as support', r.status === 200);
r = await staffer.call('auth-login', 'POST', '/api/auth/login', { json: { email: 'maria@example.com', password: 'password1', accept_terms: true } });
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
r = await teacher.call('assignments-create', 'POST', '/api/assignments/create', { json: { title: 'Fractions quiz', subject: 'Math', grade_level: '5th grade', assignment_type: 'combo', rate_per_page_cents: 100, turnaround_hours: 48, instructions: 'Key on last page', pages_per_student: 2 } });
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
const autoGroups = (await q(`SELECT grading_groups FROM assignments WHERE id = $1`, [aid]))[0].grading_groups;
check('publish groups each student\'s pages', autoGroups.length === 2 && JSON.stringify(autoGroups[0].pages) === '[0,1]' && JSON.stringify(autoGroups[1].pages) === '[2]' && autoGroups[1].label === 'Student 2', JSON.stringify(autoGroups));

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
r = await angel.call('auth-login', 'POST', '/api/auth/login', { json: { email: 'jordan@example.com', password: 'password1', accept_terms: true } });
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
r = await newTeacher.call('auth-signup', 'POST', '/api/auth/signup', { json: { role: 'teacher', full_name: 'Ana Ruiz', email: 'ana@example.com', password: 'password1', source: 'tiktok', medium: 'social', campaign: 'launch', accept_terms: true } });
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
r = await client('sb').call('auth-signup', 'POST', '/api/auth/signup', { json: { role: 'teacher', full_name: 'Sam Box', email: 'sam@example.com', password: 'password1', accept_terms: true } });
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

// ---------- Gift Angels ----------
const tiaId = (await q(`SELECT id FROM users WHERE email = 'tia@example.com'`))[0].id;
r = await teacher.call('gifts-mine', 'GET', '/api/gifts/mine');
check('gifts: teacher starts with no balance or link', r.status === 200 && r.data.balance_cents === 0 && r.data.link_path === null, JSON.stringify(r.data));
await angel.call('auth-login', 'POST', '/api/auth/login', { json: { email: 'jordan@example.com', password: 'password1', accept_terms: true } });
r = await angel.call('gifts-mine', 'GET', '/api/gifts/mine');
check('gifts: grade angels have no gift page', r.status === 403);
r = await teacher.call('gifts-mine', 'POST', '/api/gifts/mine', { json: { action: 'enable_link' } });
const giftToken = new URL('https://x' + r.data.link_path).searchParams.get('t');
check('gifts: teacher turns on gift link', r.status === 200 && giftToken?.length >= 12, JSON.stringify(r.data));
r = await teacher.call('gifts-mine', 'POST', '/api/gifts/mine', { json: { action: 'save_note', note: 'Thank you for helping my 4th graders!' } });
check('gifts: note saved', r.data.note === 'Thank you for helping my 4th graders!');
r = await stranger.call('gifts-info', 'GET', `/api/gifts/info?t=${giftToken}`);
check('gifts: public page shows display name and note only', r.status === 200 && r.data.teacher.name === 'Ms. Haynes' && r.data.teacher.note.includes('4th') && !JSON.stringify(r.data).includes('tia@'), JSON.stringify(r.data));
r = await teacher.call('gifts-mine', 'GET', '/api/gifts/mine');
check('handles: turning on gifts makes an @username from the public name', r.data.handle === 'mshaynes' && r.data.handle_path === '/give.html?to=mshaynes', JSON.stringify(r.data));
r = await stranger.call('gifts-search', 'GET', '/api/gifts/search?q=@msh');
check('handles: search by @username', r.data.teachers.length === 1 && r.data.teachers[0].handle === 'mshaynes' && r.data.teachers[0].name === 'Ms. Haynes' && r.data.teachers[0].school === null && !JSON.stringify(r.data).includes('Tia'), JSON.stringify(r.data));
r = await stranger.call('gifts-search', 'GET', '/api/gifts/search?q=ms.%20hay');
check('handles: search by public name', r.data.teachers.length === 1);
r = await stranger.call('gifts-search', 'GET', '/api/gifts/search?q=tia');
check('handles: full name is never searchable when a display name is set', r.data.teachers.length === 0);
r = await stranger.call('gifts-search', 'GET', '/api/gifts/search?q=m');
check('handles: needs 2 characters', r.data.teachers.length === 0);
r = await teacher.call('gifts-mine', 'POST', '/api/gifts/mine', { json: { action: 'save_handle', handle: 'bad-name' } });
check('handles: only letters, numbers, underscores', r.status === 400);
r = await teacher.call('gifts-mine', 'POST', '/api/gifts/mine', { json: { action: 'save_handle', handle: '@Tia_Teaches' } });
check('handles: teacher picks their own', r.status === 200 && r.data.handle === 'tia_teaches', JSON.stringify(r.data));
r = await teacher.call('gifts-mine', 'POST', '/api/gifts/mine', { json: { action: 'save_school', school: 'Lake Asbury Elementary', show: true } });
check('handles: school saved and shown by choice', r.data.school === 'Lake Asbury Elementary' && r.data.show_school === true);
r = await stranger.call('gifts-info', 'GET', '/api/gifts/info?to=@TIA_teaches');
check('handles: give page by @username shows school', r.status === 200 && r.data.teacher.name === 'Ms. Haynes' && r.data.teacher.school === 'Lake Asbury Elementary' && r.data.teacher.handle === 'tia_teaches', JSON.stringify(r.data.teacher));
await q(`UPDATE users SET handle = 'jlee' WHERE email = 'jordan@example.com'`);
r = await teacher.call('gifts-mine', 'POST', '/api/gifts/mine', { json: { action: 'save_handle', handle: 'JLee' } });
check('handles: taken names refused', r.status === 409);
r = await stranger.call('gifts-search', 'GET', '/api/gifts/search?q=jlee');
check('handles: grade angels never appear in teacher search', r.data.teachers.length === 0);
r = await stranger.call('gifts-checkout', 'POST', '/api/gifts/checkout', { json: { amount_cents: 2500, name: 'Pat', email: 'pat@example.com', to: 'nobody_here' } });
check('handles: unknown @username refused at checkout', r.status === 404);
r = await stranger.call('gifts-info', 'GET', '/api/gifts/info?t=nope');
check('gifts: unknown link refused', r.status === 404);
r = await stranger.call('gifts-checkout', 'POST', '/api/gifts/checkout', { json: { amount_cents: 100, name: 'Pat', email: 'pat@example.com' } });
check('gifts: too small refused', r.status === 400);
r = await stranger.call('gifts-checkout', 'POST', '/api/gifts/checkout', { json: { amount_cents: 2500, name: 'Pat', email: 'pat@example.com', t: giftToken } });
check('gifts: checkout waits for Stripe', r.status === 501 && (await q(`SELECT 1 FROM gifts`)).length === 0, JSON.stringify(r.data));

// Stripe confirms two gifts: one for Tia, one for the community fund.
const [g1] = await q(`INSERT INTO gifts (teacher_id, amount_cents, donor_name, donor_email, message, anonymous) VALUES ($1, 2000, 'Pat Parent', 'pat@example.com', 'You are the best!', true) RETURNING id`, [tiaId]);
const [g2] = await q(`INSERT INTO gifts (teacher_id, amount_cents, donor_name, donor_email) VALUES (NULL, 5000, 'Corner Cafe', 'cafe@example.com') RETURNING id`);
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
const webhook = async (giftId) => (await fn('stripe-webhook'))(new Request('https://ga.test/api/stripe/webhook', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'checkout.session.completed', data: { object: { payment_status: 'paid', payment_intent: 'pi_' + giftId, metadata: { kind: 'gift', gift_id: String(giftId) } } } }),
}), { deploy: { context: 'dev' } });
const giftMailStart = sentEmails.length;
await webhook(g1.id);
await webhook(g1.id); // Stripe sends it again
await webhook(g2.id);
delete process.env.STRIPE_SECRET_KEY;
let bal = (await q(`SELECT gift_balance_cents FROM users WHERE id = $1`, [tiaId]))[0].gift_balance_cents;
let fund = (await q(`SELECT balance_cents FROM gift_fund`))[0].balance_cents;
check('gifts: paid gift credited once to the teacher', bal === 2000, String(bal));
check('gifts: fund gift goes to the community fund', fund === 5000, String(fund));
const giftMails = sentEmails.slice(giftMailStart);
check('gifts: thank you and teacher notice emailed', giftMails.some((m) => m.to[0] === 'pat@example.com' && /Thank you/.test(m.subject) && /not tax deductible/.test(m.text))
  && giftMails.some((m) => m.to[0] === 'tia@example.com' && /\$20/.test(m.subject) && /anonymous/.test(m.text) && !/Pat/.test(m.text)), JSON.stringify(giftMails.map((m) => [m.to, m.subject])));
check('gifts: receipts have no unsubscribe link', giftMails.every((m) => !/Unsubscribe/.test(m.text)));

r = await staffer.call('admin-gifts', 'POST', '/api/admin/gifts', { json: { action: 'grant', teacher_email: 'tia@example.com', amount_cents: 1000 } });
check('gifts: support staff cannot grant', r.status === 403);
r = await master.call('admin-gifts', 'POST', '/api/admin/gifts', { json: { action: 'grant', teacher_email: 'tia@example.com', amount_cents: 999999 } });
check('gifts: cannot grant more than the fund holds', r.status === 409);
r = await master.call('admin-gifts', 'POST', '/api/admin/gifts', { json: { action: 'grant', teacher_email: 'tia@example.com', amount_cents: 1000, note: 'Testing season' } });
bal = (await q(`SELECT gift_balance_cents FROM users WHERE id = $1`, [tiaId]))[0].gift_balance_cents;
fund = (await q(`SELECT balance_cents FROM gift_fund`))[0].balance_cents;
check('gifts: master grants from the fund', r.status === 200 && bal === 3000 && fund === 4000, `${bal} ${fund}`);
r = await teacher.call('gifts-mine', 'GET', '/api/gifts/mine');
check('gifts: teacher sees both, donor kept private', r.data.received.length === 2 && r.data.received.some((x) => /community fund/.test(x.from)) && r.data.received.some((x) => /anonymous/.test(x.from) && x.message === 'You are the best!') && !JSON.stringify(r.data).includes('Pat'), JSON.stringify(r.data.received));

// Paying for grading uses gift money first.
const mk = async (pages, rate) => (await q(`INSERT INTO assignments (teacher_id, grade_angel_id, title, subject, grade_level, assignment_type, page_count, rate_per_page_cents, status, accepted_at)
  VALUES ($1, $2, 'Gift test', 'Math', '4th', 'multiple_choice', $3, $4, 'accepted', NOW()) RETURNING id`, [tiaId, angelId, pages, rate]))[0].id;
const small = await mk(5, 100);
r = await teacher.call('assignments-get', 'GET', `/api/assignments/get?id=${small}`);
check('gifts: assignment shows gift balance to its teacher', r.data.assignment.gift_balance_cents === 3000);
r = await angel.call('assignments-get', 'GET', `/api/assignments/get?id=${small}`);
check('gifts: grade angel does not see teacher gift balance', r.data.assignment.gift_balance_cents === undefined);
r = await teacher.call('assignments-pay', 'POST', '/api/assignments/pay', { json: { assignment_id: small, success_url: 'https://ga.test/x' } });
bal = (await q(`SELECT gift_balance_cents FROM users WHERE id = $1`, [tiaId]))[0].gift_balance_cents;
let gp = (await q(`SELECT status, gift_cents, amount_cents FROM payments WHERE assignment_id = $1`, [small]))[0];
check('gifts: fully covered without a card, service fee included', r.status === 200 && r.data.paid && gp.status === 'paid' && gp.gift_cents === 515 && bal === 2485, JSON.stringify([r.data, gp, bal]));
r = await teacher.call('assignments-pay', 'POST', '/api/assignments/pay', { json: { assignment_id: small, success_url: 'https://ga.test/x' } });
check('gifts: cannot pay twice', r.status === 409);
const big = await mk(10, 500);
r = await teacher.call('assignments-pay', 'POST', '/api/assignments/pay', { json: { assignment_id: big, success_url: 'https://ga.test/x' } });
bal = (await q(`SELECT gift_balance_cents FROM users WHERE id = $1`, [tiaId]))[0].gift_balance_cents;
check('gifts: partial needs a card, nothing set aside while Stripe is off', r.status === 501 && bal === 2485 && (await q(`SELECT 1 FROM payments WHERE assignment_id = $1`, [big])).length === 0, JSON.stringify([r.data, bal]));
r = await master.call('admin-assignments', 'POST', '/api/admin/assignments', { json: { assignment_id: small, reason: 'Teacher asked to cancel' } });
bal = (await q(`SELECT gift_balance_cents FROM users WHERE id = $1`, [tiaId]))[0].gift_balance_cents;
gp = (await q(`SELECT status, gift_cents FROM payments WHERE assignment_id = $1`, [small]))[0];
check('gifts: cancelling a gift paid assignment returns the gift', r.status === 200 && r.data.gift_returned_cents === 515 && bal === 3000 && gp.status === 'refunded', JSON.stringify([r.data, bal, gp]));
// Gift set aside for a pending card payment (Stripe was on) comes back when the teacher cancels.
const pend = await mk(10, 500);
const [pp] = await q(`INSERT INTO payments (assignment_id, amount_cents, platform_fee_cents, status, gift_cents) VALUES ($1, 5000, 1000, 'pending', 0) RETURNING id`, [pend]);
await q(`UPDATE users SET gift_balance_cents = gift_balance_cents - 3000 WHERE id = $1`, [tiaId]);
await q(`UPDATE payments SET gift_cents = 3000 WHERE id = $1`, [pp.id]);
await q(`INSERT INTO gift_ledger (teacher_id, amount_cents, kind, payment_id) VALUES ($1, -3000, 'applied', $2)`, [tiaId, pp.id]);
await q(`UPDATE assignments SET status = 'open', grade_angel_id = NULL WHERE id = $1`, [pend]);
r = await teacher.call('assignments-cancel', 'POST', '/api/assignments/cancel', { json: { assignment_id: pend } });
bal = (await q(`SELECT gift_balance_cents FROM users WHERE id = $1`, [tiaId]))[0].gift_balance_cents;
check('gifts: teacher cancel returns gift set aside', r.status === 200 && r.data.gift_returned_cents === 3000 && bal === 3000, JSON.stringify([r.data, bal]));

r = await master.call('admin-gifts', 'GET', '/api/admin/gifts');
check('gifts: admin totals', r.status === 200 && r.data.totals.raised_cents === 7000 && r.data.fund_cents === 4000 && r.data.totals.held_by_teachers_cents === 3000 && r.data.gifts.length === 2 && r.data.teachers[0].email === 'tia@example.com', JSON.stringify(r.data.totals));
r = await stranger.call('gifts-info', 'GET', '/api/gifts/info');
check('gifts: public totals', r.data.stats.total_cents === 7000 && r.data.stats.gifts === 2 && r.data.stats.teachers_helped === 1 && r.data.teacher === null, JSON.stringify(r.data.stats));
r = await teacher.call('gifts-mine', 'POST', '/api/gifts/mine', { json: { action: 'disable_link' } });
r = await stranger.call('gifts-info', 'GET', `/api/gifts/info?t=${giftToken}`);
check('gifts: turned off link stops working', r.status === 404);
r = await stranger.call('gifts-search', 'GET', '/api/gifts/search?q=tia_t');
check('handles: turned off teachers cannot be found', r.data.teachers.length === 0);
const ledgerSum = (await q(`SELECT COALESCE(SUM(amount_cents), 0)::int AS s FROM gift_ledger`))[0].s;
check('gifts: ledger adds up to balances plus fund', ledgerSum === 3000 + 4000, String(ledgerSum));


// ---------- Terms and pricing ----------
r = await client('noterms').call('auth-signup', 'POST', '/api/auth/signup', { json: { role: 'teacher', full_name: 'No Terms', email: 'noterms@example.com', password: 'password1' } });
check('terms: signup refused without agreeing', r.status === 400 && /Terms of Use/.test(r.data.error));
const tia = (await q(`SELECT terms_accepted_at, terms_version FROM users WHERE email = 'tia@example.com'`))[0];
check('terms: acceptance and version recorded', tia.terms_accepted_at && tia.terms_version === '2026-09-24.2', JSON.stringify(tia));
const jordan = (await q(`SELECT contractor_agreement_version FROM users WHERE email = 'jordan@example.com'`))[0];
check('terms: contractor agreement version recorded', jordan.contractor_agreement_version === '2026-09-24.2', JSON.stringify(jordan));

r = await teacher.call('pricing', 'GET', '/api/pricing?assignment_type=combo&grade_level=5th%20grade&subject=Math');
check('pricing: default lowest price and no hint yet', r.data.min_rate_cents === 10 && r.data.hint === null, JSON.stringify(r.data));
const newPost = { title: 'Cheap', subject: 'Math', grade_level: '5th grade', assignment_type: 'combo', turnaround_hours: 48 };
r = await teacher.call('assignments-create', 'POST', '/api/assignments/create', { json: { ...newPost, rate_per_page_cents: 5 } });
check('pricing: below lowest price refused', r.status === 400 && /lowest price is \$0\.10/.test(r.data.error), JSON.stringify(r.data));
r = await staffer.call('admin-pricing', 'POST', '/api/admin/pricing', { json: { min_rate_cents: 25 } });
check('pricing: support cannot change lowest price', r.status === 403);
r = await master.call('admin-pricing', 'POST', '/api/admin/pricing', { json: { min_rate_cents: 25 } });
check('pricing: master changes lowest price', r.status === 200 && r.data.min_rate_cents === 25);
r = await teacher.call('assignments-create', 'POST', '/api/assignments/create', { json: { ...newPost, rate_per_page_cents: 20 } });
check('pricing: new lowest price applies', r.status === 400);
r = await teacher.call('assignments-create', 'POST', '/api/assignments/create', { json: { ...newPost, rate_per_page_cents: 25 } });
check('pricing: at lowest price allowed', r.status === 201 || r.status === 200, JSON.stringify(r.data).slice(0, 200));
// Accepted history makes a hint (the Fractions quiz above at $1.00 counts too): same type, grade, and subject first.
for (const rate of [40, 50, 60]) {
  await q(`INSERT INTO assignments (teacher_id, grade_angel_id, title, subject, grade_level, assignment_type, page_count, rate_per_page_cents, status, accepted_at)
           VALUES ($1, $2, 'Past', 'math', '5th Grade', 'combo', 2, $3, 'completed', NOW())`, [tiaId, angelId, rate]);
}
r = await teacher.call('pricing', 'GET', '/api/pricing?assignment_type=combo&grade_level=5th%20grade&subject=Math');
check('pricing: hint from similar accepted work', r.data.hint?.rate_cents === 55 && r.data.hint.basis === 'type_grade_subject' && r.data.hint.count === 4, JSON.stringify(r.data.hint));
r = await teacher.call('pricing', 'GET', '/api/pricing?assignment_type=combo&grade_level=5th%20grade&subject=Science');
check('pricing: falls back to type and grade', r.data.hint?.basis === 'type_grade', JSON.stringify(r.data.hint));
r = await teacher.call('pricing', 'GET', '/api/pricing?assignment_type=essay&grade_level=5th%20grade&subject=Math');
check('pricing: no hint without enough history', r.data.hint === null);
await master.call('admin-pricing', 'POST', '/api/admin/pricing', { json: { min_rate_cents: 10 } });


// ---------- Grading screen and review process ----------
const [ga] = await q(`INSERT INTO assignments (teacher_id, grade_angel_id, title, subject, grade_level, assignment_type, page_count, rate_per_page_cents, status, accepted_at, due_at)
  VALUES ($1, $2, 'Grading test', 'Math', '4th', 'combo', 4, 100, 'accepted', NOW(), NOW() + INTERVAL '2 days') RETURNING id`, [tiaId, angelId]);
for (let i = 0; i < 4; i++) await q(`INSERT INTO assignment_pages (assignment_id, page_index, blob_key, content_type, byte_size, width, height) VALUES ($1, $2, 'x', 'image/jpeg', 1, 1000, 1300)`, [ga.id, i]);
r = await angel.call('grading', 'GET', `/api/grading?assignment_id=${ga.id}`);
check('grading: grade angel opens the grading screen', r.status === 200 && r.data.layer === 'grade_angel' && r.data.can_edit && r.data.pages.length === 4 && r.data.comment_bank.length > 3, JSON.stringify(r.data).slice(0, 200));
r = await stranger.call('grading', 'GET', `/api/grading?assignment_id=${ga.id}`);
check('grading: others are kept out', r.status === 401);
const marks = { items: [{ t: 'pen', c: '#D92D20', w: 0.004, p: [[0.1, 0.1], [0.2, 0.2]] }, { t: 'stamp', k: 'check', c: '#12A150', x: 0.5, y: 0.5, s: 0.045 }, { t: 'text', c: '#D92D20', x: 0.3, y: 0.7, s: 0.024, text: 'Show your work' }], score: { e: 8, p: 10 } };
r = await angel.call('grading', 'POST', '/api/grading', { json: { action: 'save_page', assignment_id: ga.id, page_index: 0, data: marks } });
check('grading: marks saved', r.status === 200);
r = await angel.call('grading', 'POST', '/api/grading', { json: { action: 'save_page', assignment_id: ga.id, page_index: 1, data: { items: [{ t: 'script', x: 1 }] } } });
check('grading: unknown mark types refused', r.status === 400);
r = await angel.call('grading', 'POST', '/api/grading', { json: { action: 'save_page', assignment_id: ga.id, page_index: 1, data: { items: [], score: { e: 5, p: 5 } } } });
r = await angel.call('grading', 'POST', '/api/grading', { json: { action: 'save_groups', assignment_id: ga.id, groups: [{ kind: 'student', label: 'Student 1', pages: [0, 1] }, { kind: 'worksheet', label: 'Quiz', pages: [2, 3] }] } });
check('grading: groups saved and student packet totals', r.status === 200 && r.data.groups.length === 2 && r.data.groups[1].key_page === 2 && r.data.scores[0].label === 'Student 1' && r.data.scores[0].earned === 13 && r.data.scores[0].possible === 15, JSON.stringify(r.data));
r = await angel.call('grading', 'POST', '/api/grading', { json: { action: 'save_groups', assignment_id: ga.id, groups: [{ pages: [0] }, { pages: [0, 1] }] } });
check('grading: a page cannot be in two groups', r.status === 400);
r = await teacher.call('grading', 'GET', `/api/grading?assignment_id=${ga.id}`);
check('grading: teacher cannot see marks before the work is sent', r.data.layer === 'teacher' && r.data.marks.length === 0);
r = await angel.call('grading', 'POST', '/api/grading', { json: { action: 'save_bank', items: ['Nice work', '  ', 'Check signs'] } });
check('grading: comment bank saved', r.data.comment_bank.length === 2);

let mailMark = sentEmails.length;
r = await angel.call('assignments-submit', 'POST', '/api/assignments/submit', { json: { assignment_id: ga.id, note: 'Number 4 tripped most of them up.' } });
check('review: graded work sent from the grading screen', r.status === 200 && r.data.assignment.status === 'submitted' && r.data.assignment.graded_on_site, JSON.stringify(r.data));
check('review: teacher emailed that work is ready', sentEmails.slice(mailMark).some((m) => m.to[0] === 'tia@example.com' && /Graded work is ready/.test(m.subject) && /Number 4/.test(m.text)));
r = await teacher.call('grading', 'GET', `/api/grading?assignment_id=${ga.id}`);
check('paid lock: unpaid teacher cannot see the graded marks or scores', r.data.locked && r.data.marks.length === 0 && r.data.scores.length === 0, JSON.stringify(r.data).slice(0, 200));
r = await teacher.call('assignments-get', 'GET', `/api/assignments/get?id=${ga.id}`);
check('paid lock: no scores on the assignment page before paying', r.data.assignment.scores.length === 0);
await q(`UPDATE assignments SET graded_blob_key = 'graded/none' WHERE id = $1`, [ga.id]);
r = await teacher.call('assignments-file', 'GET', `/api/assignments/file?assignment_id=${ga.id}&kind=graded`);
check('paid lock: graded file download refused before paying', r.status === 402);
await q(`UPDATE assignments SET graded_blob_key = NULL WHERE id = $1`, [ga.id]);
await q(`INSERT INTO payments (assignment_id, amount_cents, platform_fee_cents, status, paid_at, test_mode) VALUES ($1, 400, 80, 'paid', NOW(), true)`, [ga.id]);
r = await teacher.call('grading', 'GET', `/api/grading?assignment_id=${ga.id}`);
check('review: opening the graded pages marks the work reviewed', (await q(`SELECT graded_viewed_at FROM assignments WHERE id = $1`, [ga.id]))[0].graded_viewed_at !== null);
check('review: after paying, teacher sees the marks, read only', !r.data.locked && r.data.marks.length === 2 && !r.data.can_edit && r.data.assignment.grade_angel_note.includes('Number 4'));
r = await teacher.call('grading', 'POST', '/api/grading', { json: { action: 'save_page', assignment_id: ga.id, page_index: 0, data: { items: [], score: { e: 1, p: 10 } } } });
check('review: teachers cannot mark the pages', r.status === 409);
r = await teacher.call('assignments-get', 'GET', `/api/assignments/get?id=${ga.id}`);
check('review: scores shown after paying', r.data.assignment.scores[0].earned === 13, JSON.stringify(r.data.assignment.scores));
mailMark = sentEmails.length;
r = await teacher.call('assignments-revise', 'POST', '/api/assignments/revise', { json: { assignment_id: ga.id, note: 'Page 1 number 4 should be C.' } });
check('review: teacher asks for changes once', r.status === 200 && r.data.assignment.status === 'accepted' && r.data.assignment.revision_count === 1, JSON.stringify(r.data));
check('review: grade angel emailed about changes', sentEmails.slice(mailMark).some((m) => m.to[0] === 'jordan@example.com' && /Changes requested/.test(m.subject)));
r = await angel.call('assignments-get', 'GET', `/api/assignments/get?id=${ga.id}`);
check('review: grade angel sees the change note', r.data.assignment.revision_note.includes('should be C'));
await angel.call('assignments-submit', 'POST', '/api/assignments/submit', { json: { assignment_id: ga.id } });
r = await teacher.call('assignments-revise', 'POST', '/api/assignments/revise', { json: { assignment_id: ga.id, note: 'Still not right on page 1.' } });
check('review: second request goes to staff as a dispute', r.status === 200 && r.data.disputed, JSON.stringify(r.data));
r = await teacher.call('assignments-complete', 'POST', '/api/assignments/complete', { json: { assignment_id: ga.id } });
check('review: disputed work cannot be approved', r.status === 409);
r = await master.call('admin-overview', 'GET', '/api/admin/overview');
check('review: dispute shows in staff attention list', r.data.attention.some((x) => x.kind === 'dispute'));

// Automatic approval: reminder on day 3, approval on day 5 (only when paid).
const [ab] = await q(`INSERT INTO assignments (teacher_id, grade_angel_id, title, subject, grade_level, assignment_type, page_count, rate_per_page_cents, status, accepted_at, submitted_at)
  VALUES ($1, $2, 'Slow teacher', 'Math', '4th', 'combo', 2, 100, 'submitted', NOW() - INTERVAL '7 days', NOW() - INTERVAL '4 days') RETURNING id`, [tiaId, angelId]);
mailMark = sentEmails.length;
await (await fn('assignments-auto-approve'))();
check('auto approve: day 3 reminder sent once', sentEmails.slice(mailMark).filter((m) => /Waiting on you: Slow teacher/.test(m.subject)).length === 1);
await q(`UPDATE assignments SET submitted_at = NOW() - INTERVAL '6 days' WHERE id = $1`, [ab.id]);
await (await fn('assignments-auto-approve'))();
check('auto approve: unpaid work is left for staff', (await q(`SELECT status FROM assignments WHERE id = $1`, [ab.id]))[0].status === 'submitted');
await q(`INSERT INTO payments (assignment_id, amount_cents, platform_fee_cents, status, paid_at, test_mode) VALUES ($1, 200, 40, 'paid', NOW(), true)`, [ab.id]);
mailMark = sentEmails.length;
await (await fn('assignments-auto-approve'))();
const abRow = (await q(`SELECT status, auto_approved_at FROM assignments WHERE id = $1`, [ab.id]))[0];
check('auto approve: approved after 5 days and both told', abRow.status === 'completed' && abRow.auto_approved_at && sentEmails.slice(mailMark).some((m) => m.to[0] === 'jordan@example.com') && sentEmails.slice(mailMark).some((m) => m.to[0] === 'tia@example.com'), JSON.stringify(abRow));
check('auto approve: reminder not sent twice', sentEmails.slice(mailMark).filter((m) => /Waiting on you/.test(m.subject)).length === 0);

// Handing work back clears the marks for the next Grade Angel.
const [hb] = await q(`INSERT INTO assignments (teacher_id, grade_angel_id, title, subject, grade_level, assignment_type, page_count, rate_per_page_cents, status, accepted_at)
  VALUES ($1, $2, 'Hand back', 'Math', '4th', 'combo', 1, 100, 'accepted', NOW()) RETURNING id`, [tiaId, angelId]);
await q(`INSERT INTO assignment_pages (assignment_id, page_index, blob_key, content_type, byte_size) VALUES ($1, 0, 'x', 'image/jpeg', 1)`, [hb.id]);
await angel.call('grading', 'POST', '/api/grading', { json: { action: 'save_page', assignment_id: hb.id, page_index: 0, data: marks } });
r = await angel.call('assignments-submit', 'POST', '/api/assignments/submit', { json: { assignment_id: hb.id + 999 } });
await angel.call('assignments-release', 'POST', '/api/assignments/release', { json: { assignment_id: hb.id, reason: 'Out sick' } });
check('grading: handing back clears the marks', (await q(`SELECT 1 FROM assignment_annotations WHERE assignment_id = $1`, [hb.id])).length === 0);

// ---------- Gradebook ----------
r = await teacher.call('classes', 'POST', '/api/classes', { json: { action: 'create', name: 'Period 2', students: 'Ava Brooks, 101\nBen Cruz\nCal Diaz' } });
const p2 = r.data.classes.find((c) => c.name === 'Period 2');
check('gradebook: class created with students', r.status === 200 && p2.students.length === 3 && p2.students[0].student_code === '101', JSON.stringify(r.data));
r = await teacher.call('gradebook', 'GET', '/api/gradebook?class_id=none');
check('gradebook: graded work outside a class listed', r.data.unmatched.some((l) => l.assignment === 'Grading test' && l.earned === 13), JSON.stringify(r.data.unmatched));
r = await teacher.call('assignments-students', 'POST', '/api/assignments/students', { json: { assignment_id: ga.id, class_id: p2.id } });
r = await teacher.call('gradebook', 'GET', `/api/gradebook?class_id=${p2.id}`);
const ava = r.data.rows.find((x) => x.name === 'Ava Brooks');
check('gradebook: scores match students in order', r.data.columns.some((c) => c.id === ga.id) && ava.scores[ga.id]?.earned === 13 && ava.percent === 86.7, JSON.stringify(r.data.rows));
const benId = p2.students.find((x) => x.name === 'Ben Cruz').id;
r = await teacher.call('assignments-students', 'POST', '/api/assignments/students', { json: { assignment_id: ga.id, group_id: 'g1', student_id: benId } });
r = await teacher.call('gradebook', 'GET', `/api/gradebook?class_id=${p2.id}`);
check('gradebook: teacher fixes a match', r.data.rows.find((x) => x.name === 'Ben Cruz').scores[ga.id]?.earned === 13 && !r.data.rows.find((x) => x.name === 'Ava Brooks').scores[ga.id], JSON.stringify(r.data.rows));
r = await teacher.call('assignments-get', 'GET', `/api/assignments/get?id=${ga.id}`);
check('gradebook: assignment shows the matched student', r.data.assignment.scores[0].student_id === benId && r.data.assignment.students.length === 3);
r = await angel.call('assignments-get', 'GET', `/api/assignments/get?id=${ga.id}`);
check('gradebook: grade angels never see student names', !JSON.stringify(r.data).includes('Ben Cruz') && r.data.assignment.students === undefined);
r = await teacher.call('classes', 'POST', '/api/classes', { json: { action: 'update', class_id: p2.id, students: 'Ben Cruz\nAva Brooks, 101\nDee Evans' } });
const p2b = r.data.classes.find((c) => c.id === p2.id);
check('gradebook: editing the list keeps each student', p2b.students[0].id === benId && p2b.students.length === 3 && !p2b.students.some((x) => x.name === 'Cal Diaz'));
r = await teacher.call('gradebook', 'GET', `/api/gradebook?class_id=${p2.id}&format=csv`);
const csv = new TextDecoder().decode(r.data);
check('gradebook: spreadsheet download', csv.includes('Ben Cruz,,13') && csv.startsWith('Student,ID,Grading test'), csv.slice(0, 200));
r = await angel.call('classes', 'GET', '/api/classes');
check('gradebook: only teachers have classes', r.status === 403);
r = await teacher.call('assignments-students', 'POST', '/api/assignments/students', { json: { assignment_id: ga.id, group_id: 'g1', student_id: 999999 } });
check('gradebook: cannot match a student from another class', r.status === 400);

// ---------- Payments and payouts lists ----------
r = await teacher.call('payments-mine', 'GET', '/api/payments/mine');
check('payments: teacher sees their payments', r.status === 200 && r.data.payments.some((p) => p.title === 'Grading test'), JSON.stringify(r.data).slice(0, 200));
const somePay = r.data.payments[0];
r = await teacher.call('payments-mine', 'GET', `/api/payments/mine?receipt=${somePay.id}`);
check('payments: no receipt when there was no card charge', r.status === 404);
r = await angel.call('payouts-mine', 'GET', '/api/payouts/mine');
check('payouts: grade angel sees their payouts', r.status === 200 && r.data.payouts.length >= 1 && r.data.year > 2000, JSON.stringify(r.data).slice(0, 200));
r = await angel.call('payments-connect-dashboard', 'POST', '/api/payments/connect/dashboard', { json: {} });
check('payouts: Stripe page waits for Stripe', r.status === 501 || r.status === 409, JSON.stringify(r.data));

// ---------- Flat price and minimum total ----------
await q(`UPDATE site_settings SET value = '1000' WHERE key = 'min_total_cents'`);
r = await teacher.call('pricing', 'GET', '/api/pricing?assignment_type=combo');
check('pricing: minimum total offered to the form', r.data.min_total_cents === 1000);
const postStack = async (json, pages) => {
  const c = await teacher.call('assignments-create', 'POST', '/api/assignments/create', { json: { title: 'Priced', subject: 'Math', grade_level: '4th', assignment_type: 'combo', turnaround_hours: 48, ...json } });
  if (c.status !== 201) return c;
  for (let i = 0; i < pages; i++) await q(`INSERT INTO assignment_pages (assignment_id, page_index, blob_key, content_type, byte_size) VALUES ($1, $2, 'x', 'image/jpeg', 1)`, [c.data.assignment.id, i]);
  return teacher.call('assignments-publish', 'POST', '/api/assignments/publish', { json: { assignment_id: c.data.assignment.id, expected_pages: pages } });
};
r = await postStack({ rate_per_page_cents: 50 }, 4);
check('pricing: per page under the minimum is raised to $10', r.data.assignment.total_cents === 1000 && r.data.assignment.minimum_applied, JSON.stringify(r.data));
r = await postStack({ rate_per_page_cents: 50 }, 30);
check('pricing: per page above the minimum is kept', r.data.assignment.total_cents === 1500 && !r.data.assignment.minimum_applied, JSON.stringify(r.data));
r = await postStack({ pricing_mode: 'flat', flat_price_cents: 2500 }, 12);
const flatId = r.data.assignment.id;
check('pricing: flat price for the whole stack', r.data.assignment.total_cents === 2500, JSON.stringify(r.data));
r = await postStack({ pricing_mode: 'flat', flat_price_cents: 600 }, 3);
check('pricing: flat price under the minimum is raised to $10', r.data.assignment.total_cents === 1000 && r.data.assignment.minimum_applied);
r = await postStack({ pricing_mode: 'flat' }, 1);
check('pricing: flat needs a price', r.status === 400);
r = await teacher.call('assignments-get', 'GET', `/api/assignments/get?id=${flatId}`);
check('pricing: teacher sees flat total and 3% fee', r.data.assignment.total_cents === 2500 && r.data.assignment.service_fee_cents === 75 && r.data.assignment.pricing_mode === 'flat');
r = await angel.call('assignments-get', 'GET', `/api/assignments/get?id=${flatId}`);
check('pricing: grade angel earns 80% of the flat price', r.data.assignment.earnings_cents === 2000, JSON.stringify(r.data.assignment.earnings_cents));
r = await master.call('admin-pricing', 'POST', '/api/admin/pricing', { json: { min_total_cents: 1500, min_rate_cents: 10 } });
check('pricing: staff change the minimum total', r.status === 200 && r.data.min_total_cents === 1500);
await q(`UPDATE assignments SET status = 'cancelled' WHERE title = 'Priced'`);
await q(`UPDATE site_settings SET value = '0' WHERE key = 'min_total_cents'`);

// ---------- Grade Angel Pro ----------
r = await angel.call('pro', 'GET', '/api/pro');
check('pro: starts off, trial available', r.status === 200 && !r.data.active && r.data.trial_available && r.data.price_cents === 1000, JSON.stringify(r.data));
r = await angel.call('pro', 'POST', '/api/pro', { json: { action: 'start' } });
check('pro: must agree to the terms', r.status === 400);
r = await angel.call('pro', 'POST', '/api/pro', { json: { action: 'start', agree: true } });
check('pro: joined with a 7 day free trial', r.data.active && r.data.in_trial && !r.data.trial_available, JSON.stringify(r.data));
r = await teacher.call('pro', 'GET', '/api/pro');
check('pro: only for grade angels', r.status === 403);
const [pa] = await q(`INSERT INTO assignments (teacher_id, title, subject, grade_level, assignment_type, page_count, rate_per_page_cents, status, published_at)
  VALUES ($1, 'Fresh work', 'Math', '4th', 'combo', 10, 100, 'open', NOW()) RETURNING id`, [tiaId]);
r = await angel.call('assignments-list', 'GET', '/api/assignments/list?scope=open');
const fresh = r.data.assignments.find((x) => x.id === pa.id);
check('pro: first look at new work and 90% earnings', fresh && fresh.pro_first_look && fresh.earnings_cents === 900, JSON.stringify(fresh));
r = await teacher.call('grade-angels-list', 'GET', '/api/grade-angels');
check('pro: badge in the Grade Angel list', r.data.grade_angels.find((x) => x.full_name === 'Jordan Lee')?.pro === true);
r = await angel.call('profile-me', 'GET', '/api/profile');
check('pro: badge on their own dashboard', r.data.profile.pro === true);
await angel.call('pro', 'POST', '/api/pro', { json: { action: 'cancel' } });
r = await angel.call('profile-me', 'GET', '/api/profile');
check('pro: badge gone after cancelling', r.data.profile.pro === false);
r = await angel.call('assignments-list', 'GET', '/api/assignments/list?scope=open');
check('pro: with no Pro members, nobody waits', r.data.assignments.some((x) => x.id === pa.id));
await q(`INSERT INTO users (email, password_hash, role, full_name, pro_started_at) VALUES ('pro.other@example.com', 'x', 'grade_angel', 'Other Pro', NOW())`);
r = await angel.call('assignments-list', 'GET', '/api/assignments/list?scope=open');
check('pro: without Pro, brand new work is hidden for an hour', !r.data.assignments.some((x) => x.id === pa.id));
r = await angel.call('assignments-accept', 'POST', '/api/assignments/accept', { json: { assignment_id: pa.id } });
check('pro: without Pro, cannot accept during the first hour', r.status === 409 && /first hour/.test(r.data.error), JSON.stringify(r.data));
await q(`UPDATE users SET pro_trial_ends_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [angelId]);
r = await angel.call('pro', 'POST', '/api/pro', { json: { action: 'start', agree: true } });
check('pro: rejoining has no second free trial', r.data.active && !r.data.in_trial, JSON.stringify(r.data));
// A payout after the trial: 90% share, and this month's $10 comes out of it once.
const mkPaid = async (title) => {
  const [x] = await q(`INSERT INTO assignments (teacher_id, grade_angel_id, title, subject, grade_level, assignment_type, page_count, rate_per_page_cents, status, accepted_at, submitted_at)
    VALUES ($1, $2, $3, 'Math', '4th', 'combo', 10, 500, 'submitted', NOW(), NOW()) RETURNING id`, [tiaId, angelId, title]);
  await q(`INSERT INTO payments (assignment_id, amount_cents, platform_fee_cents, service_fee_cents, status, paid_at, test_mode) VALUES ($1, 5000, 1000, 150, 'paid', NOW(), true)`, [x.id]);
  return x.id;
};
const pro1 = await mkPaid('Pro payout 1');
await teacher.call('assignments-complete', 'POST', '/api/assignments/complete', { json: { assignment_id: pro1 } });
let proPay = (await q(`SELECT platform_fee_cents, pro_rate_applied, pro_charge_cents, payout_status FROM payments WHERE assignment_id = $1`, [pro1]))[0];
check('pro: payout at 90% with the monthly price taken once', proPay.platform_fee_cents === 500 && proPay.pro_rate_applied && proPay.pro_charge_cents === 1000 && proPay.payout_status === 'transferred', JSON.stringify(proPay));
const pro2 = await mkPaid('Pro payout 2');
await teacher.call('assignments-complete', 'POST', '/api/assignments/complete', { json: { assignment_id: pro2 } });
proPay = (await q(`SELECT pro_charge_cents FROM payments WHERE assignment_id = $1`, [pro2]))[0];
check('pro: not charged twice in a month', proPay.pro_charge_cents === 0, JSON.stringify(proPay));
r = await angel.call('pro', 'GET', '/api/pro');
check('pro: this month shows as paid', r.data.charged_this_month_cents === 1000);
await angel.call('pro', 'POST', '/api/pro', { json: { action: 'cancel' } });
await q(`DELETE FROM users WHERE email = 'pro.other@example.com'`);
await q(`UPDATE assignments SET published_at = NOW() - INTERVAL '2 hours' WHERE id = $1`, [pa.id]);

// ---------- Test accounts ----------
process.env.TEST_ACCOUNT_EMAILS = 'grader.test@example.com, TEACHER.test@example.com';
const tTeacher = client('test teacher');
const tAngel = client('test angel');
await tTeacher.call('auth-signup', 'POST', '/api/auth/signup', { json: { role: 'teacher', full_name: 'Test Teacher', email: 'teacher.test@example.com', password: 'password1', accept_terms: true } });
await tAngel.call('auth-signup', 'POST', '/api/auth/signup', { json: { role: 'grade_angel', full_name: 'Test Grader', email: 'grader.test@example.com', password: 'password1', accept_terms: true } });
r = await tAngel.call('grade-angel-setup', 'GET', '/api/grade-angel/setup');
check('test mode: background check and payouts count as done', r.data.status.background_check_clear && r.data.status.payouts_ready && r.data.status.test_account && !r.data.status.ready, JSON.stringify(r.data.status));
r = await angel.call('grade-angel-setup', 'GET', '/api/grade-angel/setup');
check('test mode: real grade angels are not affected', r.data.status.test_account === false);
const ttId = (await q(`SELECT id FROM users WHERE email = 'teacher.test@example.com'`))[0].id;
const taId = (await q(`SELECT id FROM users WHERE email = 'grader.test@example.com'`))[0].id;
const [ta] = await q(`INSERT INTO assignments (teacher_id, grade_angel_id, title, subject, grade_level, assignment_type, page_count, rate_per_page_cents, status, accepted_at)
  VALUES ($1, $2, 'Test run', 'Math', '4th', 'essay', 4, 150, 'accepted', NOW()) RETURNING id`, [ttId, taId]);
r = await tTeacher.call('assignments-pay', 'POST', '/api/assignments/pay', { json: { assignment_id: ta.id, success_url: 'https://ga.test/x' } });
let tp = (await q(`SELECT status, test_mode FROM payments WHERE assignment_id = $1`, [ta.id]))[0];
check('test mode: teacher pays without a card', r.status === 200 && r.data.paid && r.data.test && tp.status === 'paid' && tp.test_mode, JSON.stringify([r.data, tp]));
const feeRow = (await q(`SELECT service_fee_cents, amount_cents FROM payments WHERE assignment_id = $1`, [ta.id]))[0];
check('service fee: 3% added to what the teacher pays', feeRow.amount_cents === 600 && feeRow.service_fee_cents === 18, JSON.stringify(feeRow));
await q(`UPDATE assignments SET status = 'submitted', submitted_at = NOW() WHERE id = $1`, [ta.id]);
r = await tTeacher.call('assignments-complete', 'POST', '/api/assignments/complete', { json: { assignment_id: ta.id } });
tp = (await q(`SELECT payout_status, stripe_transfer_id FROM payments WHERE assignment_id = $1`, [ta.id]))[0];
check('test mode: payout recorded, no money moved', r.status === 200 && tp.payout_status === 'transferred' && tp.stripe_transfer_id.startsWith('test_transfer_'), JSON.stringify([r.data, tp]));
r = await teacher.call('assignments-pay', 'POST', '/api/assignments/pay', { json: { assignment_id: big, success_url: 'https://ga.test/x' } });
check('test mode: real teachers still need Stripe', r.status === 501);
r = await master.call('admin-overview', 'GET', '/api/admin/overview');
check('test mode: test money left out of real totals', Number(r.data.money.fees_cents) === 60, JSON.stringify(r.data.money));
// Gifts: a test email can give to a test teacher, never to a real one or the fund.
r = await tTeacher.call('gifts-mine', 'POST', '/api/gifts/mine', { json: { action: 'enable_link' } });
const tHandle = r.data.handle;
r = await stranger.call('gifts-checkout', 'POST', '/api/gifts/checkout', { json: { amount_cents: 2500, name: 'Coach', email: 'grader.test@example.com', to: tHandle } });
bal = (await q(`SELECT gift_balance_cents FROM users WHERE id = $1`, [ttId]))[0].gift_balance_cents;
check('test mode: test gift to test teacher credited', r.status === 200 && r.data.test && r.data.url.includes('thanks=1') && bal === 2500, JSON.stringify([r.data, bal]));
await teacher.call('gifts-mine', 'POST', '/api/gifts/mine', { json: { action: 'enable_link' } });
const tiaHandle = (await q(`SELECT handle FROM users WHERE id = $1`, [tiaId]))[0].handle;
const tiaBefore = (await q(`SELECT gift_balance_cents FROM users WHERE id = $1`, [tiaId]))[0].gift_balance_cents;
r = await stranger.call('gifts-checkout', 'POST', '/api/gifts/checkout', { json: { amount_cents: 2500, name: 'Coach', email: 'grader.test@example.com', to: tiaHandle } });
check('test mode: test email cannot give free money to a real teacher', r.status === 501 && (await q(`SELECT gift_balance_cents FROM users WHERE id = $1`, [tiaId]))[0].gift_balance_cents === tiaBefore, JSON.stringify(r.data));
r = await stranger.call('gifts-checkout', 'POST', '/api/gifts/checkout', { json: { amount_cents: 2500, name: 'Coach', email: 'grader.test@example.com' } });
check('test mode: test email cannot fill the community fund', r.status === 501);
r = await stranger.call('gifts-info', 'GET', '/api/gifts/info');
check('test mode: test gifts left out of public totals', r.data.stats.total_cents === 7000, JSON.stringify(r.data.stats));
delete process.env.TEST_ACCOUNT_EMAILS;

globalThis.fetch = realFetch;

await db.end();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
