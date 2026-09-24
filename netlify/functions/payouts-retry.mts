import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { MAX_PAYOUT_ATTEMPTS, STALE_PROCESSING_MINUTES, attemptPayout, refreshPayoutsReady } from "../lib/payouts.mts";

// Runs every hour. Finds completed, paid assignments whose Grade Angel has
// not been paid yet and tries again:
//   held    re-checks the Grade Angel's Stripe account first, and sends the
//           payout as soon as they have finished setting it up
//   failed  retried up to MAX_PAYOUT_ATTEMPTS times, then left for an admin
//   stuck   a transfer interrupted mid way is picked up again
export default async () => {
  const due = await db.sql`
    SELECT a.id AS assignment_id, p.payout_status, u.id AS grade_angel_id, u.stripe_account_id,
           u.stripe_payouts_ready
    FROM assignments a
    JOIN LATERAL (
      SELECT * FROM payments WHERE assignment_id = a.id ORDER BY id DESC LIMIT 1
    ) p ON true
    JOIN users u ON u.id = a.grade_angel_id
    WHERE a.status = 'completed'
      AND p.status = 'paid'
      AND (
        p.payout_status IN ('not_started', 'held')
        OR (p.payout_status = 'failed' AND p.payout_attempts < ${MAX_PAYOUT_ATTEMPTS})
        OR (p.payout_status = 'processing'
            AND p.payout_attempted_at < NOW() - make_interval(mins => ${STALE_PROCESSING_MINUTES}))
      )
    ORDER BY a.completed_at ASC
    LIMIT 100
  `;

  const results: Record<string, number> = {};
  const refreshed = new Set<number>();
  for (const row of due) {
    // A held payout usually means the Grade Angel finished Stripe setup
    // but never came back to the site to refresh their status.
    if (!row.stripe_payouts_ready && row.stripe_account_id && !refreshed.has(row.grade_angel_id)) {
      refreshed.add(row.grade_angel_id);
      await refreshPayoutsReady(row.grade_angel_id, row.stripe_account_id);
    }
    const result = await attemptPayout(row.assignment_id);
    results[result.status] = (results[result.status] || 0) + 1;
  }

  console.log(`payouts-retry: checked ${due.length}`, JSON.stringify(results));
};

export const config: Config = {
  schedule: "@hourly",
};
