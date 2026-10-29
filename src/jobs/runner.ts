import { logger } from "../lib/logger.js";
import { expireReservations } from "./reservation-expiry.js";
import { recoverStuckPayments } from "./stuck-payments.js";
import { cleanupOldRecords } from "./cleanup.js";

// ─── A tiny periodic job runner ──────────────────────────────────────
//
// Each job runs in a loop: run → sleep(interval) → run ... A failing run is
// logged and retried next interval; it never crashes the worker process.
//
// "Isn't running the same job in EVERY worker process a problem?"
// Not here: every job is written to be safe when run concurrently
// (FOR UPDATE SKIP LOCKED + conditional updates + idempotent deletes).
// Two workers simply split the work. The alternative, making sure only one
// instance runs a job, needs leader election or a Postgres advisory lock
// (pg_try_advisory_lock). That's worth it for jobs that CAN'T be made safe
// to run concurrently.
//
// Why not cron / setInterval? setInterval doesn't wait for the previous run
// to finish, so slow runs pile up on top of each other. A loop never overlaps.

export interface JobHandle {
  stop(): Promise<void>;
}

export function startJob(
  name: string,
  intervalMs: number,
  run: () => Promise<unknown>,
): JobHandle {
  const log = logger.child({ job: name });
  let running = true;
  let wake: (() => void) | null = null;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const done = (async () => {
    log.info({ intervalMs }, "Job started");
    while (running) {
      try {
        await run();
      } catch (err) {
        log.error({ err }, "Job run failed; will retry next interval");
      }
      if (running) await sleep(intervalMs);
    }
    log.info("Job stopped");
  })();

  return {
    async stop() {
      running = false;
      wake?.();
      await done;
    },
  };
}

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

/** All maintenance jobs, started by the worker process. */
export function startMaintenanceJobs(): JobHandle[] {
  return [
    startJob("reservation-expiry", env("RESERVATION_EXPIRY_INTERVAL_MS", 30_000), () =>
      expireReservations(),
    ),
    startJob("stuck-payment-recovery", env("STUCK_PAYMENT_INTERVAL_MS", 60_000), () =>
      recoverStuckPayments(),
    ),
    startJob("cleanup", env("CLEANUP_INTERVAL_MS", 60 * 60_000), () => cleanupOldRecords()),
  ];
}
