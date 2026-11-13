import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { date, money } from '../format.js';

const LINES = [
  { key: 'purchases', label: 'Purchases', color: 'var(--chart-purchases)' },
  { key: 'revenue', label: 'Revenue', color: 'var(--chart-revenue)' },
];
const atUtc = (iso) => Date.parse(`${iso}T00:00:00Z`);
const shortDate = (t) => date(new Date(t).toISOString()).replace(/, \d{4}$/, '');
const DAY = 86400000;

function ChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="chart-tip">
      <b>{date(row.date)}</b>
      {LINES.filter((l) => row[`${l.key}Text`]).map((l) => (
        <div key={l.key}><i className="line-key" style={{ background: l.color }} /><b className="tip-value">{money(row[`${l.key}Text`])}</b> {l.label}</div>
      ))}
    </div>
  );
}

const Dot = ({ cx, cy, stroke, active }) =>
  cx == null || cy == null ? null : <circle cx={cx} cy={cy} r={active ? 6 : 4} fill={stroke} stroke="var(--paper)" strokeWidth={2} />;

/** The series' name beside its last point, so the lines don't rely on color. */
const endLabel = (index, text) => function EndLabel({ x, y, index: i }) {
  if (i !== index || x == null || y == null) return null;
  return <text x={x + 9} y={y + 4} fontSize={12} fill="var(--ink-2)">{text}</text>;
};

/** Each day's purchases on receipts and revenue from events, on one money axis, with the same days as a table. */
export default function DashboardChart({ days }) {
  if (!days.length) return <p className="muted">Purchases and revenue show here once there are receipts or event sales.</p>;
  // Number for plotting only; the tooltip and table show the exact amounts.
  const rows = days.map((d) => ({
    date: d.date,
    t: atUtc(d.date),
    purchases: d.purchases === null ? null : Number(d.purchases),
    revenue: d.revenue === null ? null : Number(d.revenue),
    purchasesText: d.purchases,
    revenueText: d.revenue,
  }));
  const first = rows[0].t;
  const last = rows.at(-1).t;
  const steps = 4;
  const ticks = first === last ? [first] : Array.from({ length: steps + 1 }, (_, i) => Math.round((first + ((last - first) * i) / steps) / DAY) * DAY);
  const lastOf = (key) => rows.findLastIndex((r) => r[key] !== null);
  return (
    <>
      <div className="legend" aria-hidden="true">
        {LINES.map((l) => <span key={l.key}><i className="line-key" style={{ background: l.color }} />{l.label}</span>)}
      </div>
      <div className="dash-chart" role="img" aria-label={`Purchases and revenue by day, ${date(rows[0].date)} to ${date(rows.at(-1).date)}. The same figures are in the table below.`}>
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 10, right: 72, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--line-soft)" vertical={false} />
            <XAxis dataKey="t" type="number" scale="time" domain={first === last ? [first - DAY, last + DAY] : [first, last]} ticks={ticks} tickFormatter={shortDate}
              tick={{ fontSize: 12, fill: 'var(--muted)' }} tickLine={false} axisLine={{ stroke: 'var(--line-soft)' }} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tickFormatter={(v) => `$${v}`} tick={{ fontSize: 12, fill: 'var(--muted)' }} tickLine={false} axisLine={false} width={52} domain={[0, 'auto']} />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--muted)' }} isAnimationActive={false} />
            {LINES.map((l) => (
              <Line key={l.key} type="linear" dataKey={l.key} name={l.label} stroke={l.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" connectNulls isAnimationActive={false}
                dot={<Dot />} activeDot={<Dot active />} label={endLabel(lastOf(l.key), l.label)} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details className="dash-table">
        <summary>Show as a table</summary>
        <div className="table-wrap">
          <table className="grid">
            <thead><tr><th>Day</th><th className="num">Purchases</th><th className="num">Revenue</th></tr></thead>
            <tbody>
              {rows.slice().reverse().map((r) => (
                <tr key={r.date}>
                  <td>{date(r.date)}</td>
                  <td className="num">{r.purchasesText ? money(r.purchasesText) : '—'}</td>
                  <td className="num">{r.revenueText ? money(r.revenueText) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
