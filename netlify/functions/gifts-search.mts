import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { cleanHandle, publicGiftTeacher } from "../lib/gifts.mts";

// The "Who is this gift for?" search on the Give page. Only teachers who
// turned on their gift link can be found, and only by their @username or
// the public name they already show (never their full name or email).
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const q = cleanHandle(new URL(req.url).searchParams.get("q")).slice(0, 40);
  if (q.length < 2) return json({ teachers: [] }, 200);
  const like = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;

  const rows = await db.sql`
    SELECT id, role, full_name, display_name, handle, school_or_org, gift_show_school
    FROM users
    WHERE role = 'teacher' AND suspended_at IS NULL AND gift_link_token IS NOT NULL AND handle IS NOT NULL
      AND (LOWER(handle) LIKE ${like}
           OR LOWER(COALESCE(display_name, '')) LIKE ${like}
           -- Without a display name, the public name starts with the first name.
           OR (display_name IS NULL AND LOWER(SPLIT_PART(TRIM(full_name), ' ', 1)) LIKE ${like}))
    ORDER BY (LOWER(handle) = ${q}) DESC, (LOWER(handle) LIKE ${q + "%"}) DESC, handle
    LIMIT 8
  `;
  return json({ teachers: rows.map((t: any) => { const { note, ...rest } = publicGiftTeacher(t); return rest; }) }, 200);
};

export const config: Config = {
  path: "/api/gifts/search",
};
