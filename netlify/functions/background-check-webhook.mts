import type { Config, Context } from "@netlify/functions";
import crypto from "node:crypto";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";

// Checkr calls this when a report's status changes. It is not a signed-in
// person, so there is no session check, only a signature check against
// CHECKR_WEBHOOK_SECRET. A "clear" result here is what lets a Grade Angel
// start taking student work, so on a real deploy an unsigned request is
// always refused. Only local `netlify dev` may skip the check, so testing
// is not blocked on having the secret yet.
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const rawBody = await req.text();
  const secret = Netlify.env.get("CHECKR_WEBHOOK_SECRET");

  if (!secret && context.deploy?.context !== "dev") {
    return json({ error: "CHECKR_WEBHOOK_SECRET is not set, so this webhook cannot verify requests" }, 503);
  }

  if (secret) {
    const signature = req.headers.get("x-checkr-signature") || "";
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const valid =
      signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) return json({ error: "Invalid signature" }, 401);
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (event.type !== "report.completed") {
    // Acknowledge everything else so Checkr does not keep retrying it.
    return json({ ok: true }, 200);
  }

  const candidateId = event.data?.object?.candidate_id;
  const reportStatus = event.data?.object?.status as string | undefined;
  if (!candidateId || !reportStatus) return json({ ok: true }, 200);

  const status = reportStatus === "clear" ? "clear" : reportStatus === "consider" ? "consider" : "pending";

  await db.sql`
    UPDATE users SET background_check_status = ${status} WHERE checkr_candidate_id = ${candidateId}
  `;

  return json({ ok: true }, 200);
};

export const config: Config = {
  path: "/api/background-check/webhook",
};
