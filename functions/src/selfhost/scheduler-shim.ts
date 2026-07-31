/**
 * Drop-in for `firebase-functions/v2/scheduler`. `onSchedule()` returns an
 * object carrying `__selfhostSchedule` (schedule string + opts) and `.run()`
 * to invoke the handler — the same marker convention as https-shim, so the
 * cron host (work item 4) can walk the index.ts barrel and register
 * node-cron jobs exactly like the HTTP host mounts callables.
 *
 * Until the cron host exists this is a boot shim: importing the 12
 * scheduled-function modules must not explode, and tests can `.run()` a
 * schedule directly.
 */

export interface ScheduledEvent {
  jobName?: string;
  scheduleTime: string;
}

type ScheduleHandler = (event: ScheduledEvent) => void | Promise<void>;

interface ScheduleOptions {
  schedule: string;
  region?: string;
  memory?: string;
  timeoutSeconds?: number;
  [key: string]: unknown;
}

export interface ScheduleFunction {
  run(event?: Partial<ScheduledEvent>): Promise<void>;
  __selfhostSchedule: { schedule: string; opts: Record<string, unknown> };
}

export function onSchedule(
  scheduleOrOpts: string | ScheduleOptions,
  handler: ScheduleHandler,
): ScheduleFunction {
  const opts: ScheduleOptions =
    typeof scheduleOrOpts === "string" ? { schedule: scheduleOrOpts } : scheduleOrOpts;

  return {
    run: async (event?: Partial<ScheduledEvent>) => {
      await handler({
        scheduleTime: event?.scheduleTime ?? new Date().toISOString(),
        jobName: event?.jobName,
      });
    },
    __selfhostSchedule: { schedule: opts.schedule, opts },
  };
}
