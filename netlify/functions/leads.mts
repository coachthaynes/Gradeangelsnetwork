import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { sendNow } from "../lib/drips.mts";

const clip = (v: unknown, n: number) => (v ? String(v).trim().slice(0, n) : null);

// The homepage "free grading checklist" form. Saves the person as a lead
// (with where they came from) and emails them the checklist right away.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);
  const body = await readJson(req);
  if (!body) return json({ error: "Body must be JSON" }, 400);

  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) {
    return json({ error: "Enter a valid email address" }, 400);
  }
  // A hidden field real people never fill in; bots usually do.
  if (body.website) return json({ ok: true }, 200);

  const rows = await db.sql`
    INSERT INTO leads (email, name, role, source, medium, campaign, referrer)
    VALUES (${email}, ${clip(body.name, 80)}, ${clip(body.role, 30)}, ${clip(body.source, 80)},
            ${clip(body.medium, 80)}, ${clip(body.campaign, 120)}, ${clip(body.referrer, 300)})
    ON CONFLICT (email) DO UPDATE SET unsubscribed_at = NULL
    RETURNING id, email, name, (xmax = 0) AS created
  `;
  const lead = rows[0];
  if (lead.created) await sendNow("lead_checklist", { kind: "lead", id: lead.id, email: lead.email, name: lead.name });

  return json({ ok: true, checklist_url: "/checklist.html" }, 200);
};

export const config: Config = {
  path: "/api/leads",
};
