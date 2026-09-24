import { db } from "./db.mts";
import { getStripe, StripeNotConfiguredError } from "./stripe.mts";
import { recordEvent } from "./assignments.mts";

// After this many failed tries the hourly job stops and the payout waits
// for an admin to look at it (POST /api/admin/payouts/retry).
export const MAX_PAYOUT_ATTEMPTS = 24;

// A payout stuck in 'processing' this long means the function died mid
// transfer. The retry job may pick it up again; the check for an existing
// transfer below makes sure the money still only goes out once.
export const STALE_PROCESSING_MINUTES = 30;

export type PayoutResult =
  | { status: "transferred"; note: string }
  | { status: "held"; note: string }
  | { status: "failed"; note: string }
  | { status: "skipped"; note: string };

// Sends the Grade Angel their share of a completed, paid assignment. Safe
// to call any number of times for the same assignment: it only ever pays
// once. Used when a teacher marks work complete, by the hourly retry job,
// and by the admin retry endpoint.
export async function attemptPayout(assignmentId: number): Promise<PayoutResult> {
  const [row] = await db.sql`
    SELECT a.status AS assignment_status, a.grade_angel_id,
           p.id AS payment_id, p.status AS payment_status, p.payout_status,
           p.amount_cents, p.platform_fee_cents, p.gift_cents, p.test_mode, p.stripe_charge_id, p.stripe_payment_intent_id,
           u.stripe_account_id, u.stripe_payouts_ready
    FROM assignments a
    JOIN LATERAL (
      SELECT * FROM payments WHERE assignment_id = a.id ORDER BY id DESC LIMIT 1
    ) p ON true
    LEFT JOIN users u ON u.id = a.grade_angel_id
    WHERE a.id = ${assignmentId}
  `;

  if (!row || row.payment_status !== "paid") return { status: "skipped", note: "This assignment has not been paid for." };
  if (row.assignment_status !== "completed") return { status: "skipped", note: "This assignment is not complete yet." };
  if (row.payout_status === "transferred") return { status: "transferred", note: "Payout already sent." };
  if (!row.grade_angel_id) return { status: "skipped", note: "No Grade Angel on this assignment." };

  // A test account's payment was never charged, so no money moves here
  // either. The payout is recorded as sent so the rest of the flow runs.
  if (row.test_mode) {
    const done = await db.sql`
      UPDATE payments
      SET payout_status = 'transferred', stripe_transfer_id = ${"test_transfer_" + row.payment_id},
          transferred_at = NOW(), payout_error = NULL
      WHERE id = ${row.payment_id} AND payout_status <> 'transferred'
      RETURNING id
    `;
    if (done.length) await recordEvent(assignmentId, null, "payout_sent", "Test mode, no money moved");
    return { status: "transferred", note: "Test mode: the payout is recorded as sent. No money moved." };
  }

  if (!row.stripe_account_id || !row.stripe_payouts_ready) {
    await db.sql`
      UPDATE payments SET payout_status = 'held', payout_error = 'Grade Angel payouts are not set up'
      WHERE id = ${row.payment_id} AND payout_status <> 'transferred'
    `;
    return {
      status: "held",
      note: "The Grade Angel has not finished setting up payouts. Their share is held and will send automatically once they do.",
    };
  }

  // Take the lock. Only one caller can move the payment into 'processing';
  // everyone else backs off. A stale lock can be taken over.
  const [claimed] = await db.sql`
    UPDATE payments
    SET payout_status = 'processing', payout_attempted_at = NOW(), payout_attempts = payout_attempts + 1
    WHERE id = ${row.payment_id}
      AND (payout_status IN ('not_started', 'held', 'failed')
           OR (payout_status = 'processing'
               AND payout_attempted_at < NOW() - make_interval(mins => ${STALE_PROCESSING_MINUTES})))
    RETURNING id, payout_attempts
  `;
  if (!claimed) return { status: "skipped", note: "A payout for this assignment is already being sent." };

  try {
    const stripe = getStripe();

    let chargeId = row.stripe_charge_id as string | null;
    if (!chargeId && row.stripe_payment_intent_id) {
      const intent = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id);
      const latest = intent.latest_charge;
      chargeId = typeof latest === "string" ? latest : latest?.id ?? null;
      if (chargeId) await db.sql`UPDATE payments SET stripe_charge_id = ${chargeId} WHERE id = ${row.payment_id}`;
    }

    // If an earlier attempt sent the transfer but died before recording it,
    // Stripe already has it. Record that one instead of sending another.
    const existing = await stripe.transfers.list({ transfer_group: `assignment_${assignmentId}`, limit: 10 });
    const already = existing.data.find((t) => t.metadata?.payment_id === String(row.payment_id) && !t.reversed);
    if (already) {
      await db.sql`
        UPDATE payments
        SET payout_status = 'transferred', stripe_transfer_id = ${already.id}, transferred_at = NOW(), payout_error = NULL
        WHERE id = ${row.payment_id}
      `;
      return { status: "transferred", note: "Payout sent to the Grade Angel." };
    }

    const transfer = await stripe.transfers.create(
      {
        amount: row.amount_cents - row.platform_fee_cents,
        currency: "usd",
        destination: row.stripe_account_id,
        transfer_group: `assignment_${assignmentId}`,
        // Ties the transfer to the teacher's charge, so it waits for those
        // funds to settle rather than failing on an empty balance. Only
        // possible when that charge covers the whole transfer; when gift
        // money paid for most of it, the transfer comes from the platform
        // balance, where the gifts were paid in.
        ...(chargeId && row.gift_cents <= row.platform_fee_cents ? { source_transaction: chargeId } : {}),
        metadata: { assignment_id: String(assignmentId), payment_id: String(row.payment_id) },
      },
      // One key per attempt: Stripe replays a key's first result for 24
      // hours, so reusing a key would replay an old error forever. A network
      // retry within this attempt still cannot send twice.
      { idempotencyKey: `payout-payment-${row.payment_id}-attempt-${claimed.payout_attempts}` }
    );

    await db.sql`
      UPDATE payments
      SET payout_status = 'transferred', stripe_transfer_id = ${transfer.id}, transferred_at = NOW(), payout_error = NULL
      WHERE id = ${row.payment_id}
    `;
    await recordEvent(assignmentId, null, "payout_sent");
    return { status: "transferred", note: "Payout sent to the Grade Angel." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.sql`
      UPDATE payments SET payout_status = 'failed', payout_error = ${message.slice(0, 500)}
      WHERE id = ${row.payment_id}
    `;
    return {
      status: "failed",
      note:
        err instanceof StripeNotConfiguredError
          ? err.message
          : "The payout could not be sent yet. It will be retried automatically.",
    };
  }
}

// Refreshes a Grade Angel's cached "can receive payouts" flag from Stripe.
// Returns the fresh value, or null if Stripe could not be reached.
export async function refreshPayoutsReady(userId: number, stripeAccountId: string): Promise<boolean | null> {
  try {
    const account = await getStripe().accounts.retrieve(stripeAccountId);
    const ready = account.capabilities?.transfers === "active" && Boolean(account.payouts_enabled);
    await db.sql`UPDATE users SET stripe_payouts_ready = ${ready} WHERE id = ${userId}`;
    return ready;
  } catch {
    return null;
  }
}
