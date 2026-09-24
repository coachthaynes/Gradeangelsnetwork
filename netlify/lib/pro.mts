import { db } from "./db.mts";

// Grade Angel Pro: optional, $10 a month after a 7 day free trial. Pro
// Grade Angels keep 90% of each assignment instead of 80%, see new open
// work before everyone else, and show a Pro badge. The monthly price comes
// out of their payouts, only in months they are paid, so no card is needed
// and no one is charged in a month they earn nothing.
export const PRO_PRICE_CENTS = 1000;
export const PRO_TRIAL_DAYS = 7;
export const PRO_PLATFORM_FEE_RATE = 0.1;
// How long new open work is shown only to Pro Grade Angels.
export const PRO_FIRST_LOOK_MINUTES = 60;

export function proState(u: { pro_started_at?: any; pro_ended_at?: any; pro_trial_ends_at?: any }) {
  const active = Boolean(u.pro_started_at) && !u.pro_ended_at;
  const trialEnds = u.pro_trial_ends_at ? new Date(u.pro_trial_ends_at) : null;
  return {
    active,
    in_trial: active && Boolean(trialEnds && trialEnds > new Date()),
    trial_ends_at: u.pro_trial_ends_at || null,
    started_at: u.pro_started_at || null,
  };
}

// Whether this Grade Angel waits out the Pro first look on new work. No one
// waits while there are no Pro members, so teachers never wait for nothing.
export async function waitsForFirstLook(userId: number): Promise<boolean> {
  if (await isProActive(userId)) return false;
  const [any] = await db.sql`
    SELECT 1 FROM users WHERE role = 'grade_angel' AND pro_started_at IS NOT NULL AND pro_ended_at IS NULL
      AND suspended_at IS NULL LIMIT 1
  `;
  return Boolean(any);
}

export async function isProActive(userId: number | null): Promise<boolean> {
  if (!userId) return false;
  const [u] = await db.sql`SELECT pro_started_at, pro_ended_at FROM users WHERE id = ${userId}`;
  return Boolean(u?.pro_started_at && !u.pro_ended_at);
}

export function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

// How much of this month's Pro price to take from a payout of
// `availableCents`: nothing during the free trial or once this month is
// paid, otherwise whatever is still owed for the month (up to the payout).
export async function proDeductionFor(userId: number, availableCents: number): Promise<number> {
  const [u] = await db.sql`SELECT pro_started_at, pro_ended_at, pro_trial_ends_at FROM users WHERE id = ${userId}`;
  const s = proState(u || {});
  if (!s.active || s.in_trial || availableCents <= 0) return 0;
  const [paid] = await db.sql`
    SELECT COALESCE(SUM(amount_cents), 0)::int AS cents FROM pro_charges WHERE user_id = ${userId} AND month = ${monthKey()}
  `;
  return Math.max(0, Math.min(PRO_PRICE_CENTS - paid.cents, availableCents));
}

export async function recordProCharge(userId: number, cents: number, paymentId: number, testMode: boolean) {
  if (cents <= 0) return;
  await db.sql`
    INSERT INTO pro_charges (user_id, month, amount_cents, payment_id, test_mode)
    VALUES (${userId}, ${monthKey()}, ${cents}, ${paymentId}, ${testMode})
  `;
}
