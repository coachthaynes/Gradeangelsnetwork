import { db } from "./db.mts";
import {
  emailConfigured,
  emailSandbox,
  firstName,
  getSettings,
  renderEmail,
  sendEmail,
  unsubscribeUrl,
  type Recipient,
} from "./email.mts";

// When each campaign email goes out. The words live in the email_templates
// table (editable in the admin page); the timing rules live here, matched
// by template key. Every rule only reaches people who joined after the
// campaigns started, who have not unsubscribed, and who have not already
// received that email. Windows (like "between 2 and 7 days") stop an email
// from going out weeks late if sending was paused.

type Rule = (startedAt: string) => Promise<Recipient[]>;

const asUsers = (rows: any[]): Recipient[] => rows.map((r) => ({ kind: "user", id: r.id, email: r.email, name: r.full_name }));
const asLeads = (rows: any[]): Recipient[] => rows.map((r) => ({ kind: "lead", id: r.id, email: r.email, name: r.name }));

// Teachers who have not posted anything yet (drafts and cancellations do not count).
function teachersWithoutPosts(key: string, minHours: number, maxHours: number): Rule {
  return async (startedAt) => asUsers(await db.sql`
    SELECT u.id, u.email, u.full_name FROM users u
    WHERE u.role = 'teacher' AND u.email_opt_out_at IS NULL AND u.suspended_at IS NULL
      AND u.created_at >= ${startedAt}::timestamptz
      AND u.created_at <= NOW() - make_interval(hours => ${minHours})
      AND u.created_at >= NOW() - make_interval(hours => ${maxHours})
      AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.teacher_id = u.id AND a.status NOT IN ('draft', 'cancelled'))
      AND NOT EXISTS (SELECT 1 FROM email_sends s WHERE s.template_key = ${key} AND s.user_id = u.id AND s.status <> 'test')
  `);
}

function newUsers(key: string, role: string): Rule {
  return async (startedAt) => asUsers(await db.sql`
    SELECT u.id, u.email, u.full_name FROM users u
    WHERE u.role = ${role} AND u.email_opt_out_at IS NULL AND u.suspended_at IS NULL
      AND u.created_at >= ${startedAt}::timestamptz AND u.created_at >= NOW() - INTERVAL '3 days'
      AND NOT EXISTS (SELECT 1 FROM email_sends s WHERE s.template_key = ${key} AND s.user_id = u.id AND s.status <> 'test')
  `);
}

// Grade Angels by how long ago their account went live.
function liveAngels(key: string, minHours: number, maxHours: number, onlyWithoutWork = false): Rule {
  return async (startedAt) => asUsers(await db.sql`
    SELECT u.id, u.email, u.full_name FROM users u
    WHERE u.role = 'grade_angel' AND u.email_opt_out_at IS NULL AND u.suspended_at IS NULL
      AND u.created_at >= ${startedAt}::timestamptz
      AND u.went_live_at IS NOT NULL
      AND u.went_live_at <= NOW() - make_interval(hours => ${minHours})
      AND u.went_live_at >= NOW() - make_interval(hours => ${maxHours})
      AND (NOT ${onlyWithoutWork} OR NOT EXISTS (SELECT 1 FROM assignments a WHERE a.grade_angel_id = u.id))
      AND NOT EXISTS (SELECT 1 FROM email_sends s WHERE s.template_key = ${key} AND s.user_id = u.id AND s.status <> 'test')
  `);
}

export const RULES: Record<string, Rule> = {
  teacher_welcome: newUsers("teacher_welcome", "teacher"),
  teacher_trust: teachersWithoutPosts("teacher_trust", 48, 7 * 24),
  teacher_how_it_works: teachersWithoutPosts("teacher_how_it_works", 7 * 24, 12 * 24),
  teacher_checkin: teachersWithoutPosts("teacher_checkin", 12 * 24, 20 * 24),

  angel_welcome: newUsers("angel_welcome", "grade_angel"),
  angel_finish_setup: async (startedAt) => asUsers(await db.sql`
    SELECT u.id, u.email, u.full_name FROM users u
    WHERE u.role = 'grade_angel' AND u.email_opt_out_at IS NULL AND u.suspended_at IS NULL
      AND u.created_at >= ${startedAt}::timestamptz
      AND u.created_at <= NOW() - INTERVAL '48 hours' AND u.created_at >= NOW() - INTERVAL '10 days'
      AND u.contractor_agreement_signed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM email_sends s WHERE s.template_key = 'angel_finish_setup' AND s.user_id = u.id AND s.status <> 'test')
  `),
  angel_live: liveAngels("angel_live", 0, 7 * 24),
  angel_tips: liveAngels("angel_tips", 5 * 24, 12 * 24),
  angel_checkin: liveAngels("angel_checkin", 10 * 24, 20 * 24, true),

  lead_checklist: async (startedAt) => asLeads(await db.sql`
    SELECT l.id, l.email, l.name FROM leads l
    WHERE l.unsubscribed_at IS NULL AND l.created_at >= ${startedAt}::timestamptz AND l.created_at >= NOW() - INTERVAL '3 days'
      AND NOT EXISTS (SELECT 1 FROM email_sends s WHERE s.template_key = 'lead_checklist' AND s.lead_id = l.id AND s.status <> 'test')
  `),
  lead_invite: async (startedAt) => asLeads(await db.sql`
    SELECT l.id, l.email, l.name FROM leads l
    WHERE l.unsubscribed_at IS NULL AND l.created_at >= ${startedAt}::timestamptz
      AND l.created_at <= NOW() - INTERVAL '72 hours' AND l.created_at >= NOW() - INTERVAL '10 days'
      AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(l.email))
      AND NOT EXISTS (SELECT 1 FROM email_sends s WHERE s.template_key = 'lead_invite' AND s.lead_id = l.id AND s.status <> 'test')
  `),
};

// Records the moment each Grade Angel's account first became live, which
// the later Grade Angel emails count from.
export async function stampGoLive() {
  await db.sql`
    UPDATE users SET went_live_at = NOW()
    WHERE role = 'grade_angel' AND went_live_at IS NULL
      AND personal_completed_at IS NOT NULL AND profile_completed_at IS NOT NULL
      AND confidentiality_agreed_at IS NOT NULL AND contractor_agreement_signed_at IS NOT NULL
      AND background_check_status = 'clear' AND stripe_payouts_ready
  `;
}

// Sends one template to one person, once. The row in email_sends is
// claimed first, so two runs at the same moment cannot both send it.
export async function sendTemplate(template: any, r: Recipient, settings: Record<string, string>): Promise<"sent" | "failed" | "duplicate"> {
  const userId = r.kind === "user" ? r.id : null;
  const leadId = r.kind === "lead" ? r.id : null;
  const claimed = userId
    ? await db.sql`
        INSERT INTO email_sends (template_key, user_id, to_email, status) VALUES (${template.key}, ${userId}, ${r.email}, 'failed')
        ON CONFLICT (template_key, user_id) WHERE user_id IS NOT NULL AND status <> 'test' DO NOTHING RETURNING id`
    : await db.sql`
        INSERT INTO email_sends (template_key, lead_id, to_email, status) VALUES (${template.key}, ${leadId}, ${r.email}, 'failed')
        ON CONFLICT (template_key, lead_id) WHERE lead_id IS NOT NULL AND status <> 'test' DO NOTHING RETURNING id`;
  if (!claimed.length) return "duplicate";

  const unsubscribe = unsubscribeUrl(r);
  const email = renderEmail({
    subject: template.subject,
    body: template.body,
    ctaLabel: template.cta_label,
    ctaPath: template.cta_path,
    vars: { first_name: firstName(r.name) },
    unsubscribe,
    mailingAddress: settings.email_mailing_address || "",
    fromName: settings.email_from_name || "The Grade Angels Team",
  });
  try {
    const id = await sendEmail({ to: r.email, ...email, replyTo: settings.email_reply_to, fromName: settings.email_from_name, unsubscribe });
    await db.sql`UPDATE email_sends SET status = 'sent', provider_id = ${id} WHERE id = ${claimed[0].id}`;
    return "sent";
  } catch (err) {
    await db.sql`UPDATE email_sends SET error = ${String((err as Error).message).slice(0, 300)} WHERE id = ${claimed[0].id}`;
    return "failed";
  }
}

// Goes through every enabled campaign email and sends whatever is due.
// Stops at `limit` emails per run to stay well inside sending limits.
export async function runCampaigns(limit = 150) {
  const result = { sent: 0, failed: 0, skipped_reason: "" as string };
  if (!emailConfigured()) {
    result.skipped_reason = "Email is not connected (RESEND_API_KEY and EMAIL_FROM)";
    return result;
  }
  if (emailSandbox()) {
    result.skipped_reason = "Sandbox mode: only test sends go out until your own domain is connected";
    return result;
  }
  await stampGoLive();
  const settings = await getSettings();
  const startedAt = settings.campaigns_started_at || new Date().toISOString();
  const templates = await db.sql`SELECT * FROM email_templates WHERE enabled ORDER BY audience, position`;
  for (const t of templates) {
    const rule = RULES[t.key];
    if (!rule) continue;
    for (const r of await rule(startedAt)) {
      if (result.sent + result.failed >= limit) return result;
      const outcome = await sendTemplate(t, r, settings);
      if (outcome === "sent") result.sent++;
      if (outcome === "failed") result.failed++;
    }
  }
  return result;
}

// Sends a campaign's first email right away (welcome or checklist) instead
// of waiting for the hourly run. Never throws: sign up must not fail
// because of email.
export async function sendNow(key: string, r: Recipient) {
  try {
    if (!emailConfigured() || emailSandbox()) return;
    const [t] = await db.sql`SELECT * FROM email_templates WHERE key = ${key} AND enabled`;
    if (!t) return;
    await sendTemplate(t, r, await getSettings());
  } catch (err) {
    console.error("sendNow failed", key, err);
  }
}
