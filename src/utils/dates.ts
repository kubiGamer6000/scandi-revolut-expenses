import { TZDate, tz } from "@date-fns/tz";
import {
  addDays,
  format,
  startOfDay,
  startOfWeek,
  subDays,
} from "date-fns";

/**
 * All period math is anchored to a single IANA time zone (`reportTz`) instead
 * of the host's system tz. This is what keeps "today's report" meaning the
 * same thing whether the script runs on a laptop in Bulgaria, a server in
 * Frankfurt, or a CI runner in us-east-1.
 *
 * `Period.from`/`Period.to` are real `Date` instants (UTC under the hood) — the
 * tz only matters for *interpreting wall-clock dates* like "today" or
 * "2026-05-05". Once we've turned a wall-clock date into an instant, the API
 * fetch and the in-memory filter work in raw UTC.
 */
export interface Period {
  /** Inclusive UTC instant. */
  from: Date;
  /** Exclusive UTC instant. */
  to: Date;
  label: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * European-style date input: `DD/MM/YYYY` (also `D/M/YYYY`, dashes or dots
 * as separators). We accept this on the CLI because the report displays
 * dates this way, so users can copy/paste between the two without thinking.
 */
const EU_DATE_RE = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/;

/** Today, 00:00 → tomorrow, 00:00 in `reportTz`. */
export function today(reportTz: string): Period {
  const now = nowInTz(reportTz);
  const start = startOfDay(now, { in: tz(reportTz) });
  const end = addDays(start, 1, { in: tz(reportTz) });
  return makePeriod(start, end, `Today (${fmtDay(start, reportTz)})`);
}

/** Yesterday, 00:00 → today, 00:00 in `reportTz`. */
export function yesterday(reportTz: string): Period {
  const now = nowInTz(reportTz);
  const todayStart = startOfDay(now, { in: tz(reportTz) });
  const start = subDays(todayStart, 1, { in: tz(reportTz) });
  return makePeriod(
    start,
    todayStart,
    `Yesterday (${fmtDay(start, reportTz)})`,
  );
}

/**
 * A single calendar day in `reportTz`. Accepts ISO `YYYY-MM-DD` or
 * European `DD/MM/YYYY` (and `DD.MM.YYYY` / `DD-MM-YYYY`).
 */
export function singleDay(dateInput: string, reportTz: string): Period {
  const start = parseInputDate(dateInput, reportTz, "on");
  const end = addDays(start, 1, { in: tz(reportTz) });
  return makePeriod(start, end, `Day (${fmtDay(start, reportTz)})`);
}

/**
 * Current week: Mon 00:00 in tz → tomorrow 00:00 in tz. Monday-start matches
 * how most EU finance teams (and Revolut Business itself) count weeks.
 */
export function thisWeek(reportTz: string): Period {
  const now = nowInTz(reportTz);
  const start = startOfWeek(now, { weekStartsOn: 1, in: tz(reportTz) });
  const end = addDays(startOfDay(now, { in: tz(reportTz) }), 1, {
    in: tz(reportTz),
  });
  return makePeriod(
    start,
    end,
    `This week (${fmtDay(start, reportTz)} → ${fmtDay(now, reportTz)})`,
  );
}

/** Previous full week (Mon 00:00 → Mon 00:00) in `reportTz`. */
export function lastWeek(reportTz: string): Period {
  const now = nowInTz(reportTz);
  const thisMonday = startOfWeek(now, {
    weekStartsOn: 1,
    in: tz(reportTz),
  });
  const lastMonday = subDays(thisMonday, 7, { in: tz(reportTz) });
  // For the label we want the inclusive Sunday — display only.
  const lastSunday = subDays(thisMonday, 1, { in: tz(reportTz) });
  return makePeriod(
    lastMonday,
    thisMonday,
    `Last week (${fmtDay(lastMonday, reportTz)} → ${fmtDay(lastSunday, reportTz)})`,
  );
}

/**
 * Custom range. Bare `YYYY-MM-DD` inputs are interpreted as midnight *in
 * reportTz* (not UTC, which is JS `new Date("YYYY-MM-DD")`'s default and the
 * source of half our timezone bugs). `--to` is inclusive end-of-day: passing
 * `--to 2026-05-06` includes all of May 6 in reportTz, ending at May 7 00:00.
 *
 * If you pass a full ISO timestamp (with `T` and offset/`Z`) it's used verbatim
 * as a precise UTC instant.
 */
export function customRange(
  fromIso: string,
  toIso: string | undefined,
  reportTz: string,
): Period {
  const from = parseInputDate(fromIso, reportTz, "from");
  const to = toIso
    ? parseInputDate(toIso, reportTz, "to", { exclusiveEndOfDay: true })
    : new Date();

  if (to.getTime() <= from.getTime()) {
    throw new Error(
      `--to (${toIso}) must be after --from (${fromIso}). ` +
        `Bare YYYY-MM-DD dates are interpreted in ${reportTz}, ` +
        `and --to is inclusive of that whole day.`,
    );
  }

  const labelFrom = fmtDay(from, reportTz);
  const labelTo = toIso
    ? fmtDay(new Date(to.getTime() - 1), reportTz)
    : fmtDay(to, reportTz);
  return { from, to, label: `${labelFrom} → ${labelTo}` };
}

/** Instant → ISO 8601 with `Z` suffix. Always UTC. */
export function toApiDate(d: Date): string {
  return d.toISOString();
}

/**
 * Format a UTC instant as `YYYY-MM-DD HH:mm:ss` in the given tz. Internal /
 * sortable; we keep this around for FX cache keys, Markdown sort, etc.
 */
export function formatTzTimestamp(d: Date, reportTz: string): string {
  return format(d, "yyyy-MM-dd HH:mm:ss", { in: tz(reportTz) });
}

/** Format a UTC instant as `YYYY-MM-DD` in the given tz (sortable). */
export function formatTzDate(d: Date, reportTz: string): string {
  return format(d, "yyyy-MM-dd", { in: tz(reportTz) });
}

/**
 * Format a UTC instant as `DD/MM/YYYY HH:mm:ss` in the given tz. This is what
 * the user sees in the Markdown / console / HTML reports — European day-first
 * order matches how the rest of the EU writes dates and how the Revolut UI
 * presents them.
 */
export function formatTzTimestampEu(d: Date, reportTz: string): string {
  return format(d, "dd/MM/yyyy HH:mm:ss", { in: tz(reportTz) });
}

/** Format a UTC instant as `DD/MM/YYYY` in the given tz. User-facing. */
export function formatTzDateEu(d: Date, reportTz: string): string {
  return format(d, "dd/MM/yyyy", { in: tz(reportTz) });
}

/**
 * Convert an ISO date string (`YYYY-MM-DD`, no tz semantics) to European
 * `DD/MM/YYYY`. Used when re-rendering values that are already stored in ISO
 * (e.g. `PreprocessedTx.date`) — no Date parsing or tz math needed.
 */
export function isoToEuDate(iso: string): string {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) return iso;
  const [y, mo, d] = iso.split("-");
  return `${d}/${mo}/${y}`;
}

// ---------- internals ----------

function nowInTz(reportTz: string): TZDate {
  return new TZDate(Date.now(), reportTz);
}

/**
 * `startOfDay` etc. with the `in` option return a `TZDate`. We coerce to a
 * plain `Date` (with the same UTC instant) at the boundary so downstream code
 * that does `.getTime()`, `.toISOString()`, etc. behaves identically regardless
 * of which path produced the value.
 */
function makePeriod(start: Date, end: Date, label: string): Period {
  return {
    from: new Date(start.getTime()),
    to: new Date(end.getTime()),
    label,
  };
}

/** Period labels are user-facing → European format. */
function fmtDay(d: Date, reportTz: string): string {
  return formatTzDateEu(d, reportTz);
}

function parseInputDate(
  raw: string,
  reportTz: string,
  which: "from" | "to" | "on",
  opts: { exclusiveEndOfDay?: boolean } = {},
): Date {
  const trimmed = raw.trim();

  // Try ISO first (YYYY-MM-DD).
  if (ISO_DATE_RE.test(trimmed)) {
    const [y, m, d] = trimmed.split("-").map(Number);
    return tzMidnightDate(y, m, d, reportTz, raw, which, opts);
  }

  // Try European (DD/MM/YYYY, with / . - separators).
  const eu = EU_DATE_RE.exec(trimmed);
  if (eu) {
    const d = Number(eu[1]);
    const m = Number(eu[2]);
    const y = Number(eu[3]);
    return tzMidnightDate(y, m, d, reportTz, raw, which, opts);
  }

  // Full ISO timestamp — let JS parse it as a precise instant.
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid --${which} date: ${raw}. ` +
        `Expected YYYY-MM-DD, DD/MM/YYYY, or full ISO 8601.`,
    );
  }
  return parsed;
}

function tzMidnightDate(
  y: number | undefined,
  m: number | undefined,
  d: number | undefined,
  reportTz: string,
  raw: string,
  which: "from" | "to" | "on",
  opts: { exclusiveEndOfDay?: boolean },
): Date {
  if (!y || !m || !d) {
    throw new Error(`Invalid --${which} date: ${raw}`);
  }
  // For --to YYYY-MM-DD, expand to next-day midnight so the whole day is
  // included. For --from / --on, midnight is the inclusive lower bound.
  const day = opts.exclusiveEndOfDay ? d + 1 : d;
  return new Date(new TZDate(y, m - 1, day, reportTz).getTime());
}
