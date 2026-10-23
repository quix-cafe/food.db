import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { date, perUnit } from '../format.js';
import { OTHER, SERIES } from '../palette.js';

function ChartTooltip({ active, payload, unit }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="chart-tip">
      <b>{date(p.date)}</b>
      <div><span style={{ color: p.color }}>●</span> {perUnit(p.raw, unit)}</div>
      <div className="muted">{p.vendor}{p.lines > 1 ? ` · average of ${p.lines} lines` : ''}</div>
    </div>
  );
}

const VendorDot = ({ cx, cy, payload, active }) =>
  cx == null ? null : <circle cx={cx} cy={cy} r={active ? 6 : 4} fill={payload.color} stroke="var(--paper)" strokeWidth={2} />;

/**
 * Price per unit of measure over time: one line through every trip (a receipt's lines of the
 * ingredient, averaged), so a move between stores or pack sizes shows as price movement but
 * two packs of different weights on one receipt don't. Points are colored by vendor.
 */
export default function PriceChart({ purchases, uom }) {
  const unit = uom ?? 'unit';
  const { rows, vendors } = useMemo(() => {
    const chosen = purchases.slice().reverse(); // oldest first
    const vendorOrder = [];
    const rows = chosen.map((p, i) => {
      const vendor = p.vendor ?? 'Unknown vendor';
      if (!vendorOrder.includes(vendor)) vendorOrder.push(vendor);
      const color = SERIES[vendorOrder.indexOf(vendor)] ?? OTHER;
      // `i` keeps two purchases on the same day as separate points.
      return { i, date: p.date, vendor, color, lines: p.lines, cost: Number(p.unitPrice), raw: p.unitPrice }; // Number for plotting only
    });
    return { rows, vendors: vendorOrder };
  }, [purchases]);

  if (!purchases.length) return <p className="muted">No purchases recorded yet.</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {vendors.length > 1 ? (
          <div className="legend" aria-label="Vendors">
            {vendors.map((v, i) => <span key={v}><i style={{ background: SERIES[i] ?? OTHER }} />{v}</span>)}
          </div>
        ) : <span className="muted">Price per {unit}{vendors[0] ? ` from ${vendors[0]}` : ''}</span>}
      </div>
      <div className="chart-box">
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--line-soft)" vertical={false} />
            <XAxis dataKey="i" tickFormatter={(i) => (rows[i] ? date(rows[i].date).replace(/, \d{4}$/, '') : '')} tick={{ fontSize: 12, fill: 'var(--muted)' }} tickLine={false} axisLine={{ stroke: 'var(--line)' }} minTickGap={24} />
            <YAxis tickFormatter={(v) => `$${v}`} tick={{ fontSize: 12, fill: 'var(--muted)' }} tickLine={false} axisLine={false} width={56} domain={['auto', 'auto']} />
            <Tooltip content={<ChartTooltip unit={unit} />} cursor={{ stroke: 'var(--muted)', strokeDasharray: '3 3' }} />
            <Line type="linear" dataKey="cost" stroke={vendors.length > 1 ? OTHER : SERIES[0]} strokeWidth={2} isAnimationActive={false}
              dot={<VendorDot />} activeDot={<VendorDot active />} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
