// Finish-date estimate for a campaign, using the same rules the sender follows:
// send days and window (in the settings time zone), the mailbox's daily limit (manual override,
// else today's limit and then the warm-up ramp), emails already sent today, the random gap
// between emails, and emails from other campaigns on the same mailbox that are queued ahead.
// It assumes no slowdowns or pauses from the daily health check.

export type EstimateInput = {
  remaining: number; // emails of this campaign still to send
  ahead: number; // emails of other active campaigns on the same mailbox that go first
  sendDays: number[]; // ISO weekdays 1..7
  sendStart: string; // "HH:MM[:SS]"
  sendEnd: string;
  timezone: string;
  mailbox: {
    warmup_start_date: string;
    current_daily_limit: number;
    daily_limit_override: number | null;
  };
  sentToday: number;
  settings: { warmup_schedule: number[]; max_daily_per_mailbox: number; min_gap_seconds: number; max_gap_seconds: number };
  now?: Date;
};

export type DayPlan = { date: string; dow: number; count: number };
export type Estimate = {
  finish: DayPlan | null; // null = more than a year away / nothing can be sent
  days: DayPlan[]; // only days this campaign sends on
  perDayLimit: number; // today's effective daily limit
  windowCap: number; // max emails that fit in one full send window
};

const DAY_MS = 86_400_000;

function localParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function toMinutes(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

function isoDow(date: string) {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

function addDays(date: string, n: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function rampLimit(date: string, inp: EstimateInput) {
  if (inp.mailbox.daily_limit_override !== null) return inp.mailbox.daily_limit_override;
  const week = Math.max(0, Math.floor((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${inp.mailbox.warmup_start_date}T12:00:00Z`)) / DAY_MS / 7));
  const s = inp.settings.warmup_schedule;
  return week < s.length ? Math.min(s[week], inp.settings.max_daily_per_mailbox) : inp.settings.max_daily_per_mailbox;
}

export function estimateFinish(inp: EstimateInput): Estimate {
  const now = inp.now ?? new Date();
  const { date: today, minutes: nowMin } = localParts(now, inp.timezone);
  const start = toMinutes(inp.sendStart);
  const end = toMinutes(inp.sendEnd);
  // One email per gap; the scheduler checks every 2 minutes, adding about a minute on average.
  const interval = (inp.settings.min_gap_seconds + inp.settings.max_gap_seconds) / 2 / 60 + 1;
  const windowCap = Math.max(0, Math.floor((end - start) / interval));
  const todayLimit = inp.mailbox.daily_limit_override ?? inp.mailbox.current_daily_limit;

  let ahead = inp.ahead;
  let left = inp.remaining;
  const days: DayPlan[] = [];
  if (left <= 0) return { finish: null, days, perDayLimit: todayLimit, windowCap };

  for (let i = 0; i < 366; i++) {
    const date = addDays(today, i);
    const dow = isoDow(date);
    if (!inp.sendDays.includes(dow)) continue;
    let cap: number;
    if (i === 0) {
      const minutesLeft = Math.max(0, end - Math.max(nowMin, start));
      cap = Math.min(Math.max(0, todayLimit - inp.sentToday), Math.floor(minutesLeft / interval));
    } else {
      cap = Math.min(rampLimit(date, inp), windowCap);
    }
    if (cap <= 0) continue;
    const forAhead = Math.min(ahead, cap);
    ahead -= forAhead;
    const mine = Math.min(left, cap - forAhead);
    left -= mine;
    if (mine > 0) days.push({ date, dow, count: mine });
    if (left === 0) return { finish: days[days.length - 1], days, perDayLimit: todayLimit, windowCap };
  }
  return { finish: null, days, perDayLimit: todayLimit, windowCap };
}

export function todayIn(tz: string) {
  return localParts(new Date(), tz).date;
}

export function formatDay(date: string, today: string) {
  const d = new Date(`${date}T12:00:00Z`);
  const t = today;
  if (date === t) return "today";
  if (date === addDays(t, 1)) return "tomorrow";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}
