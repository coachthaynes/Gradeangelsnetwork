import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { findGiftTeacher, MAX_GIFT_CENTS, MIN_GIFT_CENTS, publicGiftTeacher } from "../lib/gifts.mts";

// What the public Give page needs: who a gift link or @username is for
// (only the teacher's public name, @username, note, and their school if
// they chose to show it, never contact details) and a few totals to show supporters their gifts add up.
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const params = new URL(req.url).searchParams;
  const token = params.get("t");
  const handle = params.get("to");

  let teacher = null;
  if (token || handle) {
    const t = await findGiftTeacher({ token, handle });
    if (!t) return json({ error: "This gift link is no longer active" }, 404);
    teacher = publicGiftTeacher(t);
  }

  const [stats] = await db.sql`
    SELECT COALESCE(SUM(amount_cents), 0)::int AS total_cents,
           COUNT(*)::int AS gifts
    FROM gifts WHERE status = 'paid'
  `;
  const [helped] = await db.sql`
    SELECT COUNT(DISTINCT teacher_id)::int AS teachers FROM gift_ledger WHERE teacher_id IS NOT NULL AND kind IN ('gift', 'grant')
  `;

  return json({
    teacher,
    stats: { ...stats, teachers_helped: helped.teachers },
    min_cents: MIN_GIFT_CENTS,
    max_cents: MAX_GIFT_CENTS,
  }, 200);
};

export const config: Config = {
  path: "/api/gifts/info",
};
