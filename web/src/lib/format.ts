export function pct(n: number, d: number): string {
  if (!d) return "–";
  const v = (100 * n) / d;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}

export function dateTime(s: string | null | undefined): string {
  if (!s) return "–";
  return new Date(s).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function date(s: string | null | undefined): string {
  if (!s) return "–";
  return new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function ago(s: string | null | undefined): string {
  if (!s) return "never";
  const min = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function warmupWeek(start: string): number {
  const days = Math.floor((Date.now() - new Date(start).getTime()) / 86400000);
  return Math.max(0, Math.floor(days / 7)) + 1;
}

export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function isEmail(s: string): boolean {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/.test(s.trim());
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
