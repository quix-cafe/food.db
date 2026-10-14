import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { date, unitMoney } from '../format.js';

// Categorical slots in fixed order; a vendor keeps its slot by first appearance.
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const OTHER = '#8a969c';

function ChartTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <b>{date(label)}</b>
      {payload.map((p) => (
        <div key={p.dataKey}>
          <span style={{ color: p.color }}>●</span> {p.dataKey}: {unitMoney(p.payload[`${p.dataKey}__raw`])} / {unit || 'unit'}
        </div>
      ))}
    </div>
  );
}

/** Unit cost over time, one line per vendor, for a single purchase unit. */
export default function PriceChart({ purchases }) {
  const units = useMemo(() => {
    const counts = new Map();
    for (const p of purchases) counts.set(p.unit ?? '', (counts.get(p.unit ?? '') ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
  }, [purchases]);
  const [unit, setUnit] = useState(units[0] ?? '');

  const { rows, vendors } = useMemo(() => {
    const chosen = purchases.filter((p) => (p.unit ?? '') === unit).slice().reverse(); // oldest first
    const vendorOrder = [];
    const byDate = new Map();
    for (const p of chosen) {
      const v = p.vendor ?? 'Unknown vendor';
      if (!vendorOrder.includes(v)) vendorOrder.push(v);
      const row = byDate.get(p.date) ?? { date: p.date };
      row[v] = Number(p.unitCost); // plotting only; labels use the exact decimal string
      row[`${v}__raw`] = p.unitCost;
      byDate.set(p.date, row);
    }
    return { rows: [...byDate.values()], vendors: vendorOrder };
  }, [purchases, unit]);

  if (!purchases.length) return <p className="muted">No purchases recorded yet.</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {vendors.length > 1 ? (
          <div className="legend" aria-label="Vendors">
            {vendors.map((v, i) => <span key={v}><i style={{ background: SERIES[i] ?? OTHER }} />{v}</span>)}
          </div>
        ) : <span className="muted">Unit cost per {unit || 'unit'}{vendors[0] ? ` from ${vendors[0]}` : ''}</span>}
        {units.length > 1 && (
          <select className="select" style={{ width: 'auto' }} value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Purchase unit">
            {units.map((u) => <option key={u} value={u}>{u || 'No unit'}</option>)}
          </select>
        )}
      </div>
      <div className="chart-box">
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e3e8ea" vertical={false} />
            <XAxis dataKey="date" tickFormatter={(d) => date(d).replace(/, \d{4}$/, '')} tick={{ fontSize: 12, fill: '#6f7d85' }} tickLine={false} axisLine={{ stroke: '#ccd4d8' }} minTickGap={24} />
            <YAxis tickFormatter={(v) => `$${v}`} tick={{ fontSize: 12, fill: '#6f7d85' }} tickLine={false} axisLine={false} width={56} domain={['auto', 'auto']} />
            <Tooltip content={<ChartTooltip unit={unit} />} cursor={{ stroke: '#6f7d85', strokeDasharray: '3 3' }} />
            {vendors.map((v, i) => (
              <Line key={v} type="linear" dataKey={v} stroke={SERIES[i] ?? OTHER} strokeWidth={2} connectNulls isAnimationActive={false}
                dot={{ r: 4, strokeWidth: 2, stroke: '#fff', fill: SERIES[i] ?? OTHER }} activeDot={{ r: 6, stroke: '#fff', strokeWidth: 2 }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
