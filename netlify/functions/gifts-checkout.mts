import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { getStripe, StripeNotConfiguredError } from "../lib/stripe.mts";
import { ensureHandle, findGiftTeacher, formatDollars, MAX_GIFT_CENTS, MIN_GIFT_CENTS } from "../lib/gifts.mts";
import { publicName } from "../lib/profiles.mts";

const clip = (v: unknown, n: number) => (v ? String(v).trim().slice(0, n) : "");

// A supporter starts a gift. No account needed: the gift is saved as
// pending and they pay on a Stripe hosted page. It only counts once the
// Stripe webhook says the payment went through.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);
  const body = await readJson(req);
  if (!body) return json({ error: "Body must be JSON" }, 400);
  // A hidden field real people never fill in; bots usually do.
  if (body.website) return json({ error: "Could not start this gift" }, 400);

  const amountCents = Math.round(Number(body.amount_cents));
  if (!Number.isInteger(amountCents) || amountCents < MIN_GIFT_CENTS || amountCents > MAX_GIFT_CENTS) {
    return json({ error: `Gifts can be from ${formatDollars(MIN_GIFT_CENTS)} to ${formatDollars(MAX_GIFT_CENTS)}` }, 400);
  }
  const name = clip(body.name, 80);
  if (!name) return json({ error: "Enter your name" }, 400);
  const email = clip(body.email, 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Enter a valid email address" }, 400);
  const message = clip(body.message, 500) || null;
  const anonymous = Boolean(body.anonymous);

  let teacher: any = null;
  if (body.t || body.to) {
    teacher = await findGiftTeacher({ token: body.t, handle: body.to });
    if (!teacher) return json({ error: "We could not find that teacher. Check their @username." }, 404);
    if (!teacher.handle) teacher.handle = await ensureHandle(teacher.id);
  }

  let stripe;
  try {
    stripe = getStripe();
  } catch (err) {
    if (err instanceof StripeNotConfiguredError) {
      return json({ error: "Gifts open as soon as card payments are connected. Please check back soon." }, 501);
    }
    throw err;
  }

  const [gift] = await db.sql`
    INSERT INTO gifts (teacher_id, amount_cents, donor_name, donor_email, message, anonymous, source)
    VALUES (${teacher?.id ?? null}, ${amountCents}, ${name}, ${email}, ${message}, ${anonymous}, ${clip(body.source, 80) || null})
    RETURNING id
  `;

  // Stripe sends the supporter back to the page they gave from.
  const origin = new URL(req.url).origin;
  const back = `${origin}/give.html${teacher ? `?to=${encodeURIComponent(teacher.handle || "")}&` : "?"}`;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      submit_type: "donate",
      customer_email: email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: teacher ? `Grading gift for ${publicName(teacher)}` : "Grading gift for teachers",
              description: "Grade Angels Network is a for profit company. This gift is not tax deductible.",
            },
          },
        },
      ],
      success_url: `${back}thanks=1`,
      cancel_url: back.replace(/[?&]$/, ""),
      metadata: { kind: "gift", gift_id: String(gift.id) },
    });
    await db.sql`UPDATE gifts SET stripe_checkout_session_id = ${session.id} WHERE id = ${gift.id}`;
    return json({ url: session.url }, 200);
  } catch {
    return json({ error: "Could not start the payment. Please try again." }, 502);
  }
};

export const config: Config = {
  path: "/api/gifts/checkout",
};
