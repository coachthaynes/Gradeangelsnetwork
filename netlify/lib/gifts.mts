import crypto from "node:crypto";
import { db } from "./db.mts";
import { emailConfigured, firstName, getSettings, renderEmail, sendEmail } from "./email.mts";
import { publicName } from "./profiles.mts";

// Gift Angels pay for grading so cost is not a barrier for teachers. A gift
// goes to one teacher's gift balance (through their gift link) or to the
// community fund, which staff grant out to teachers. Teachers spend their
// balance when they pay for an assignment. Every move is written to
// gift_ledger, and each one happens in a single SQL statement so money can
// never be counted twice or lost halfway.

export const MIN_GIFT_CENTS = 500;
export const MAX_GIFT_CENTS = 500000;

export function newGiftToken(): string {
  return crypto.randomBytes(12).toString("base64url");
}

export function formatDollars(cents: number): string {
  return "$" + (cents / 100).toFixed(2).replace(/\.00$/, "");
}

// Marks a gift paid and credits it, once. Returns the gift when this call
// did the crediting, or null if it was already credited (Stripe resends
// webhooks) or does not exist.
export async function creditPaidGift(giftId: number, paymentIntentId: string | null) {
  const [gift] = await db.sql`
    WITH g AS (
      UPDATE gifts SET status = 'paid', paid_at = NOW(),
             stripe_payment_intent_id = COALESCE(${paymentIntentId}, stripe_payment_intent_id)
      WHERE id = ${giftId} AND status = 'pending'
      RETURNING id, teacher_id, amount_cents, donor_name, donor_email, message, anonymous
    ),
    to_teacher AS (
      UPDATE users u SET gift_balance_cents = u.gift_balance_cents + g.amount_cents
      FROM g WHERE u.id = g.teacher_id
      RETURNING u.id
    ),
    to_fund AS (
      UPDATE gift_fund f SET balance_cents = f.balance_cents + g.amount_cents
      FROM g WHERE f.id = 1 AND g.teacher_id IS NULL
      RETURNING f.id
    ),
    ledger AS (
      INSERT INTO gift_ledger (teacher_id, amount_cents, kind, gift_id)
      SELECT teacher_id, amount_cents, 'gift', id FROM g
      RETURNING id
    )
    SELECT * FROM g
  `;
  return gift || null;
}

// Spends as much of a teacher's gift balance as is needed toward a pending
// payment. Returns the payment's gift total afterwards.
export async function applyGiftToPayment(paymentId: number, teacherId: number, totalCents: number): Promise<number> {
  await db.sql`
    WITH p AS (
      SELECT id, gift_cents FROM payments WHERE id = ${paymentId} AND status = 'pending' FOR UPDATE
    ),
    cur AS (
      SELECT u.id, LEAST(u.gift_balance_cents, ${totalCents} - p.gift_cents) AS take
      FROM users u, p WHERE u.id = ${teacherId}
      FOR UPDATE OF u
    ),
    debit AS (
      UPDATE users u SET gift_balance_cents = u.gift_balance_cents - cur.take
      FROM cur WHERE u.id = cur.id AND cur.take > 0
      RETURNING cur.take
    ),
    pay AS (
      UPDATE payments SET gift_cents = payments.gift_cents + debit.take
      FROM debit WHERE payments.id = ${paymentId}
      RETURNING payments.id
    ),
    ledger AS (
      INSERT INTO gift_ledger (teacher_id, amount_cents, kind, payment_id)
      SELECT ${teacherId}::int, -take, 'applied', ${paymentId}::int FROM debit
      RETURNING id
    )
    SELECT 1
  `;
  const [row] = await db.sql`SELECT gift_cents FROM payments WHERE id = ${paymentId}`;
  return row?.gift_cents ?? 0;
}

// Moves money from the community fund to a teacher. Returns false when the
// fund does not have that much.
export async function grantFromFund(teacherId: number, amountCents: number, staffId: number, note: string | null): Promise<boolean> {
  const rows = await db.sql`
    WITH f AS (
      UPDATE gift_fund SET balance_cents = balance_cents - ${amountCents}
      WHERE id = 1 AND balance_cents >= ${amountCents}
      RETURNING id
    ),
    t AS (
      UPDATE users SET gift_balance_cents = gift_balance_cents + ${amountCents}
      FROM f WHERE users.id = ${teacherId}
      RETURNING users.id
    ),
    ledger AS (
      INSERT INTO gift_ledger (teacher_id, amount_cents, kind, staff_id, note)
      SELECT NULL::int, ${-amountCents}::int, 'grant', ${staffId}::int, ${note}::text FROM f
      UNION ALL
      SELECT ${teacherId}::int, ${amountCents}::int, 'grant', ${staffId}::int, ${note}::text FROM f
      RETURNING id
    )
    SELECT id FROM f
  `;
  return rows.length > 0;
}

// The name a teacher sees for a supporter.
export function donorLabel(g: { anonymous: boolean; donor_name: string }): string {
  return g.anonymous ? "A Gift Angel who chose to stay anonymous" : g.donor_name;
}

// A thank you to the supporter and a note to the teacher. Never throws:
// the gift is already counted whether or not these go out.
export async function sendGiftEmails(gift: any) {
  if (!emailConfigured()) return;
  try {
    const settings = await getSettings();
    const fromName = settings.email_from_name || "The Grade Angels Team";
    const [teacher] = gift.teacher_id
      ? await db.sql`SELECT id, email, role, full_name, display_name FROM users WHERE id = ${gift.teacher_id}`
      : [];
    const amount = formatDollars(gift.amount_cents);
    const goesTo = teacher ? publicName(teacher) : "teachers who need it most";

    const thanks = renderEmail({
      subject: "Thank you for being a Gift Angel",
      body:
        `Hi {{first_name}},\n\nThank you. Your gift of **${amount}** will pay for grading for ${goesTo}, ` +
        `so a teacher gets an evening back without paying for it themselves.\n\n` +
        `Grade Angels Network is a for profit company, so this gift is not tax deductible. ` +
        `Your card statement and Stripe receipt are your record of it.`,
      vars: { first_name: firstName(gift.donor_name) },
      mailingAddress: settings.email_mailing_address || "",
      fromName,
    });
    await sendEmail({ to: gift.donor_email, ...thanks, replyTo: settings.email_reply_to, fromName }).catch((err) =>
      console.error("gift thank you email failed", err)
    );

    if (teacher) {
      const who = gift.anonymous ? "Someone who chose to stay anonymous" : gift.donor_name;
      const note = renderEmail({
        subject: `A Gift Angel sent you ${amount} for grading`,
        body:
          `Hi {{first_name}},\n\n${who} just sent you **${amount}** for grading help. ` +
          `It is in your gift balance now and is used automatically the next time you pay for an assignment.` +
          (gift.message ? `\n\nTheir message:\n${gift.message}` : ""),
        ctaLabel: "See your gifts",
        ctaPath: "/dashboard-teacher.html#gifts",
        vars: { first_name: firstName(teacher.full_name) },
        mailingAddress: settings.email_mailing_address || "",
        fromName,
      });
      await sendEmail({ to: teacher.email, ...note, replyTo: settings.email_reply_to, fromName }).catch((err) =>
        console.error("gift notice email failed", err)
      );
    }
  } catch (err) {
    console.error("gift emails failed", err);
  }
}

// Puts gift money back in the teacher's balance when an assignment is
// cancelled: from a payment that was never finished, or from one gift money
// paid for in full (no card charge to refund) whose Grade Angel was not paid.
// Returns how much went back.
export async function returnGiftForAssignment(assignmentId: number): Promise<number> {
  const [row] = await db.sql`
    WITH p AS (
      SELECT p.id, p.gift_cents, a.teacher_id
      FROM payments p JOIN assignments a ON a.id = p.assignment_id
      WHERE p.assignment_id = ${assignmentId} AND p.gift_cents > 0
        AND (p.status = 'pending'
             OR (p.status = 'paid' AND p.gift_cents >= p.amount_cents AND p.payout_status NOT IN ('transferred', 'processing')))
      FOR UPDATE OF p
    ),
    z AS (
      UPDATE payments SET gift_cents = 0,
             status = CASE WHEN payments.status = 'paid' THEN 'refunded' ELSE payments.status END
      FROM p WHERE payments.id = p.id
      RETURNING p.id, p.gift_cents, p.teacher_id
    ),
    credit AS (
      UPDATE users u SET gift_balance_cents = u.gift_balance_cents + s.total
      FROM (SELECT teacher_id, SUM(gift_cents)::int AS total FROM z GROUP BY teacher_id) s
      WHERE u.id = s.teacher_id
      RETURNING u.id
    ),
    ledger AS (
      INSERT INTO gift_ledger (teacher_id, amount_cents, kind, payment_id, note)
      SELECT teacher_id, gift_cents, 'applied', id, 'Returned when the assignment was cancelled' FROM z
      RETURNING id
    )
    SELECT COALESCE(SUM(gift_cents), 0)::int AS returned FROM z
  `;
  return row?.returned ?? 0;
}
