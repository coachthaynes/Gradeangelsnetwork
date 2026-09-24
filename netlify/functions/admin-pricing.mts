import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { logAction, requireStaff } from "../lib/staff.mts";
import { getMinRateCents, getMinTotalCents } from "../lib/pricing.mts";

// The lowest price per page teachers may set. Anyone on staff can see it;
// managers and above can change it. It only applies to new assignments.
export default async (req: Request) => {
  if (req.method === "GET") {
    const staff = await requireStaff(req);
    if (staff instanceof Response) return staff;
    return json({ min_rate_cents: await getMinRateCents(), min_total_cents: await getMinTotalCents() }, 200);
  }
  if (req.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  const staff = await requireStaff(req, "manager");
  if (staff instanceof Response) return staff;
  const body = await readJson(req);
  if (body?.min_total_cents !== undefined) {
    const total = Math.round(Number(body.min_total_cents));
    if (!Number.isInteger(total) || total < 0 || total > 100000) return json({ error: "Choose a minimum from $0 to $1,000" }, 400);
    await db.sql`
      INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES ('min_total_cents', ${String(total)}, ${staff.session.id}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    `;
    await logAction(staff.session.id, "set minimum assignment total", null, null, `${total} cents`);
    if (body.min_rate_cents === undefined) return json({ min_rate_cents: await getMinRateCents(), min_total_cents: total }, 200);
  }
  const cents = Math.round(Number(body?.min_rate_cents));
  if (!Number.isInteger(cents) || cents < 1 || cents > 1000) {
    return json({ error: "Choose a lowest price from 1 cent to $10 a page" }, 400);
  }
  await db.sql`
    INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES ('min_rate_per_page_cents', ${String(cents)}, ${staff.session.id}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
  `;
  await logAction(staff.session.id, "set lowest price per page", null, null, `${cents} cents`);
  return json({ min_rate_cents: cents, min_total_cents: await getMinTotalCents() }, 200);
};

export const config: Config = {
  path: "/api/admin/pricing",
};
