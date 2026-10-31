import Papa from "papaparse";
import { isEmail } from "./format";

/**
 * Typed or pasted contacts: one per line, values separated by commas, semicolons or tabs (pasted from Excel).
 * Default column order is email, first name, last name, company. A header row is detected and used if present.
 */
export function parseTyped(text: string): { headers: string[]; rows: Record<string, string>[] } | null {
  const res = Papa.parse<string[]>(text.trim(), { header: false, skipEmptyLines: "greedy" });
  const lines = res.data.map((r) => r.map((v) => (v ?? "").trim()));
  if (!lines.length) return null;
  const width = Math.max(...lines.map((r) => r.length));
  const firstHasEmail = lines[0].some(isEmail);
  const hasHeader = !firstHasEmail && lines.slice(1).some((r) => r.some(isEmail));
  let headers: string[];
  let body = lines;
  if (hasHeader) {
    headers = lines[0].map((h, i) => h || `Column ${i + 1}`);
    body = lines.slice(1);
  } else {
    const defaults = ["Email", "First name", "Last name", "Company"];
    const emailFirst = lines.filter((r) => isEmail(r[0] ?? "")).length >= lines.length / 2;
    headers = Array.from({ length: width }, (_, i) => (emailFirst && defaults[i]) || `Column ${i + 1}`);
  }
  for (let i = headers.length; i < width; i++) headers.push(`Column ${i + 1}`);
  const seen = new Map<string, number>();
  headers = headers.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n > 1 ? `${h} ${n}` : h;
  });
  const rows = body.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
  return { headers, rows };
}
