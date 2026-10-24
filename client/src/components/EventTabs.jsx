import { useState } from 'react';
import { api, notifyDataChanged } from '../api.js';
import { useApi } from '../hooks.js';
import { isLabor } from '@kitchen/shared';
import { Decimal, date, money, pack, qty, toDecimal } from '../format.js';
import { Field, Icon } from './ui.jsx';
import { recordedRevenue } from './SalesModal.jsx';
import { isInt, priceText } from './EventPricing.jsx';

/**
 * Labor is listed as its own cost: each recipe row shows its cost without labor, and the labor
 * rows (hours editable, as on the shopping list) carry it, so the Cost column adds up to the total.
 */
export function Financials({ s, eventId }) {
  const loss = toDecimal(s.profit).lt(0);
  const deals = [...s.recipes, ...s.sauces].some((r) => !toDecimal(r.discount).isZero());
  const labor = s.shoppingList.filter(isLabor);
  const laborCost = labor.reduce((sum, l) => sum.plus(l.usedCost), new Decimal(0));
  const food = (r) => toDecimal(r.scaledCost).minus(r.laborCost ?? 0);
  const listed = [...s.recipes.map(food), ...s.sauces.map((b) => toDecimal(b.scaledCost)), laborCost].reduce((a, c) => a.plus(c), new Decimal(0));
  const other = toDecimal(s.totalCost).minus(listed); // amounts set on the shopping list for anything but labor
  return (
    <>
      <div className="figures">
        <div className="panel figure"><span>Vendor fee</span><b>{money(s.vendorFee)}</b></div>
        <div className="panel figure"><span>Projected cost</span><b>{money(s.totalCost)}</b>{labor.length > 0 && <small className="muted">incl. {money(laborCost)} labor</small>}</div>
        <div className="panel figure"><span>Projected revenue</span><b>{money(s.revenue)}</b></div>
        <div className={`panel figure ${loss ? 'loss' : 'profit'}`}><span>Total profit</span><b>{money(s.profit)}</b></div>
        <div className="panel figure"><span>Overall margin</span><b>{s.marginPercent == null ? '—' : `${s.marginPercent}%`}</b></div>
      </div>
      <div className="panel table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Recipe</th><th className="num hide-sm">Servings</th><th className="num hide-sm">Cost / serving</th><th className="num hide-sm">Price / serving</th>
              {deals && <th className="num hide-sm" title="Deals taken off revenue, as if every serving sells on the deal">Discounts</th>}
              <th className="num">Cost</th><th className="num">Revenue</th><th className="num">Profit</th>
            </tr>
          </thead>
          <tbody>
            {s.recipes.map((r) => (
              <tr key={r.recipeId}>
                <td>{r.name}<div className="show-sm"><small className="muted">{r.expectedServings} servings</small></div></td>
                <td className="num hide-sm">{r.expectedServings}</td>
                <td className="num hide-sm">{money(r.costPerServing)}</td>
                <td className="num hide-sm">{money(r.salePrice)}{r.priceSet && <small className="muted" title={`The recipe’s target price is ${money(r.recommendedPrice)}`}> (set)</small>}</td>
                {deals && <td className="num hide-sm">{toDecimal(r.discount).isZero() ? '—' : `−${money(r.discount)}`}</td>}
                <td className="num">{money(food(r))}</td>
                <td className="num">{money(r.revenue)}</td>
                <td className="num">{money(toDecimal(r.revenue).minus(food(r)))}</td>
              </tr>
            ))}
            {s.sauces.map((b) => (
              <tr key={b.blendId}>
                <td>{b.name} <span className="badge">Sauce</span><div className="show-sm"><small className="muted">{b.expectedServings} servings, {b.containers} × {b.container}</small></div></td>
                <td className="num nowrap hide-sm">{b.expectedServings} <small className="muted">({b.containers} × {b.container})</small></td>
                <td className="num hide-sm">{money(b.costPerServing)}</td>
                <td className="num hide-sm">{money(b.salePrice)}{b.priceSet && <small className="muted"> (set)</small>}</td>
                {deals && <td className="num hide-sm">{toDecimal(b.discount).isZero() ? '—' : `−${money(b.discount)}`}</td>}
                <td className="num">{money(b.scaledCost)}</td>
                <td className="num">{money(b.revenue)}</td>
                <td className="num">{money(b.profit)}</td>
              </tr>
            ))}
            {labor.map((l) => (
              <tr key={l.key} className="labor-row">
                <td>{l.name}{l.missingPrice && <> <span className="badge warn">No rate</span></>}<div><small className="muted">{l.recipes.join(', ')}</small></div></td>
                <td className="num hide-sm"><NeededInput key={`${l.ingredientId}:${l.amount}`} line={l} eventId={eventId} /></td>
                <td className="hide-sm" colSpan={deals ? 3 : 2} />
                <td className="num">
                  {money(l.usedCost)}
                  <div className="show-sm"><NeededInput key={`${l.ingredientId}:${l.amount}`} line={l} eventId={eventId} /></div>
                </td>
                <td />
                <td className="num">−{money(l.usedCost)}</td>
              </tr>
            ))}
            {!other.toDecimalPlaces(2).isZero() && (
              <tr className="labor-row">
                <td>Amounts set on the shopping list <span className="muted">(instead of scaling with servings)</span></td>
                <td className="hide-sm" colSpan={deals ? 4 : 3} />
                <td className="num">{other.gt(0) ? '+' : '−'}{money(other.abs())}</td>
                <td />
                <td className="num">{other.gt(0) ? '−' : '+'}{money(other.abs())}</td>
              </tr>
            )}
            {!toDecimal(s.vendorFee).isZero() && (
              <tr className="fee-row">
                <td>Vendor fee</td>
                <td className="hide-sm" colSpan={deals ? 4 : 3} />
                <td /><td />
                <td className="num">−{money(s.vendorFee)}</td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr><td>Total</td><td className="num hide-sm">{[...s.recipes, ...s.sauces].reduce((a, r) => a + Number(r.expectedServings), 0)}</td><td className="hide-sm" /><td className="hide-sm" />{deals && <td className="num hide-sm">−{money([...s.recipes, ...s.sauces].reduce((a, r) => a.plus(r.discount), new Decimal(0)))}</td>}<td className="num">{money(s.totalCost)}</td><td className="num">{money(s.revenue)}</td><td className="num">{money(s.profit)}</td></tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

/**
 * What actually happened, typed in after the event, next to the plan. Profit uses the actual
 * spend when it's given, otherwise the projected cost.
 */
export function Results({ s, form, set, setForm, eventId }) {
  const { data: report } = useApi(`/events/${eventId}/sales`);
  const recorded = recordedRevenue(report);
  const dec = (v) => (v.trim() === '' ? null : toDecimal(v.replace(/[$,]/g, '')));
  const guests = isInt(form.guestCount) ? new Decimal(form.guestCount) : null;
  const actualGuests = isInt(form.actualGuests) ? new Decimal(form.actualGuests) : null;
  const revenue = dec(form.actualRevenue);
  const spend = dec(form.actualCost);
  const plannedCost = toDecimal(s.totalCost);
  const plannedRevenue = toDecimal(s.revenue);
  const plannedProfit = toDecimal(s.profit);
  const cost = spend ?? (revenue ? plannedCost : null);
  const fee = toDecimal(s.vendorFee) ?? new Decimal(0);
  const profit = revenue && cost ? revenue.minus(cost).minus(fee) : null;
  const margin = (p, r) => (p && r && !r.isZero() ? p.div(r).times(100) : null);
  const perGuest = (r, g) => (r && g && !g.isZero() ? r.div(g) : null);
  const pct = (d) => (d === null ? '—' : `${d.toFixed(1)}%`);
  const count = (d) => (d === null ? '—' : d.toString());
  const signed = (d, fmt) => (d === null ? '—' : `${d.gt(0) ? '+' : d.lt(0) ? '−' : ''}${fmt(d.abs())}`);
  const diff = (a, b) => (a === null || b === null ? null : a.minus(b));
  // Higher is better for everything but cost.
  const tone = (d, lowerIsBetter = false) => (d === null || d.isZero() ? '' : d.gt(0) !== lowerIsBetter ? 'better' : 'worse');
  const rows = [
    ['Guests', guests, actualGuests, count, false, (d) => d.toString()],
    ['Revenue', plannedRevenue, revenue, money, false, money],
    [spend ? 'Spend' : 'Cost (projected; enter the actual spend to compare)', plannedCost, spend, money, true, money],
    ['Profit', plannedProfit, profit, money, false, money],
    ['Margin', margin(plannedProfit, plannedRevenue), margin(profit, revenue), pct, false, (d) => `${d.toFixed(1)} pts`],
    ['Revenue per guest', perGuest(plannedRevenue, guests), perGuest(revenue, actualGuests), (d) => (d === null ? '—' : money(d)), false, money],
  ];
  return (
    <>
      <section className="panel panel-pad">
        <div className="form-grid">
          <Field label="Actual guests"><input className="input num" inputMode="numeric" value={form.actualGuests} onChange={set('actualGuests')} placeholder={form.guestCount || ''} /></Field>
          <Field label="Actual revenue" hint={recorded && (
            <>
              Recorded sales: {money(recorded)} ({report.totals.sold} sold, {report.totals.givenAway} given away)
              {!toDecimal(priceText(form.actualRevenue))?.eq(recorded) && <>{' · '}<button type="button" className="link-btn" onClick={() => setForm((f) => ({ ...f, actualRevenue: recorded.toFixed(2) }))}>Use it</button></>}
            </>
          )}>
            <input className="input num" inputMode="decimal" value={form.actualRevenue} onChange={set('actualRevenue')} placeholder="0.00" />
          </Field>
          <Field label="Actual spend" hint={`Shopping list total: ${money(s.purchaseCost)}`}><input className="input num" inputMode="decimal" value={form.actualCost} onChange={set('actualCost')} placeholder="0.00" /></Field>
          <Field label="Notes" className="span-2"><textarea className="input" rows={3} value={form.notes} onChange={set('notes')} placeholder="What sold out, what was left over, what to change next time…" /></Field>
        </div>
      </section>
      <div className="panel table-wrap">
        <table className="grid results-grid">
          <thead><tr><th /><th className="num">Planned</th><th className="num">Actual</th><th className="num">Difference</th></tr></thead>
          <tbody>
            {rows.map(([label, planned, actual, fmt, lowerIsBetter, fmtDiff]) => {
              const d = diff(actual, planned);
              return (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num">{planned === null ? '—' : fmt(planned)}</td>
                  <td className="num" style={{ fontWeight: 650 }}>{actual === null ? '—' : fmt(actual)}</td>
                  <td className={`num ${tone(d, lowerIsBetter)}`}>{signed(d, fmtDiff)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {revenue && !spend && <p className="muted">Profit uses the projected cost until you enter the actual spend.</p>}
      {fee.gt(0) && <p className="muted">Profit is after the {money(fee)} vendor fee{spend ? '; leave it out of the actual spend' : ''}.</p>}
    </>
  );
}

/**
 * The shopping list as printed: one dense table grouped by category, with a box to tick
 * per line. Labor isn't bought, so it's left off. Shown only in print (see styles.css).
 */
function PrintedList({ s, title, day, guests }) {
  const lines = s.shoppingList.filter((l) => !isLabor(l));
  const groups = new Map();
  for (const l of lines) {
    const key = l.blendId ? (l.category === 'Sauce' ? 'Sauces to make' : 'Spice blends to make') : l.category || 'Other';
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const order = [...groups.keys()].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  const total = lines.reduce((sum, l) => sum.plus(toDecimal(l.purchaseCost) ?? 0), new Decimal(0));
  return (
    <div className="print-only printed-list">
      <h2>{title}: shopping list</h2>
      <p>
        {[day && date(day), guests && `${guests} guests`, `${lines.length} items`, `about ${money(total)}`].filter(Boolean).join(', ')}
      </p>
      <table>
        <thead>
          <tr><th aria-label="Got it" /><th>Item</th><th>Buy</th><th className="num">Needed</th><th className="num">Est.</th><th>Store</th><th>For</th></tr>
        </thead>
        {order.map((group) => (
          <tbody key={group}>
            <tr className="group"><th colSpan={7}>{group}</th></tr>
            {groups.get(group).map((l) => (
              <tr key={l.key}>
                <td><span className="tick" /></td>
                <td className="item">{l.name}</td>
                <td className="nowrap">
                  {l.blendId
                    ? `${l.packsToBuy} batch${l.packsToBuy === '1' ? '' : 'es'} (${qty(l.packSize, 2)} ${l.uom})`
                    : l.packSize ? `${l.packsToBuy} × ${pack(l.packSize, l.uom, 2)}` : '—'}
                </td>
                <td className="num nowrap">{qty(l.amount, 2)} {l.uom}</td>
                <td className="num">{l.purchaseCost ? money(l.purchaseCost) : '—'}</td>
                <td>{l.vendor ?? ''}</td>
                <td className="for">{l.recipes.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

// Printing hides everything on the page except this list (see .printing in styles.css).
function printShoppingList() {
  document.body.classList.add('printing');
  window.addEventListener('afterprint', () => document.body.classList.remove('printing'), { once: true });
  window.print();
}

/**
 * Labor's "needed" is typed in rather than scaled from servings. Saving stores it for this
 * event; "Use recipes" clears it so the scaled total applies again.
 */
function NeededInput({ line, eventId }) {
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const value = draft ?? toDecimal(line.amount).toDecimalPlaces(2).toString();
  const save = async () => {
    if (draft === null) return;
    const d = toDecimal(draft);
    if (!d || d.lt(0)) return setError('Enter 0 or more');
    setError(null);
    try {
      await api(`/events/${eventId}/amounts/${line.ingredientId}`, { method: 'PUT', body: { amount: d.toString() } });
      notifyDataChanged();
    } catch (err) {
      setError(err.message);
    }
    setDraft(null);
  };
  const reset = async () => {
    await api(`/events/${eventId}/amounts/${line.ingredientId}`, { method: 'DELETE' });
    notifyDataChanged();
  };
  // Kept narrow: the unit sits inside the box, and "Reset" (back to the recipes' total, shown on hover) is one word.
  return (
    <div className="needed-input">
      <span className="unit-input">
        <input className="input num" inputMode="decimal" value={value} aria-label={`${line.name} needed, in ${line.uom}`}
          aria-invalid={!!error} onChange={(e) => setDraft(e.target.value)} onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(null); setError(null); } }} />
        <span>{line.uom}</span>
      </span>
      {error && <small style={{ color: 'var(--tomato)' }}>{error}</small>}
      {line.amountSet && (
        <button type="button" className="link-btn no-print" onClick={reset}
          title={`Go back to what the recipes add up to: ${qty(line.calculatedAmount, 2)} ${line.uom}`}>
          <small>Reset to {qty(line.calculatedAmount, 2)}</small>
        </button>
      )}
    </div>
  );
}

export function ShoppingList({ s, eventId, title, date: day, guests }) {
  return (
    <div className="print-target" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="list-actions no-print">
        <a className="btn small" href={`/api/events/${eventId}/shopping-list.csv`} download><Icon.download /> Download CSV</a>
        <button className="btn small" onClick={printShoppingList}><Icon.print /> Print</button>
      </div>
      <PrintedList s={s} title={title} day={day} guests={guests} />
    <div className="panel table-wrap no-print">
      <table className="grid">
        <thead>
          <tr>
            <th>Ingredient</th>
            <th className="num" title="Total amount used across recipes, in the ingredient's unit of measurement">Needed</th>
            <th className="num" title="Whole store packs, at the latest purchase's pack size"><span className="hide-sm">Packs to buy</span><span className="show-sm">Packs</span></th>
            <th className="hide-sm">Pack size</th>
            <th className="num" title="Packs to buy × the latest pack price: what you'll pay">Total cost</th>
            <th className="num hide-sm" title="Cost of the amount the recipes use; matches the recipes' total cost">Used cost</th>
            <th className="num hide-sm" title="What's left of the packs you buy after the recipes: packs × pack size − needed">Leftover</th>
            <th className="hide-sm">Used in</th>
          </tr>
        </thead>
        <tbody>
          {s.shoppingList.map((l) => (
            <tr key={l.key} className={isLabor(l) ? 'labor-row' : ''}>
              <td style={{ fontWeight: 600 }}>
                {l.name}{l.missingPrice && <> <span className="badge warn">No price</span></>}
                {l.blendId && <div><small className="muted" style={{ fontWeight: 400 }}>{l.category ?? 'Spice blend'}: make {l.packsToBuy} batch{l.packsToBuy === '1' ? '' : 'es'}</small></div>}
                <div className="show-sm"><small className="muted" style={{ fontWeight: 400 }}>{l.recipes.join(', ')}</small></div>
              </td>
              <td className="num nowrap">{isLabor(l) ? <NeededInput key={`${l.ingredientId}:${l.amount}`} line={l} eventId={eventId} /> : `${qty(l.amount, 2)} ${l.uom}`}</td>
              <td className="num" style={{ fontWeight: 700 }}>
                {l.packsToBuy}
                {l.packSize && <div className="show-sm"><small className="muted" style={{ fontWeight: 400 }}>× {pack(l.packSize, l.uom, 2)}</small></div>}
              </td>
              <td className="nowrap hide-sm">{l.packSize ? `${pack(l.packSize, l.uom, 2)}${l.blendId ? ' batch' : ''}` : '—'}</td>
              <td className="num" style={{ fontWeight: 650 }}>{l.purchaseCost ? money(l.purchaseCost) : '—'}</td>
              <td className="num hide-sm">{money(l.usedCost)}</td>
              <td className="num nowrap muted hide-sm">{qty(l.leftover, 2)} {l.uom}</td>
              <td className="muted hide-sm">{l.recipes.join(', ')}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="shop-total">
          <tr>
            <td>Total <span className="muted" style={{ fontWeight: 500 }}>({s.shoppingList.length} items)</span></td><td /><td /><td className="hide-sm" />
            <td className="num">
              {money(s.purchaseCost)}
              {/* The Used cost column is hidden on a phone; its total goes here. */}
              <div className="show-sm"><small className="muted" style={{ fontWeight: 600 }}>Used {money(s.totalCost)}</small></div>
            </td>
            <td className="num hide-sm">{money(s.totalCost)}</td><td className="hide-sm" /><td className="hide-sm" />
          </tr>
        </tfoot>
      </table>
    </div>
    </div>
  );
}
