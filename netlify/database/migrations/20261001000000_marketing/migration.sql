-- Marketing: automated email campaigns, lead capture, sign up source
-- tracking, a content calendar, and editable marketing settings.

-- Where each person came from (utm tags or the site that linked to us).
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_source TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_medium TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_campaign TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_referrer TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_opt_out_at TIMESTAMPTZ;
-- When a Grade Angel's account first went live, for timed emails after that.
ALTER TABLE users ADD COLUMN IF NOT EXISTS went_live_at TIMESTAMPTZ;

-- People who asked for the free grading checklist.
CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT,
  source TEXT,
  medium TEXT,
  campaign TEXT,
  referrer TEXT,
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Key and value settings staff can edit, such as the mailing address that
-- every marketing email must show.
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Campaigns only reach people who sign up (or ask for the checklist) after
-- this moment, so launching them never emails existing accounts out of the blue.
INSERT INTO site_settings (key, value) VALUES
  ('email_from_name', 'The Grade Angels Team'),
  ('email_reply_to', ''),
  ('email_mailing_address', ''),
  ('campaigns_started_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT (key) DO NOTHING;

-- The emails in each campaign. When each one goes out is decided in code
-- (netlify/lib/drips.mts, matched by key); the words are edited here from
-- the admin page. Body format: blank line between paragraphs, "* " starts a
-- bullet, "1. " a numbered step, **text** is bold, {{first_name}} is replaced.
CREATE TABLE IF NOT EXISTS email_templates (
  key TEXT PRIMARY KEY,
  audience TEXT NOT NULL CHECK (audience IN ('teacher', 'grade_angel', 'lead')),
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  trigger_text TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  cta_label TEXT,
  cta_path TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_sends (
  id SERIAL PRIMARY KEY,
  template_key TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped', 'test')),
  provider_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sends_user_once ON email_sends(template_key, user_id) WHERE user_id IS NOT NULL AND status <> 'test';
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sends_lead_once ON email_sends(template_key, lead_id) WHERE lead_id IS NOT NULL AND status <> 'test';
CREATE INDEX IF NOT EXISTS idx_email_sends_created ON email_sends(created_at DESC);

-- Social posts and outreach tasks for the content calendar.
CREATE TABLE IF NOT EXISTS marketing_posts (
  id SERIAL PRIMARY KEY,
  planned_for DATE,
  kind TEXT NOT NULL DEFAULT 'post' CHECK (kind IN ('post', 'outreach')),
  channels TEXT,
  title TEXT NOT NULL,
  caption TEXT,
  hashtags TEXT,
  status TEXT NOT NULL DEFAULT 'idea' CHECK (status IN ('idea', 'ready', 'scheduled', 'posted')),
  notes TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===== Starting email copy, adapted from the 30 day marketing plan =====

INSERT INTO email_templates (key, audience, position, name, trigger_text, subject, body, cta_label, cta_path) VALUES
('teacher_welcome', 'teacher', 1, 'Welcome', 'Right after a teacher signs up',
 $t$Welcome to Grade Angels, your evenings are about to open up$t$,
 $t$Hi {{first_name}},

Welcome to Grade Angels Network! You just took the first step toward getting your Sundays back.

We built Grade Angels because teachers lose so much time to stack after stack of assignments. Here you set your own rate per page, upload the work, and let a vetted Grade Angel handle the grading.

**Posting your first assignment takes about 3 minutes:**

1. Open your dashboard and choose Post an assignment.
2. Pick the subject, grade level, and your rate per page.
3. Snap photos of the pages or upload a PDF, and add your answer key or rubric notes.

Questions before you post? Just reply to this email. We read every one.$t$,
 'Post your first assignment', '/dashboard-teacher.html'),

('teacher_trust', 'teacher', 2, 'How vetting works', '2 days after sign up, if they have not posted yet',
 $t$"Will they grade it the way I would?" Here is how vetting works$t$,
 $t$Hi {{first_name}},

Handing off your students' work can feel like a big step. You care about feedback quality, privacy, and accuracy, and so do we.

**Here is how Grade Angels protects your standards:**

* **Vetted graders:** every Grade Angel completes a background check and signs a confidentiality agreement before they can accept work.
* **Your rules:** you add your answer key, rubric, and instructions to every assignment.
* **You approve before payout:** you review the graded work before marking it complete, and the Grade Angel is only paid after that.
* **Privacy first:** we suggest covering student names or using ID numbers. Grade Angels only need the work itself.

Try starting small with a quick homework check or a short quiz.$t$,
 'Upload your first assignment', '/dashboard-teacher.html'),

('teacher_how_it_works', 'teacher', 3, 'What happens after you post', '7 days after sign up, if they have not posted yet',
 $t$What happens after you post an assignment$t$,
 $t$Hi {{first_name}},

The hardest part is making that first post, so here is exactly what happens next:

1. **A Grade Angel accepts it.** You can let any available Grade Angel pick it up, or send it to one you choose from their profile and reviews.
2. **You can chat.** Questions about your rubric get answered right on the assignment page.
3. **The graded work comes back** by the deadline you picked, 24 hours to 4 days.
4. **You review it and mark it complete.** Then you can leave a review so great Grade Angels stand out.

Picture picking up a finished stack with clear feedback, ready to hand back. That could be this week.$t$,
 'Reclaim your weekend', '/dashboard-teacher.html'),

('teacher_checkin', 'teacher', 4, 'Check in', '12 days after sign up, if they have not posted yet',
 $t$Anything stopping you from posting, {{first_name}}?$t$,
 $t$Hi {{first_name}},

I noticed you have not posted your first assignment on Grade Angels yet, and I would love to know how we can help.

Are you waiting on an upcoming midterm stack? Unsure how to price an assignment? Or do you have a question about privacy?

Hit reply and let me know. I personally read every email and want to make sure you get the support you need.$t$,
 'Go to my dashboard', '/dashboard-teacher.html'),

('angel_welcome', 'grade_angel', 1, 'Welcome', 'Right after a Grade Angel signs up',
 $t$Welcome to Grade Angels! Let's set up your profile$t$,
 $t$Hi {{first_name}},

Thank you for joining the Grade Angels Network! You are on your way to earning flexible income while helping dedicated teachers get their time back.

You can browse open assignments right away. To start accepting them, finish your setup:

1. **Your profile:** your experience, subjects, and grade levels.
2. **Agreements:** confidentiality and the independent contractor agreement.
3. **Background check:** a quick, secure check that keeps our school communities safe.
4. **Payouts:** connect your bank through Stripe so you get paid when teachers approve your work.

Let's get you ready for your first grading assignment!$t$,
 'Finish my setup', '/grade-angel-setup.html'),

('angel_finish_setup', 'grade_angel', 2, 'Finish setup reminder', '2 days after sign up, if steps 1 to 3 are not done',
 $t$A few steps left before you can accept assignments$t$,
 $t$Hi {{first_name}},

Teachers are posting grading work, but you cannot accept assignments until your setup is complete.

Your profile, agreements, and the remaining steps take just a few minutes, and your progress is saved as you go.

Questions about any step? Reply to this email and our team will help.$t$,
 'Continue my setup', '/grade-angel-setup.html'),

('angel_live', 'grade_angel', 3, 'You are live', 'As soon as all setup steps are complete',
 $t$You're approved! Here's how to pick your first assignment$t$,
 $t$Great news, {{first_name}}! Your setup is complete and your account is live.

**Here is how to grab your first assignment:**

1. Open your dashboard and look at Open assignments.
2. Turn on "Only show my subjects and types" to see the best matches.
3. Check the pay, page count, and turnaround time, and preview the first pages.
4. Choose Accept to lock it in.

Once accepted, follow the teacher's instructions, upload the graded work before the deadline, and you are paid once the teacher marks it complete.$t$,
 'Browse open assignments', '/dashboard-grade-angel.html'),

('angel_tips', 'grade_angel', 4, 'Tips for 5 star reviews', '5 days after going live',
 $t$How to earn 5 star reviews and repeat teachers$t$,
 $t$Hi {{first_name}},

Teachers love Grade Angels who are reliable, clear, and detail oriented. A top rated profile means teachers send work to you directly.

**Three habits of our best Grade Angels:**

* **Follow the key and rubric exactly.** Match your feedback to the teacher's instructions.
* **Deliver on time.** Teachers plan lessons around your turnaround.
* **Write feedback students can learn from.** Short, specific, and kind.

Ready for another assignment?$t$,
 'View open assignments', '/dashboard-grade-angel.html'),

('angel_checkin', 'grade_angel', 5, 'Check in', '10 days after going live, if they have not accepted work',
 $t$Need help finding the right assignment?$t$,
 $t$Hi {{first_name}},

We noticed you have not picked up your first grading assignment yet.

Looking for particular subjects or more volume? Have a question about submitting graded work? We are here to help.

What subjects or schedules work best for you? Reply and let us know, or sign in to see the latest postings.$t$,
 'Sign in to Grade Angels', '/dashboard-grade-angel.html'),

('lead_checklist', 'lead', 1, 'Send the free checklist', 'Right after someone asks for the checklist',
 $t$Your free Rubric and Time Saving Grading Checklist$t$,
 $t$Hi {{first_name}},

Here is your free Rubric and Time Saving Grading Checklist. It has a simple rubric template and 12 habits that cut grading time without cutting feedback quality.

Print it, share it with your department, and keep it by your grading pile.

When the stack gets too tall, Grade Angels can take it off your plate. Vetted graders, your answer key, your rules.$t$,
 'Open the checklist', '/checklist.html'),

('lead_invite', 'lead', 2, 'Invite to join', '3 days after the checklist, if they have not signed up',
 $t$Want your next stack graded for you?$t$,
 $t$Hi {{first_name}},

We hope the checklist is saving you time already.

When you would rather hand off the whole stack, Grade Angels is ready. Post an assignment in about 3 minutes, set your own rate per page, and a background checked Grade Angel grades it with your key and rubric.

You review everything before anyone is paid.$t$,
 'Create my free account', '/signup.html')
ON CONFLICT (key) DO NOTHING;

-- ===== Starting content calendar, from weeks 1 to 4 of the plan =====

INSERT INTO marketing_posts (planned_for, kind, channels, title, caption, hashtags, status, notes) VALUES
(CURRENT_DATE, 'outreach', 'Setup', 'Create social accounts',
 'Create Grade Angels accounts on TikTok, Instagram, Facebook, and LinkedIn with the same name, logo, and bio: "Vetted graders for busy teachers. Take back your Sunday." Link to the website in each bio.', NULL, 'idea',
 'Week 1. Connect all four in Buffer or Metricool so posts can be scheduled from one place.'),
(CURRENT_DATE + 1, 'post', 'TikTok, Instagram', 'The Sunday stack',
 'POV: it is Sunday at 8 PM and this is still waiting for you. 📚 What if someone vetted could grade it with your answer key while you have dinner with your family? That is Grade Angels.', '#TeacherTok #EdTikTok #TeacherLife #TeachersOfInstagram #GradingPapers', 'ready',
 'Short video: slow pan across a tall stack of papers, then cut to a family dinner table.'),
(CURRENT_DATE + 2, 'post', 'Facebook, LinkedIn', 'Why we started Grade Angels',
 'Teachers spend hours every week grading outside the school day. We started Grade Angels Network to give that time back: vetted, background checked graders who use your answer key and rubric, so you can spend your evenings on lessons, family, or rest.', NULL, 'ready',
 'Share the founder story in your own words. Add a real photo if you can.'),
(CURRENT_DATE + 3, 'post', 'Instagram, Facebook', 'How vetting works',
 'Handing off student work is a big step. Here is how every Grade Angel is vetted: ✅ background check ✅ signed confidentiality agreement ✅ your key and rubric on every job ✅ you approve the work before anyone is paid.', '#Teachers #EducationMatters #TeacherSupport', 'ready',
 'Carousel of 4 simple slides, one per checkmark, in white, seafoam, and black.'),
(CURRENT_DATE + 5, 'post', 'TikTok, Instagram', 'Before and after Grade Angels',
 'Before: grading until midnight. After: stack handed back, fully graded, and you actually watched that show. 🙌', '#TeacherTok #EdTikTok #TeacherHumor #WorkLifeBalance', 'idea',
 'Week 2. Split screen skit, tired teacher vs. relaxed teacher.'),
(CURRENT_DATE + 6, 'outreach', 'Facebook groups', 'Join teacher Facebook groups',
 'Join 5 to 10 teacher groups (subject groups like High School English Teachers, plus local educator groups). For the first week, only comment helpfully on grading questions. Do not post links yet.', NULL, 'idea',
 'Week 2. Read each group''s rules. Many forbid promotion; share tips first.'),
(CURRENT_DATE + 7, 'outreach', 'Email', 'Email local department chairs',
 'Hi [Name], I am [your name] with Grade Angels Network, a local service where background checked graders (many are retired teachers) grade assignments using the teacher''s own key and rubric. Would your department like a short overview for teachers who are buried at midterms? Happy to drop off flyers too. Thank you for all you do!', NULL, 'idea',
 'Week 2. Personalize each one. Keep a list of who you contacted and when.'),
(CURRENT_DATE + 8, 'outreach', 'Print', 'Drop flyers at schools',
 'Print the teacher flyer from /flyer.html and ask front offices if you can leave a few in the teacher lounge. Midterm and end of quarter weeks work best.', NULL, 'idea',
 'Week 2. Always ask permission first.'),
(CURRENT_DATE + 9, 'post', 'Instagram, Facebook', 'Free grading checklist',
 'Free for teachers: our Rubric and Time Saving Grading Checklist. 12 habits that cut grading time without cutting feedback quality. Grab it at the link in our bio. 📝', '#TeacherTips #Grading #TeachersFollowTeachers', 'ready',
 'Link to the homepage checklist form. Add ?utm_source=instagram to the link to track sign ups.'),
(CURRENT_DATE + 12, 'post', 'LinkedIn, Facebook', 'Calling retired teachers',
 'Retired teachers: your experience is still needed. Grade Angels pays you to grade assignments for today''s busy teachers, from home, on your own schedule. You choose the subjects and the work you accept.', '#RetiredTeachers #Education #FlexibleWork', 'ready',
 'Week 3. Supply side recruitment.'),
(CURRENT_DATE + 13, 'outreach', 'Email', 'Contact retired teacher associations',
 'Hello, I am [your name] with Grade Angels Network. We connect retired teachers with flexible, paid grading work for today''s classroom teachers. Could we share this opportunity in your newsletter or at a meeting? I can send a short blurb and a flyer.', NULL, 'idea',
 'Week 3. Search your state and county retired educator associations.'),
(CURRENT_DATE + 14, 'outreach', 'Handshake', 'Post on college job boards',
 'Job title: Remote Grader, Grade Angels Network. Grade assignments for K to 12 teachers using their answer keys and rubrics. Flexible hours, choose your subjects, paid per page. Great for education, English, and STEM graduate students. Background check required.', NULL, 'idea',
 'Week 3. Post on Handshake and education department job boards.'),
(CURRENT_DATE + 15, 'post', 'TikTok, Instagram', 'Meet a Grade Angel',
 'Meet a Grade Angel: [name], retired [subject] teacher, [years] years in the classroom. "[Their quote about why they grade.]"', '#TeacherTok #RetiredTeacher #GradeAngels', 'idea',
 'Week 3. Only with a real Grade Angel''s permission and their own words.'),
(CURRENT_DATE + 17, 'post', 'Instagram, Facebook', 'How we keep student work safe',
 'Your students'' privacy matters. Grade Angels are background checked, sign a confidentiality agreement, and never see who the teacher is. We recommend covering names or using ID numbers, and work is shared only with the Grade Angel grading it.', '#StudentPrivacy #Teachers #EdTech', 'ready',
 'Week 3. Trust and safety content.'),
(CURRENT_DATE + 20, 'post', 'Facebook, Instagram', 'Sponsor a teacher''s Sunday evening',
 'Parents, PTAs, and neighbors: what if you could give a teacher their Sunday back? Gift Angels is coming soon, a way to sponsor grading for a teacher you love. Follow along to be first to know. 💚', '#TeacherAppreciation #PTA #SupportTeachers', 'idea',
 'Week 4. Teaser only; Gift Angels is not built yet.'),
(CURRENT_DATE + 22, 'outreach', 'Email', 'Pitch local news and podcasts',
 'Hi [Name], teacher burnout is one of the biggest challenges in our schools. Grade Angels Network is a local startup tackling it with community support: vetted graders, many of them retired teachers, who give classroom teachers their evenings back. Would you be interested in the story? I can connect you with teachers and Grade Angels.', NULL, 'idea',
 'Week 4. Local TV, newspapers, education podcasts, and ed tech blogs.'),
(CURRENT_DATE + 24, 'post', 'TikTok, Instagram', 'Time lapse of a graded stack',
 'Watch a 60 page stack get graded while the teacher sleeps. 😴📚', '#TeacherTok #EdTikTok #Satisfying', 'idea',
 'Week 4. Time lapse video with a real (anonymized) stack, only with permission.'),
(CURRENT_DATE + 27, 'post', 'LinkedIn', 'What we learned in month one',
 'One month in: here is what teachers told us about grading, time, and burnout, and what we are building next. Thank you to every teacher and Grade Angel who joined us.', NULL, 'idea',
 'Week 4. Share real numbers and lessons from the admin dashboard.');
