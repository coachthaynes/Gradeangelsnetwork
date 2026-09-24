import type { Config } from "@netlify/functions";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { getMinRateCents, getMinTotalCents, priceHint } from "../lib/pricing.mts";
import { PLATFORM_FEE_RATE } from "../lib/grade-angel.mts";

// What the Post an assignment form shows next to the price box: the lowest
// price allowed, the Grade Angel's share, and what similar work went for.
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);

  const url = new URL(req.url);
  const type = url.searchParams.get("assignment_type") || "";
  const hint = ["multiple_choice", "combo", "essay"].includes(type)
    ? await priceHint(type, url.searchParams.get("grade_level") || "", url.searchParams.get("subject") || "")
    : null;

  return json({ min_rate_cents: await getMinRateCents(), min_total_cents: await getMinTotalCents(), grade_angel_share: 1 - PLATFORM_FEE_RATE, hint }, 200);
};

export const config: Config = {
  path: "/api/pricing",
};
