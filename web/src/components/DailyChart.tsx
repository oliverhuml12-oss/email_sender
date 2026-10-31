import { useState } from "react";
import type { DailyRow } from "../lib/supabase";

// Daily volume as bars, with replies and bounces as small marks on the same scale.
export default function DailyChart({ rows }: { rows: DailyRow[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 760, H = 220, left = 36, right = 12, top = 12, bottom = 28;
  const max = Math.max(5, ...rows.map((r) => r.sent));
  const step = niceStep(max);
  const yMax = Math.ceil(max / step) * step;
  const plotW = W - left - right, plotH = H - top - bottom;
  const bw = plotW / Math.max(rows.length, 1);
  const y = (v: number) => top + plotH - (v / yMax) * plotH;
  const ticks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step);
  const h = hover !== null ? rows[hover] : null;

  return (
    <div className="chart">
      <div className="chart-legend">
        <span><i className="sw sw-sent" /> Sent</span>
        <span><i className="sw sw-reply" /> Replies</span>
        <span><i className="sw sw-bounce" /> Bounces</span>
        {h && (
          <span className="chart-readout">
            {fmtDay(h.day)}: <b>{h.sent}</b> sent · <b>{h.replies}</b> replies · <b>{h.bounces}</b> bounces
            {h.clicks ? <> · <b>{h.clicks}</b> clicks</> : null}
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Emails sent, replies and bounces per day" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={W - right} y1={y(t)} y2={y(t)} className="grid" />
            <text x={left - 6} y={y(t) + 4} textAnchor="end" className="axis">{t}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = left + i * bw;
          const inner = Math.max(2, bw * 0.62);
          const cx = x + bw / 2;
          return (
            <g key={r.day} onMouseEnter={() => setHover(i)}>
              <rect x={x} y={top} width={bw} height={plotH} fill="transparent" />
              {hover === i && <rect x={x} y={top} width={bw} height={plotH} className="hover-band" />}
              <rect x={cx - inner / 2} y={y(r.sent)} width={inner} height={plotH - (y(r.sent) - top)} rx={2} className="bar-sent" />
              {r.replies > 0 && <circle cx={cx} cy={y(r.replies)} r={3.5} className="dot-reply" />}
              {r.bounces > 0 && <rect x={cx - 3.5} y={y(r.bounces) - 3.5} width={7} height={7} className="dot-bounce" transform={`rotate(45 ${cx} ${y(r.bounces)})`} />}
              {showLabel(i, rows.length) && (
                <text x={cx} y={H - 8} textAnchor="middle" className="axis">{fmtDay(r.day)}</text>
              )}
            </g>
          );
        })}
        <line x1={left} x2={W - right} y1={top + plotH} y2={top + plotH} className="baseline" />
      </svg>
    </div>
  );
}

function showLabel(i: number, n: number) {
  const k = Math.ceil(n / 8);
  return i === n - 1 || (i % k === 0 && n - 1 - i >= k * 0.75);
}

function niceStep(max: number) {
  const raw = max / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function fmtDay(d: string) {
  return new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
