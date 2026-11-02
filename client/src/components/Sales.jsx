import { useEffect, useRef, useState } from 'react';
import { OPEN_ORDER_STATUSES, menuItemName, saleItem } from '@kitchen/shared';
import { api, notifyDataChanged } from '../api.js';
import { useApi } from '../hooks.js';
import { Decimal, money, toDecimal } from '../format.js';
import { recipeColors } from '../palette.js';
import { Icon, Notice, Spinner, useToast } from './ui.jsx';

export const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'venmo', label: 'Venmo' },
  { value: 'cashapp', label: 'Cash App' },
];
const METHOD_LABEL = { ...Object.fromEntries(PAYMENT_METHODS.map((m) => [m.value, m.label])), free: 'Given away' };

/** "Buy 2, $1.00 off" / "$0.50 off each" for a recipe's deal at this event. */
export const dealLabel = (r) =>
  r.discountQty > 1 ? `Buy ${r.discountQty}, ${money(r.discountAmount)} off` : `${money(r.discountAmount)} off each`;

export const ORDER_STATUS_LABEL = { placed: 'Placed', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
const STATUS_BADGE = { placed: 'new', in_progress: '', completed: 'good', cancelled: 'warn' };
export const OrderStatus = ({ status }) => <span className={`badge ${STATUS_BADGE[status]}`}>{ORDER_STATUS_LABEL[status]}</span>;

/** Which orders count as open, completed and cancelled on the POS screen. */
export const ORDER_VIEWS = [
  { value: 'open', label: 'In progress', statuses: OPEN_ORDER_STATUSES },
  { value: 'completed', label: 'Completed', statuses: ['completed'] },
  { value: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
];

/** One tab's orders: the queue is first come, first served; finished orders show the latest first. */
export function ordersInView(sales, value) {
  const { statuses } = ORDER_VIEWS.find((v) => v.value === value);
  const orders = sales.filter((s) => statuses.includes(s.status));
  return value === 'open' ? orders.reverse() : orders.sort((a, b) => new Date(b.statusChangedAt) - new Date(a.statusChangedAt));
}

/** What can be sold at an event, from its summary: the recipes, then the sauces sold by the container. */
export function saleMenu(s) {
  if (!s) return [];
  const menu = [
    ...s.recipes.map((r) => ({ ...r, name: menuItemName(r), key: r.recipeId })),
    ...s.sauces.map((b) => ({ ...b, key: `blend:${b.blendId}` })),
  ];
  const colors = recipeColors(menu.map((r) => r.key));
  return menu.map((r) => ({ ...r, color: colors.get(r.key) }));
}

/** The left border's color for a menu row, or a line on an order (`menu` still has what's still on the menu). */
export const tile = (r) => (r?.color ? { '--tile': r.color } : undefined);
export const orderItemTile = (menu, i) => tile(menu.find((r) => r.key === (i.recipeId ?? `blend:${i.blendId}`)));

export const paymentLabel = (method) => METHOD_LABEL[method];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** Sold / given away / taken, and the split by payment method, with the fees charged on top for Venmo and Cash App. */
export function SalesTotals({ totals }) {
  return (
    <div className="sales-totals" aria-live="polite">
      <div><b>{totals.sold}</b><span>sold</span></div>
      <div><b>{totals.givenAway}</b><span>given away</span></div>
      <div><b>{money(totals.revenue)}</b><span>taken{totals.deals ? ` · ${plural(totals.deals, 'deal')}` : ''}</span></div>
      <p className="muted">
        {PAYMENT_METHODS.map((m) => {
          const { amount, fees } = totals.byMethod[m.value];
          return `${m.label} ${money(amount)}${toDecimal(fees).gt(0) ? ` (+${money(fees)} fees)` : ''}`;
        }).join(' · ')}
        {toDecimal(totals.fees).gt(0) && <><br />Customers paid <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{money(totals.charged)}</span>, including {money(totals.fees)} in fees the apps keep</>}
      </p>
    </div>
  );
}

const NAME_WARNING_GUARD_MS = 500;

/** The name box for a new order, and the warning under it when an order is placed without one. */
export function CustomerNameField({ draft }) {
  return (
    <>
      <input ref={draft.nameRef} className="input customer-name new-order-name" value={draft.name} maxLength={120} autoComplete="off" placeholder="Customer name"
        aria-label="Customer name" aria-invalid={!!draft.unnamed} onChange={(e) => draft.setName(e.target.value)} />
      {draft.unnamed && (
        <div className="name-warning" role="alert">
          <span><Icon.alert /> <b>No name on this order.</b> Add one above, or place it without a name.</span>
          <button type="button" className="btn" disabled={draft.busy} onClick={draft.placeUnnamed}>
            Place without a name ({METHOD_LABEL[draft.unnamed]})
          </button>
        </div>
      )}
    </>
  );
}

/**
 * One order being built on the POS screen. Prices come from the event (`items`:
 * saleMenu rows); the server re-prices each line the same way with `saleItem`. It joins the queue
 * as placed.
 */
export function useSaleDraft({ eventId, items: recipes, totals, onRecorded }) {
  const [line, setLine] = useState({}); // key → { qty, deal }
  const [name, setNameText] = useState('');
  const [unnamed, setUnnamed] = useState(null); // how they paid, while the missing-name warning is up
  const warnedAt = useRef(0);
  const nameRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const toast = useToast();

  const tally = new Map((totals?.byRecipe ?? []).map((r) => [r.recipeId ?? `blend:${r.blendId}`, r]));
  const canDeal = (r, qty) => !!r.discountAmount && qty >= (r.discountQty ?? 1);
  const items = recipes
    .filter((r) => line[r.key]?.qty > 0)
    .map((r) => {
      const { qty, deal } = line[r.key];
      const dealUsed = deal && canDeal(r, qty);
      return { r, qty, dealUsed, priced: saleItem({ ...r, quantity: qty, dealUsed }) };
    });
  const count = items.reduce((n, i) => n + i.qty, 0);
  const total = items.reduce((sum, i) => sum.plus(i.priced.amount), new Decimal(0));
  const discount = items.reduce((sum, i) => sum.plus(i.priced.discount), new Decimal(0));

  const setName = (text) => {
    setNameText(text);
    if (text.trim()) setUnnamed(null);
  };
  const change = (r, by) => { setUnnamed(null); setLine((l) => {
    const qty = Math.max(0, (l[r.key]?.qty ?? 0) + by);
    const next = { ...l };
    if (qty) next[r.key] = { qty, deal: l[r.key]?.deal ?? false };
    else delete next[r.key];
    return next;
  }); };
  const toggleDeal = (r) => { setUnnamed(null); setLine((l) => ({ ...l, [r.key]: { ...l[r.key], deal: !l[r.key]?.deal } })); };
  const clear = () => { setLine({}); setName(''); setUnnamed(null); };

  const place = async (method) => {
    setBusy(true);
    setError(null);
    try {
      const data = await api(`/events/${eventId}/sales`, {
        method: 'POST',
        body: {
          paymentMethod: method,
          items: items.map((i) => ({ ...(i.r.blendId ? { blendId: i.r.blendId } : { recipeId: i.r.recipeId }), quantity: i.qty, dealUsed: i.dealUsed })),
          customerName: name,
          status: 'placed',
        },
      });
      onRecorded(data);
      clear();
      notifyDataChanged();
      const fee = toDecimal(data.sales[0].fee);
      toast(`Order placed${name.trim() ? ` for ${name.trim()}` : ''}: ${money(fee.plus(data.sales[0].total))}`);
    } catch (err) {
      setError(err.message); // the line stays, so it can be tried again
    } finally {
      setBusy(false);
    }
  };

  // No name yet: ask first. On a touch screen the field isn't focused, or its keyboard would cover the warning.
  const record = (method) => {
    if (name.trim()) {
      place(method);
      return;
    }
    warnedAt.current = Date.now();
    setUnnamed(method);
    if (window.matchMedia?.('(hover: hover)').matches) nameRef.current?.focus();
  };
  // A quick second tap on the pay button can land here as the warning pushes things around.
  const placeUnnamed = () => {
    if (Date.now() - warnedAt.current < NAME_WARNING_GUARD_MS) return;
    const method = unnamed;
    setUnnamed(null);
    place(method);
  };

  return { line, name, setName, nameRef, unnamed, placeUnnamed, busy, error, tally, canDeal, items, count, total, discount, change, toggleDeal, clear, record };
}

/** Other phones and tablets take orders too, so whatever shows the queue keeps itself current. */
export function useQueuePolling(reload) {
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) reload(); }, 10000);
    return () => clearInterval(t);
  }, [reload]);
}

/**
 * Every sale recorded for the event, newest first: the event page's Sales tab. A line can be
 * removed here too (asks first).
 */
export function SalesTable({ eventId, onRecord }) {
  const { data, error } = useApi(`/events/${eventId}/sales`);
  const [confirming, setConfirming] = useState(null);
  const [removeError, setRemoveError] = useState(null);
  const toast = useToast();
  if (error) return <Notice kind="error">{error.message}</Notice>;
  if (!data) return <Spinner />;
  const { sales, totals } = data;
  const days = new Set(sales.map((s) => new Date(s.createdAt).toDateString())).size;
  const when = (iso) => (days > 1 ? `${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time(iso)}` : time(iso));

  const remove = async (sale) => {
    setRemoveError(null);
    try {
      await api(`/events/${eventId}/sales/${sale.id}`, { method: 'DELETE' });
      setConfirming(null);
      notifyDataChanged();
      toast(`Removed the ${time(sale.createdAt)} ${METHOD_LABEL[sale.paymentMethod]} line`);
    } catch (err) {
      setRemoveError(err.message);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="list-actions">
        <button className="btn small" onClick={onRecord}><Icon.cart /> Record sales</button>
      </div>
      {!sales.length ? (
        <div className="panel empty"><p>No sales recorded yet. During the event, use Record sales to count what’s sold and given away.</p></div>
      ) : (
        <>
          <section className="panel panel-pad"><SalesTotals totals={totals} /></section>
          {removeError && <Notice kind="error">{removeError}</Notice>}
          <div className="panel table-wrap">
            <table className="grid sales-table">
              <thead>
                <tr><th>Time</th><th>Order</th><th>Status</th><th>Paid by</th><th className="num hide-sm">Discount</th><th className="num">Amount</th><th className="num" title="Charged on top and kept by Venmo (1.9% + $0.10) or Cash App (2.6% + $0.15)">Fee</th><th><span className="visually-hidden">Actions</span></th></tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.id} className={s.status === 'cancelled' ? 'cancelled' : s.paymentMethod === 'free' ? 'free' : ''}>
                    <td className="nowrap" title={new Date(s.createdAt).toLocaleString('en-US')}>{when(s.createdAt)}</td>
                    <td>
                      {s.customerName && <b>{s.customerName}</b>}
                      {s.items.map((i, n) => (
                        <div key={n}>{i.quantity} × {i.name}{i.deals > 0 && <span className="deal-tag">{i.deals > 1 ? `${i.deals} deals` : 'deal'}</span>}</div>
                      ))}
                    </td>
                    <td className="nowrap"><OrderStatus status={s.status} /></td>
                    <td className="nowrap">{METHOD_LABEL[s.paymentMethod]}</td>
                    <td className="num hide-sm">{s.items.some((i) => toDecimal(i.discount).gt(0)) ? `−${money(s.items.reduce((sum, i) => sum.plus(i.discount), new Decimal(0)))}` : '—'}</td>
                    <td className="num" style={{ fontWeight: 650 }}>{s.paymentMethod === 'free' ? <span className="muted">Free</span> : money(s.total)}</td>
                    <td className="num muted">{toDecimal(s.fee).gt(0) ? `+${money(s.fee)}` : '—'}</td>
                    <td className="nowrap">
                      {confirming === s.id ? (
                        <span className="sales-confirm">
                          Remove?{' '}
                          <button type="button" className="link-btn danger" onClick={() => remove(s)}>Yes</button>{' '}
                          <button type="button" className="link-btn" onClick={() => setConfirming(null)}>No</button>
                        </span>
                      ) : (
                        <button className="icon-btn" aria-label={`Remove the ${time(s.createdAt)} sale`} onClick={() => setConfirming(s.id)}><Icon.trash /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>{plural(totals.sales, 'line')}</td>
                  <td>{totals.sold} sold{totals.givenAway ? `, ${totals.givenAway} given away` : ''}</td>
                  <td>{totals.byStatus.cancelled ? `${totals.byStatus.cancelled} cancelled, not counted` : ''}</td>
                  <td />
                  <td className="num hide-sm">{toDecimal(totals.discounts).gt(0) ? `−${money(totals.discounts)}` : '—'}</td>
                  <td className="num">{money(totals.revenue)}</td>
                  <td className="num">{toDecimal(totals.fees).gt(0) ? `+${money(totals.fees)}` : '—'}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** Recorded sales revenue (payment fees are charged on top, so not included), for the "After the event" tab; null when nothing was recorded. */
export function recordedRevenue(report) {
  const t = report?.totals;
  return t && t.sales > 0 ? toDecimal(t.revenue) : null;
}
