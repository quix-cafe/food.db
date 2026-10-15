import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { date, perUnit } from '../format.js';

// Categorical slots in fixed order; a vendor keeps its slot by first appearance.
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const OTHER = '#8a969c';

function ChartTooltip({ active, payload, unit }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="chart-tip">
      <b>{date(p.date)}</b>
      <div><span style={{ color: p.color }}>●</span> {perUnit(p.raw, unit)}</div>
      <div className="muted">{p.vendor}</div>
    </div>
  );
}

const VendorDot = ({ cx, cy, payload, active }) =>
  cx == null ? null : <circle cx={cx} cy={cy} r={active ? 6 : 4} fill={payload.color} stroke="#fff" strokeWidth={2} />;

/**
 * Price per unit of measure over time: one line through every purchase, so a move between
 * stores or pack sizes shows as price movement. Points are colored by vendor.
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
      return { i, date: p.date, vendor, color, cost: Number(p.unitPrice), raw: p.unitPrice }; // Number for plotting only
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
            <CartesianGrid stroke="#e3e8ea" vertical={false} />
            <XAxis dataKey="i" tickFormatter={(i) => (rows[i] ? date(rows[i].date).replace(/, \d{4}$/, '') : '')} tick={{ fontSize: 12, fill: '#6f7d85' }} tickLine={false} axisLine={{ stroke: '#ccd4d8' }} minTickGap={24} />
            <YAxis tickFormatter={(v) => `$${v}`} tick={{ fontSize: 12, fill: '#6f7d85' }} tickLine={false} axisLine={false} width={56} domain={['auto', 'auto']} />
            <Tooltip content={<ChartTooltip unit={unit} />} cursor={{ stroke: '#6f7d85', strokeDasharray: '3 3' }} />
            <Line type="linear" dataKey="cost" stroke={vendors.length > 1 ? OTHER : SERIES[0]} strokeWidth={2} isAnimationActive={false}
              dot={<VendorDot />} activeDot={<VendorDot active />} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
