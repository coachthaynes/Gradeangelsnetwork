import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { signToken } from "../lib/auth.mts";

function page(title: string, text: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}, Grade Angels Network</title><link rel="stylesheet" href="/css/app.css"></head>
<body><nav class="nav"><a class="brand" href="/"><span class="mark">GA</span>Grade Angels Network</a></nav>
<main class="wrap narrow"><div class="card accent"><h1>${title}</h1><p>${text}</p><a class="btn" href="/">Go to the homepage</a></div></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

// The unsubscribe link in every marketing email. The link is signed, so
// nobody can unsubscribe someone else by guessing.
export default async (req: Request) => {
  const url = new URL(req.url);
  const r = url.searchParams.get("r") || "";
  const t = url.searchParams.get("t") || "";
  if (!r || t !== signToken("unsubscribe:" + r)) {
    return page("Link not recognized", "This unsubscribe link is not valid. Reply to any of our emails and we will remove you by hand.", 400);
  }
  const [kind, idText] = r.split(":");
  const id = Number(idText);
  if (kind === "user") await db.sql`UPDATE users SET email_opt_out_at = COALESCE(email_opt_out_at, NOW()) WHERE id = ${id}`;
  else if (kind === "lead") await db.sql`UPDATE leads SET unsubscribed_at = COALESCE(unsubscribed_at, NOW()) WHERE id = ${id}`;
  return page("You are unsubscribed", "You will not get any more marketing emails from Grade Angels Network. Emails about your own assignments and account still arrive when needed.");
};

export const config: Config = {
  path: "/api/email/unsubscribe",
};
