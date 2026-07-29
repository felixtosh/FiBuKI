/**
 * The fibuki-api cron host (work item 4): walks the index.ts barrel for
 * exports the scheduler-shim marked with `__selfhostSchedule` and registers
 * a node-cron job per schedule — the scheduled twin of what host.ts does
 * for callables.
 *
 * Firebase accepts two schedule syntaxes; node-cron only takes cron
 * expressions, so App-Engine-style strings ("every 5 minutes",
 * "every monday 03:00") are translated. Unknown syntax throws at boot —
 * a schedule that silently never fires is the worst failure mode here,
 * the 5-minute queue drains are load-bearing.
 *
 * Semantics matched to Cloud Scheduler:
 * - default timezone UTC (node-cron would default to host-local time);
 *   a per-function `timeZone` option wins.
 * - a crashing handler is logged, never fatal, and never stops the job.
 * - `noOverlap`: a drain still running when the next tick fires skips that
 *   tick (Cloud Scheduler can overlap, but every drain here is a
 *   status-flag queue walker — overlap is never desirable).
 */

import { createTask, validate, type ScheduledTask } from "node-cron";
import type { ScheduleFunction } from "./scheduler-shim";
import { EXCLUDED_EXPORTS } from "./manifest";

export interface CreateCronHostOptions {
  /** Barrel exports NOT to register. Defaults to manifest EXCLUDED_EXPORTS. */
  exclude?: ReadonlySet<string>;
  log?: (message: string) => void;
}

export interface CronJob {
  name: string;
  /** The schedule string as written upstream. */
  schedule: string;
  /** The translated cron expression node-cron runs. */
  cron: string;
  timezone: string;
  task: ScheduledTask;
  /** Run the handler now (what a cron tick runs, error-logged not thrown). */
  trigger: () => Promise<void>;
}

const DAY_TO_CRON: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * Translate a Firebase `onSchedule` schedule string to a cron expression.
 * Accepts cron passthrough plus the App Engine forms used in this codebase:
 * "every N minutes", "every N hours", "every day HH:MM", "every monday HH:MM".
 */
export function translateSchedule(schedule: string): string {
  const s = schedule.trim().toLowerCase();

  const everyUnit = s.match(/^every (\d+) (minutes?|hours?)$/);
  if (everyUnit) {
    const n = Number(everyUnit[1]);
    if (everyUnit[2].startsWith("minute")) {
      if (n === 60) return `0 * * * *`;
      if (n < 1 || n > 59) throw new Error(`cron host: unsupported minute interval '${schedule}'`);
      return `*/${n} * * * *`;
    }
    if (n === 24) return `0 0 * * *`;
    if (n < 1 || n > 23) throw new Error(`cron host: unsupported hour interval '${schedule}'`);
    return `0 */${n} * * *`;
  }

  const everyAt = s.match(/^every (day|sunday|monday|tuesday|wednesday|thursday|friday|saturday) (\d{1,2}):(\d{2})$/);
  if (everyAt) {
    const dow = everyAt[1] === "day" ? "*" : String(DAY_TO_CRON[everyAt[1]]);
    const hour = Number(everyAt[2]);
    const minute = Number(everyAt[3]);
    if (hour > 23 || minute > 59) throw new Error(`cron host: invalid time in schedule '${schedule}'`);
    return `${minute} ${hour} * * ${dow}`;
  }

  if (validate(s)) return s;

  throw new Error(`cron host: cannot translate schedule '${schedule}'`);
}

function isScheduled(v: unknown): v is ScheduleFunction {
  return typeof v === "object" && v !== null && "__selfhostSchedule" in v;
}

export function createCronHost(
  barrel: Record<string, unknown>,
  options: CreateCronHostOptions = {},
): { jobs: CronJob[]; start: () => void; stop: () => Promise<void> } {
  const exclude = options.exclude ?? EXCLUDED_EXPORTS;
  const log = options.log ?? (() => undefined);
  const jobs: CronJob[] = [];

  for (const [name, value] of Object.entries(barrel)) {
    if (!isScheduled(value) || exclude.has(name)) continue;

    const { schedule, opts } = value.__selfhostSchedule;
    const cron = translateSchedule(schedule);
    const timezone = typeof opts.timeZone === "string" ? opts.timeZone : "Etc/UTC";

    const trigger = async () => {
      try {
        await value.run({ jobName: name, scheduleTime: new Date().toISOString() });
      } catch (err) {
        log(`cron job ${name} crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    };

    const task = createTask(cron, trigger, { name, timezone, noOverlap: true });
    jobs.push({ name, schedule, cron, timezone, task, trigger });
  }

  return {
    jobs,
    start: () => {
      for (const job of jobs) void job.task.start();
    },
    stop: async () => {
      await Promise.all(jobs.map((job) => job.task.destroy()));
    },
  };
}
