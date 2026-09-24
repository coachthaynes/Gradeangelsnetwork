import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { emailConfigured, getSettings, renderEmail, sendEmail, siteUrl } from "../lib/email.mts";
import { runCampaigns } from "../lib/drips.mts";
import { logAction, requireStaff } from "../lib/staff.mts";

const SETTING_KEYS = ["email_from_name", "email_reply_to", "email_mailing_address"];
const POST_STATUSES = new Set(["idea", "ready", "scheduled", "posted"]);

// Everything behind the admin Marketing tab.
// GET  ?view=overview | campaigns | leads | calendar   (any staff)
// GET  ?view=leads&format=csv                           (manager and above)
// POST { action, ... }                                  (manager and above)
export default async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const csv = url.searchParams.get("format") === "csv";
    const staff = await requireStaff(req, csv ? "manager" : "support");
    if (staff instanceof Response) return staff;
    const view = url.searchParams.get("view") || "overview";

    if (view === "overview") {
      const [counts] = await db.sql`
        SELECT (SELECT COUNT(*)::int FROM leads) AS leads,
               (SELECT COUNT(*)::int FROM leads WHERE created_at > NOW() - INTERVAL '30 days') AS leads_30d,
               (SELECT COUNT(*)::int FROM email_sends WHERE status = 'sent' AND created_at > NOW() - INTERVAL '30 days') AS emails_30d,
               (SELECT COUNT(*)::int FROM email_sends WHERE status = 'failed' AND created_at > NOW() - INTERVAL '30 days') AS failed_30d,
               (SELECT COUNT(*)::int FROM users WHERE email_opt_out_at IS NOT NULL) + (SELECT COUNT(*)::int FROM leads WHERE unsubscribed_at IS NOT NULL) AS unsubscribed
      `;
      const sources = await db.sql`
        SELECT COALESCE(NULLIF(src, ''), 'direct or unknown') AS source,
               COUNT(*) FILTER (WHERE kind = 'teacher')::int AS teachers,
               COUNT(*) FILTER (WHERE kind = 'grade_angel')::int AS grade_angels,
               COUNT(*) FILTER (WHERE kind = 'lead')::int AS leads
        FROM (
          SELECT signup_source AS src, role AS kind FROM users WHERE role IN ('teacher', 'grade_angel')
          UNION ALL SELECT source, 'lead' FROM leads
        ) x
        GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 25
      `;
      const settings = await getSettings();
      return json({
        counts,
        sources,
        email_connected: emailConfigured(),
        settings: Object.fromEntries(SETTING_KEYS.map((k) => [k, settings[k] || ""])),
        campaigns_started_at: settings.campaigns_started_at,
        site_url: siteUrl(),
        can_edit: staff.level !== "support",
      }, 200);
    }

    if (view === "campaigns") {
      const templates = await db.sql`
        SELECT t.*, u.full_name AS updated_by_name,
               (SELECT COUNT(*)::int FROM email_sends s WHERE s.template_key = t.key AND s.status = 'sent') AS sent,
               (SELECT COUNT(*)::int FROM email_sends s WHERE s.template_key = t.key AND s.status = 'failed') AS failed,
               (SELECT MAX(created_at) FROM email_sends s WHERE s.template_key = t.key AND s.status = 'sent') AS last_sent_at
        FROM email_templates t LEFT JOIN users u ON u.id = t.updated_by
        ORDER BY CASE t.audience WHEN 'teacher' THEN 1 WHEN 'grade_angel' THEN 2 ELSE 3 END, t.position
      `;
      const recent = await db.sql`
        SELECT s.template_key, s.to_email, s.status, s.error, s.created_at FROM email_sends s
        ORDER BY s.created_at DESC LIMIT 50
      `;
      return json({ templates, recent, email_connected: emailConfigured() }, 200);
    }

    if (view === "leads") {
      const leads = await db.sql`
        SELECT l.id, l.email, l.name, l.role, l.source, l.medium, l.campaign, l.unsubscribed_at, l.created_at,
               EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(l.email)) AS signed_up
        FROM leads l ORDER BY l.created_at DESC LIMIT 2000
      `;
      if (!csv) return json({ leads }, 200);
      await logAction(staff.session.id, "exported leads", null, null, `${leads.length} rows`);
      const cell = (v: unknown) => {
        const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const cols = ["email", "name", "role", "source", "medium", "campaign", "signed_up", "unsubscribed_at", "created_at"];
      const body = [cols.join(",")].concat(leads.map((l: any) => cols.map((c) => cell(l[c])).join(","))).join("\n");
      return new Response(body, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="grade-angels-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    if (view === "calendar") {
      const posts = await db.sql`
        SELECT p.*, u.full_name AS updated_by_name FROM marketing_posts p LEFT JOIN users u ON u.id = p.updated_by
        ORDER BY p.planned_for NULLS LAST, p.id
      `;
      return json({ posts }, 200);
    }
    return json({ error: "Unknown view" }, 400);
  }

  if (req.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  const body = await readJson(req);
  const action = String(body?.action || "");

  // Renders an email draft for the editor's live preview. Any staff member
  // can preview; nothing is saved or sent.
  if (action === "preview") {
    const viewer = await requireStaff(req);
    if (viewer instanceof Response) return viewer;
    const settings = await getSettings();
    const preview = renderEmail({
      subject: String(body?.subject || ""), body: String(body?.body || ""),
      ctaLabel: String(body?.cta_label || "") || null, ctaPath: String(body?.cta_path || "") || null,
      vars: { first_name: "Jordan" }, unsubscribe: `${siteUrl()}/`,
      mailingAddress: settings.email_mailing_address || "Your mailing address appears here",
      fromName: settings.email_from_name || "The Grade Angels Team",
    });
    return json({ preview }, 200);
  }

  const staff = await requireStaff(req, "manager");
  if (staff instanceof Response) return staff;
  const actor = staff.session.id;

  if (action === "save_template") {
    const key = String(body?.key || "");
    const subject = String(body?.subject || "").trim().slice(0, 200);
    const text = String(body?.body || "").trim().slice(0, 8000);
    if (!subject || !text) return json({ error: "Subject and message are required" }, 400);
    const rows = await db.sql`
      UPDATE email_templates
      SET subject = ${subject}, body = ${text}, cta_label = ${String(body?.cta_label || "").trim().slice(0, 60) || null},
          cta_path = ${String(body?.cta_path || "").trim().slice(0, 300) || null},
          updated_by = ${actor}, updated_at = NOW()
      WHERE key = ${key} RETURNING name
    `;
    if (!rows.length) return json({ error: "Email not found" }, 404);
    await logAction(actor, "edited campaign email", null, null, rows[0].name);
    return json({ ok: true }, 200);
  }

  if (action === "toggle_template") {
    const rows = await db.sql`
      UPDATE email_templates SET enabled = ${body?.enabled === true}, updated_by = ${actor}, updated_at = NOW()
      WHERE key = ${String(body?.key || "")} RETURNING name, enabled
    `;
    if (!rows.length) return json({ error: "Email not found" }, 404);
    await logAction(actor, rows[0].enabled ? "turned on campaign email" : "turned off campaign email", null, null, rows[0].name);
    return json({ ok: true }, 200);
  }

  if (action === "test_send") {
    const [t] = await db.sql`SELECT * FROM email_templates WHERE key = ${String(body?.key || "")}`;
    if (!t) return json({ error: "Email not found" }, 404);
    const [me] = await db.sql`SELECT email, full_name FROM users WHERE id = ${actor}`;
    const settings = await getSettings();
    const email = renderEmail({
      subject: "[Test] " + t.subject, body: t.body, ctaLabel: t.cta_label, ctaPath: t.cta_path,
      vars: { first_name: String(me.full_name).split(" ")[0] }, unsubscribe: `${siteUrl()}/`,
      mailingAddress: settings.email_mailing_address || "", fromName: settings.email_from_name || "The Grade Angels Team",
    });
    if (body?.preview_only) return json({ preview: email }, 200);
    try {
      const id = await sendEmail({ to: me.email, ...email, replyTo: settings.email_reply_to, fromName: settings.email_from_name });
      await db.sql`INSERT INTO email_sends (template_key, user_id, to_email, status, provider_id) VALUES (${t.key}, ${actor}, ${me.email}, 'test', ${id})`;
      return json({ ok: true, sent_to: me.email }, 200);
    } catch (err) {
      return json({ error: (err as Error).message }, 502);
    }
  }

  if (action === "save_settings") {
    for (const k of SETTING_KEYS) {
      if (body?.[k] === undefined) continue;
      const v = String(body[k]).trim().slice(0, 300);
      await db.sql`
        INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (${k}, ${v}, ${actor}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
      `;
    }
    await logAction(actor, "changed email settings", null, null, null);
    return json({ ok: true }, 200);
  }

  if (action === "run_now") {
    const result = await runCampaigns();
    await logAction(actor, "ran email campaigns", null, null, JSON.stringify(result));
    return json(result, 200);
  }

  if (action === "save_post") {
    const id = Number(body?.id) || null;
    const title = String(body?.title || "").trim().slice(0, 160);
    if (!title) return json({ error: "Give the post a title" }, 400);
    const status = POST_STATUSES.has(String(body?.status)) ? String(body?.status) : "idea";
    const kind = body?.kind === "outreach" ? "outreach" : "post";
    const planned = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.planned_for || "")) ? String(body.planned_for) : null;
    const fields = {
      channels: String(body?.channels || "").trim().slice(0, 120) || null,
      caption: String(body?.caption || "").trim().slice(0, 4000) || null,
      hashtags: String(body?.hashtags || "").trim().slice(0, 500) || null,
      notes: String(body?.notes || "").trim().slice(0, 2000) || null,
    };
    if (id) {
      await db.sql`
        UPDATE marketing_posts SET planned_for = ${planned}, kind = ${kind}, channels = ${fields.channels}, title = ${title},
          caption = ${fields.caption}, hashtags = ${fields.hashtags}, status = ${status}, notes = ${fields.notes},
          updated_by = ${actor}, updated_at = NOW()
        WHERE id = ${id}
      `;
    } else {
      await db.sql`
        INSERT INTO marketing_posts (planned_for, kind, channels, title, caption, hashtags, status, notes, updated_by)
        VALUES (${planned}, ${kind}, ${fields.channels}, ${title}, ${fields.caption}, ${fields.hashtags}, ${status}, ${fields.notes}, ${actor})
      `;
    }
    return json({ ok: true }, 200);
  }

  if (action === "delete_post") {
    await db.sql`DELETE FROM marketing_posts WHERE id = ${Number(body?.id)}`;
    return json({ ok: true }, 200);
  }

  return json({ error: "Unknown action" }, 400);
};

export const config: Config = {
  path: "/api/admin/marketing",
};
