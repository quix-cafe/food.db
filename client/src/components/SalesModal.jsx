import { useState } from 'react';
import { paymentFee, saleItem } from '@kitchen/shared';
import { api, notifyDataChanged } from '../api.js';
import { useApi } from '../hooks.js';
import { Decimal, money, toDecimal } from '../format.js';
import { Icon, Modal, Notice, Spinner, useToast } from './ui.jsx';

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

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** Sold / given away / taken, and the split by payment method, with the fees charged on top for Venmo and Cash App. */
function SalesTotals({ totals }) {
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

/**
 * Counting sales during the event, made for a phone. Tap + on what a customer is buying, tick a
 * deal when they used it, then tap how they paid to record the line, or "Given away" for free
 * items. Prices come from the event (`items`: the summary's recipe and sauce rows, each with a
 * `key`: its recipeId, or `blend:<id>` for a sauce sold by the container); the server re-prices
 * each line the same way with `saleItem`. Recent lines can be undone.
 */
export default function SalesModal({ eventId, eventName, items: recipes, onClose }) {
  const report = useApi(`/events/${eventId}/sales`);
  const [line, setLine] = useState({}); // key → { qty, deal }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const toast = useToast();

  const totals = report.data?.totals;
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

  const change = (r, by) => setLine((l) => {
    const qty = Math.max(0, (l[r.key]?.qty ?? 0) + by);
    const next = { ...l };
    if (qty) next[r.key] = { qty, deal: l[r.key]?.deal ?? false };
    else delete next[r.key];
    return next;
  });
  const toggleDeal = (r) => setLine((l) => ({ ...l, [r.key]: { ...l[r.key], deal: !l[r.key]?.deal } }));

  const record = async (method) => {
    setBusy(true);
    setError(null);
    try {
      const data = await api(`/events/${eventId}/sales`, {
        method: 'POST',
        body: { paymentMethod: method, items: items.map((i) => ({ ...(i.r.blendId ? { blendId: i.r.blendId } : { recipeId: i.r.recipeId }), quantity: i.qty, dealUsed: i.dealUsed })) },
      });
      report.setData(data);
      setLine({});
      notifyDataChanged();
      const fee = toDecimal(data.sales[0].fee);
      toast(method === 'free' ? `${plural(count, 'item')} given away`
        : fee.gt(0) ? `${METHOD_LABEL[method]}: ${money(fee.plus(data.sales[0].total))} charged (${money(data.sales[0].total)} + ${money(fee)} fee)`
        : `${METHOD_LABEL[method]}: ${money(data.sales[0].total)} recorded`);
    } catch (err) {
      setError(err.message); // the line stays, so it can be tried again
    } finally {
      setBusy(false);
    }
  };

  const undo = async (sale) => {
    setError(null);
    try {
      await api(`/events/${eventId}/sales/${sale.id}`, { method: 'DELETE' });
      notifyDataChanged();
      toast(`Removed the ${time(sale.createdAt)} ${METHOD_LABEL[sale.paymentMethod]} line`);
    } catch (err) {
      setError(err.message);
    }
  };

  const recent = report.data?.sales ?? [];
  return (
    <Modal title={`Sales · ${eventName}`} onClose={onClose} className="sales-modal">
      {report.error && <Notice kind="error">{report.error.message}</Notice>}
      {totals ? <SalesTotals totals={totals} /> : <Spinner />}

      {!recipes.length ? (
        <p className="muted">Add recipes to this event first.</p>
      ) : (
        <ul className="sales-items">
          {recipes.map((r) => {
            const qty = line[r.key]?.qty ?? 0;
            const t = tally.get(r.key);
            return (
              <li key={r.key} className={qty ? 'in-line' : ''}>
                <div className="sales-item-name">
                  <b>{r.name}</b>
                  <small>{money(r.salePrice)}{r.discountAmount && <span className="deal-tag">{dealLabel(r)}</span>}</small>
                  <small className="muted">{t ? `${t.sold} sold${t.givenAway ? ` · ${t.givenAway} given away` : ''}` : 'None yet'}</small>
                </div>
                <div className="stepper">
                  <button type="button" className="btn" disabled={!qty || busy} onClick={() => change(r, -1)} aria-label={`One fewer ${r.name}`}>−</button>
                  <output aria-label={`${r.name} in this sale`}>{qty}</output>
                  <button type="button" className="btn" disabled={busy} onClick={() => change(r, 1)} aria-label={`One more ${r.name}`}>+</button>
                </div>
                {canDeal(r, qty) && (
                  <label className="deal-toggle">
                    <input type="checkbox" checked={!!line[r.key]?.deal} onChange={() => toggleDeal(r)} />
                    Deal used: {dealLabel(r)}
                    {line[r.key]?.deal && <b> (−{money(saleItem({ ...r, quantity: qty, dealUsed: true }).discount)})</b>}
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="sales-checkout">
        <div className="sales-line">
          {count
            ? <><b>{plural(count, 'item')} · {money(total)}</b>{discount.gt(0) && <span className="muted"> (deal −{money(discount)})</span>}</>
            : <span className="muted">Tap + on what’s being bought, then how they paid.</span>}
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="pay-buttons">
          {PAYMENT_METHODS.map((m) => (
            <button key={m.value} type="button" className="btn primary pay-button" disabled={!count || busy} onClick={() => record(m.value)}>
              {m.label}
              {count > 0 && toDecimal(paymentFee(m.value, total)).gt(0) && (
                <small>Charge {money(total.plus(paymentFee(m.value, total)))} (+{money(paymentFee(m.value, total))} fee)</small>
              )}
            </button>
          ))}
        </div>
        <div className="pay-secondary">
          <button type="button" className="btn" disabled={!count || busy} onClick={() => record('free')}>Given away</button>
          <button type="button" className="btn ghost" disabled={!count || busy} onClick={() => setLine({})}>Clear</button>
        </div>
      </div>

      {recent.length > 0 && (
        <section className="recent-sales">
          <h3>Recorded ({recent.length})</h3>
          <ul>
            {(showAll ? recent : recent.slice(0, 5)).map((s) => (
              <li key={s.id}>
                <span className="muted nowrap">{time(s.createdAt)}</span>
                <span>{s.items.map((i) => `${i.quantity} ${i.name}${i.deals ? ' (deal)' : ''}`).join(', ')}</span>
                <span className="nowrap">{METHOD_LABEL[s.paymentMethod]}{s.paymentMethod !== 'free' && ` ${money(s.total)}`}</span>
                <button type="button" className="link-btn" onClick={() => undo(s)} aria-label={`Undo the ${time(s.createdAt)} sale`}>Undo</button>
              </li>
            ))}
          </ul>
          {recent.length > 5 && (
            <button type="button" className="link-btn" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `Show all ${recent.length}`}</button>
          )}
        </section>
      )}
    </Modal>
  );
}

/**
 * Every sale recorded for the event, newest first: the event page's Sales tab. A line can be
 * removed here too (asks first, unlike the quick Undo in the counter).
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
                <tr><th>Time</th><th>Items</th><th>Paid by</th><th className="num">Discount</th><th className="num">Amount</th><th className="num" title="Charged on top and kept by Venmo (1.9% + $0.10) or Cash App (2.6% + $0.15)">Fee</th><th><span className="visually-hidden">Actions</span></th></tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.id} className={s.paymentMethod === 'free' ? 'free' : ''}>
                    <td className="nowrap" title={new Date(s.createdAt).toLocaleString('en-US')}>{when(s.createdAt)}</td>
                    <td>
                      {s.items.map((i, n) => (
                        <div key={n}>{i.quantity} × {i.name}{i.deals > 0 && <span className="deal-tag">{i.deals > 1 ? `${i.deals} deals` : 'deal'}</span>}</div>
                      ))}
                    </td>
                    <td className="nowrap">{METHOD_LABEL[s.paymentMethod]}</td>
                    <td className="num">{s.items.some((i) => toDecimal(i.discount).gt(0)) ? `−${money(s.items.reduce((sum, i) => sum.plus(i.discount), new Decimal(0)))}` : '—'}</td>
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
                  <td />
                  <td className="num">{toDecimal(totals.discounts).gt(0) ? `−${money(totals.discounts)}` : '—'}</td>
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
