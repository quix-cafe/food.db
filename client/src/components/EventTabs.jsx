import { useState } from 'react';
import { api, notifyDataChanged } from '../api.js';
import { useApi } from '../hooks.js';
import { amountLabel, menuItemName } from '@kitchen/shared';
import { Decimal, date, money, pack, qty, toDecimal } from '../format.js';
import { Field, Icon } from './ui.jsx';
import { IngredientDrawer } from './IngredientDrawer.jsx';
import { recordedRevenue } from './Sales.jsx';
import { isInt, priceText } from './EventPricing.jsx';

/** The shopping list's lines (labor isn't one: it's the event's own), and their summed `field`. */
const groceries = (s) => s.shoppingList;
// Not bought: plain water, however it's written in a recipe ("Water", "cold water"), not coconut water.
const TAP_WATER = /^(?:(?:tap|cold|cool|warm|hot|boiling|filtered|room[- ]temperature|ice)\s+)?water$/i;
const INVENTORY = 'Inventory';
const sumOf = (lines, field) => lines.reduce((sum, l) => sum.plus(toDecimal(l[field]) ?? 0), new Decimal(0));

/**
 * Labor is the event's own cost at the bottom: its hours × its hourly rate, both editable in the
 * Servings and Cost / serving columns, so the Cost column adds up to the total.
 */

export function Financials({ s, eventId }) {
  const loss = toDecimal(s.profit).lt(0);
  const flat = s.kind !== 'market';
  // What the price column says: a market's price per serving, or the share of the rate an item carries.
  const hoamsy = s.flat?.hoamsyPercent != null; // a supper club with a Hoamsy fee
  const priceCell = (r) => (flat
    ? <span title={`${r.share}% of the food cost, so ${r.share}% of the ${s.kind !== 'supper_club' ? 'rate and groceries' : hoamsy ? 'ticket money after Hoamsy’s cut' : 'ticket money'}`}>{r.netPrice == null ? '—' : money(r.netPrice)}</span>
    : <>{money(r.salePrice)}{r.priceSet && <small className="muted" title={`The recipe’s target price is ${money(r.recommendedPrice)}`}> (set)</small>}</>);
  const deals = [...s.recipes, ...s.sauces].some((r) => !toDecimal(r.discount).isZero());
  const laborCost = toDecimal(s.labor.cost);
  const food = (r) => toDecimal(r.scaledCost);
  const listed = [...s.recipes.map(food), ...s.sauces.map((b) => toDecimal(b.scaledCost)), laborCost].reduce((a, c) => a.plus(c), new Decimal(0));
  const other = toDecimal(s.totalCost).minus(listed); // amounts set on the shopping list
  // At a flat-rate event, one serving of everything is a plate: what it costs and what it makes.
  const items = [...s.recipes, ...s.sauces];
  const plate = (key) => items.reduce((a, r) => a.plus(toDecimal(r[key]) ?? 0), new Decimal(0));
  const marginCell = (r) => flat && <td className="num hide-sm">{r.marginPerServing == null ? '—' : money(r.marginPerServing)}</td>;
  const blank = (deals ? 1 : 0) + (flat ? 1 : 0); // columns between price and cost
  // At a flat-rate event, labor and the vendor fee are paid out of the rate before the dishes' share.
  const setAside = flat ? toDecimal(s.flat.passThrough) ?? new Decimal(0) : new Decimal(0);
  return (
    <>
      <div className="figures">
        {hoamsy && <div className={`panel figure ${toDecimal(s.hoamsyFee).gt(0) ? 'fee' : ''}`}><span>Hoamsy fee</span><b>{toDecimal(s.hoamsyFee).gt(0) ? '−' : ''}{money(s.hoamsyFee)}</b><small className="muted">{s.flat.hoamsyPercent}% of {money(s.flat.gross)} in tickets, taken first</small></div>}
        <div className="panel figure"><span>Projected revenue</span><b>{money(s.revenue)}</b>
          {s.kind === 'supper_club' && <small className="muted">{s.flat.tickets} tickets × {money(s.flat.flatPrice)}{hoamsy ? ', less the Hoamsy fee' : ''}</small>}
          {s.kind === 'personal_chef' && <small className="muted">{money(s.flat.flatPrice)} rate + {money(s.flat.groceries)} groceries</small>}
        </div>
        <div className="panel figure"><span>Projected cost</span><b>{money(s.totalCost)}</b>{laborCost.gt(0) && <small className="muted">{money(toDecimal(s.totalCost).minus(laborCost))} food / {money(laborCost)} labor</small>}</div>
        <div className="panel figure"><span>Vendor fee</span><b>{money(s.vendorFee)}</b><small className="muted">off the profit</small></div>
        <div className={`panel figure ${loss ? 'loss' : 'profit'}`}><span>Projected profit</span><b>{money(s.profit)}</b></div>
        <div className="panel figure" title={flat ? 'The food’s revenue (after labor and the vendor fee are paid back at cost) less the food, over that revenue' : 'Revenue less the food, over revenue'}><span>Gross margin</span><b>{s.grossMarginPercent == null ? '—' : `${s.grossMarginPercent}%`}</b><small className="muted">on food</small></div>
        <div className={`panel figure ${loss ? 'loss' : ''}`} title="Profit over revenue: food, labor and the vendor fee all out"><span>Net margin</span><b>{s.marginPercent == null ? '—' : `${s.marginPercent}%`}</b><small className="muted">after food, labor and fees</small></div>
      </div>
      <div className="panel table-wrap">
        <table className="grid fin-table">
          <thead>
            <tr>
              <th>Recipe</th><th className="num hide-sm">Servings</th><th className="num hide-sm">Cost / serving</th><th className="num hide-sm" title={flat ? 'Each item’s revenue per serving: its share of the revenue, by its share of the food cost' : undefined}>{flat ? 'Revenue / serving' : 'Price / serving'}</th>
              {flat && <th className="num hide-sm" title="What a serving makes on its food (and its share of amounts set by hand); labor and the vendor fee are set aside from the rate first">Margin / serving</th>}
              {deals && <th className="num hide-sm" title="Deals taken off revenue, as if every serving sells on the deal">Discounts</th>}
              <th className="num">Cost</th><th className="num">Revenue</th><th className="num">Profit</th>
            </tr>
          </thead>
          <tbody>
            {s.recipes.map((r) => (
              <tr key={r.recipeId}>
                <td>{r.name}{r.servingLabel && <small className="muted"> ({r.servingLabel} a serving)</small>}<div className="show-sm"><small className="muted">{r.expectedServings} servings</small></div></td>
                <td className="num hide-sm">{r.expectedServings}</td>
                <td className="num hide-sm">{money(r.costPerServing)}</td>
                <td className="num hide-sm">{priceCell(r)}</td>
                {marginCell(r)}
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
                <td className="num hide-sm">{priceCell(b)}</td>
                {marginCell(b)}
                {deals && <td className="num hide-sm">{toDecimal(b.discount).isZero() ? '—' : `−${money(b.discount)}`}</td>}
                <td className="num">{money(b.scaledCost)}</td>
                <td className="num">{money(b.revenue)}</td>
                <td className="num">{money(b.profit)}</td>
              </tr>
            ))}
            {setAside.gt(0) && (
              <tr className="set-aside-row">
                <td>Set aside for labor and the vendor fee <span className="muted">(out of the {s.kind === 'supper_club' ? 'tickets' : 'rate'}, at cost)</span></td>
                <td className="hide-sm" colSpan={3 + blank} />
                <td />
                <td className="num">{money(setAside)}</td>
                <td className="num">+{money(setAside)}</td>
              </tr>
            )}
            <tr className="labor-row">
              <td>
                Labor{s.labor.rate === null && <> <span className="badge warn">No rate</span></>}
                {/* On a phone the hours and rate columns are hidden: their boxes go under the name, not in Cost. */}
                <div className="show-sm labor-sm">
                  <LaborInput key={`h:${s.labor.hours}`} eventId={eventId} field="hours" value={s.labor.hours} />
                  <LaborInput key={`r:${s.labor.rate}`} eventId={eventId} field="rate" value={s.labor.rate} />
                </div>
              </td>
              <td className="num hide-sm"><LaborInput key={`h:${s.labor.hours}`} eventId={eventId} field="hours" value={s.labor.hours} /></td>
              <td className="num nowrap hide-sm"><LaborInput key={`r:${s.labor.rate}`} eventId={eventId} field="rate" value={s.labor.rate} /></td>
              <td className="hide-sm" colSpan={1 + blank} />
              <td className="num">{money(laborCost)}</td>
              <td /><td className="num">−{money(laborCost)}</td>
            </tr>
            {!other.toDecimalPlaces(2).isZero() && (
              <tr className="labor-row">
                <td>Amounts set on the shopping list <span className="muted">(instead of scaling with servings)</span></td>
                <td className="hide-sm" colSpan={3 + blank} />
                <td className="num">{other.gt(0) ? '+' : '−'}{money(other.abs())}</td>
                <td />
                <td className="num">{other.gt(0) ? '−' : '+'}{money(other.abs())}</td>
              </tr>
            )}
            {!toDecimal(s.vendorFee).isZero() && (
              <tr className="fee-row">
                <td>Vendor fee</td>
                <td className="hide-sm" colSpan={3 + blank} />
                <td /><td /><td className="num">−{money(s.vendorFee)}</td>
              </tr>
            )}

          </tbody>
          <tfoot>
            <tr><td>Total</td><td className="num nowrap hide-sm" title="Servings of every recipe and sauce; labor hours aren’t counted">{[...s.recipes, ...s.sauces].reduce((a, r) => a + Number(r.expectedServings), 0)} <small className="muted">servings</small></td>{flat
              ? <><td className="num hide-sm" title="One serving of every item: a plate's food cost">{money(plate('costPerServing'))}</td><td className="num hide-sm" title="One serving of every item: a plate's revenue">{money(plate('netPrice'))}</td><td className="num hide-sm" title="One serving of every item: what a plate makes">{money(plate('marginPerServing'))}</td></>
              : <><td className="hide-sm" /><td className="hide-sm" /></>}{deals && <td className="num hide-sm">−{money([...s.recipes, ...s.sauces].reduce((a, r) => a.plus(r.discount), new Decimal(0)))}</td>}<td className="num">{money(s.totalCost)}</td><td className="num">{money(s.revenue)}</td><td className="num">{money(s.profit)}</td></tr>
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
  const entered = dec(form.actualRevenue);
  // A supper club's actual revenue is the ticket money; with a Hoamsy fee, Hoamsy takes its share of that first, as in the plan.
  const keep = s.flat?.hoamsyPercent != null ? new Decimal(1).minus(toDecimal(s.flat.hoamsyPercent).div(100)) : null;
  const revenue = entered && keep ? entered.times(keep) : entered;
  const hoamsy = entered && keep ? entered.minus(revenue) : null;
  const spend = dec(form.actualCost);
  const plannedCost = toDecimal(s.totalCost);
  const plannedRevenue = toDecimal(s.revenue);
  const plannedProfit = toDecimal(s.profit);
  const cost = spend ?? (revenue ? plannedCost : null);
  const fee = toDecimal(s.vendorFee) ?? new Decimal(0);
  // A supper club's Hoamsy fee is a share of what the tickets actually brought in.
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
    [keep ? 'Revenue after the Hoamsy fee' : 'Revenue', plannedRevenue, revenue, money, false, money],
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
          <Field label="Actual spend" hint={`Shopping list total: ${money(sumOf(groceries(s), 'purchaseCost'))}`}><input className="input num" inputMode="decimal" value={form.actualCost} onChange={set('actualCost')} placeholder="0.00" /></Field>
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
      {hoamsy && <p className="muted">Actual revenue is the ticket money: Hoamsy’s {s.flat.hoamsyPercent}% ({money(hoamsy)}) comes off it first.</p>}
      <RecordedSales s={s} report={report} />
    </>
  );
}

/**
 * What Record sales logged, per menu item, against what was made and what selling all of it would
 * bring in (the Financials revenue, deals included). Kept apart from the actual figures above:
 * a sale nobody tapped in isn't here.
 */
function RecordedSales({ s, report }) {
  if (!report) return null;
  const logged = new Map(report.totals.byRecipe.map((r) => [r.recipeId ?? (r.blendId ? `blend:${r.blendId}` : `name:${r.name}`), r]));
  // A personal chef job or supper club is paid for up front: its dishes are ordered free, so none
  // has a possible revenue.
  const dish = (r) => (s.kind !== 'market' ? null : toDecimal(r.revenue));
  const menu = [
    ...s.recipes.map((r) => ({ key: r.recipeId, name: menuItemName(r), size: r.servingSize, unit: r.servingUnit, made: Number(r.expectedServings), possible: dish(r) })),
    ...s.sauces.map((b) => ({ key: `blend:${b.blendId}`, name: b.name, sauce: true, made: Number(b.expectedServings), possible: dish(b) })),
  ];
  const onMenu = new Set(menu.map((m) => m.key));
  // Sold here but since taken off the menu (or deleted): nothing was planned for them.
  const offMenu = [...logged.entries()].filter(([key]) => !onMenu.has(key)).map(([key, r]) => ({ key, name: r.name, sauce: !!r.blendId, made: null, possible: null }));
  const rows = [...menu, ...offMenu].map((m) => {
    const r = logged.get(m.key);
    // Paid up front, every order is free: those are the servings that went out, not given away.
    const prepaid = s.kind !== 'market';
    return { ...m, sold: (r?.sold ?? 0) + (prepaid ? r?.givenAway ?? 0 : 0), givenAway: prepaid ? 0 : r?.givenAway ?? 0, revenue: toDecimal(r?.revenue ?? 0) };
  });
  if (!rows.length) return null;
  const sum = (f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
  const total = {
    made: sum((r) => r.made), sold: sum((r) => r.sold), givenAway: sum((r) => r.givenAway),
    revenue: toDecimal(report.totals.revenue),
    possible: menu.reduce((a, m) => (m.possible ? a.plus(m.possible) : a), new Decimal(0)),
  };
  const share = (part, whole) => (whole && Number(whole) > 0 ? Math.min(100, (Number(part) / Number(whole)) * 100) : null);
  const of = (part, whole, fmt = String) => (
    <>{fmt(part)}{whole !== null && <span className="muted"> / {fmt(whole)}</span>}</>
  );
  const bar = (pct) => pct !== null && <div className="sold-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>;
  const pctText = (pct) => (pct === null ? '—' : `${Math.round(pct)}%`);
  return (
    <section className="recorded-sales">
      <div className="section-head">
        <h3>Recorded sales</h3>
        <small className="muted">
          {report.totals.sales
            ? `From the ${report.totals.sales} sale${report.totals.sales === 1 ? '' : 's'} logged with Record sales. Anything not logged is missing, so these can run under the actual figures above.`
            : 'Nothing logged with Record sales yet.'}
        </small>
      </div>
      <div className="panel table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num" title="Servings sold out of the servings made for the event. A serving is what one tap on the POS sells, so with a size set for the event it can be several, like 3 tacos.">Servings sold / made</th>
              <th className="num hide-sm">Given away</th>
              <th className="num" title="Revenue logged out of what selling every serving made would bring in">Revenue / possible</th>
              <th className="num hide-sm" title="Logged revenue as a share of the possible revenue">Of possible</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const soldPct = share(r.sold, r.made);
              return (
                <tr key={r.key}>
                  <td>
                    {r.name}{r.sauce && <> <span className="badge">Sauce</span></>}
                    {r.made === null && <div><small className="muted">No longer on the menu</small></div>}
                    {r.givenAway > 0 && <div className="show-sm"><small className="muted">{r.givenAway} given away</small></div>}
                  </td>
                  <td className="num nowrap">
                    {of(r.sold, r.made)}
                    {r.size && <div><small className="muted">{qty(toDecimal(r.size).times(r.sold), 2)} / {amountLabel(toDecimal(r.size).times(r.made), r.unit)}</small></div>}
                    {bar(soldPct)}
                  </td>
                  <td className="num hide-sm">{r.givenAway || '—'}</td>
                  <td className="num nowrap">{of(r.revenue, r.possible, money)}{bar(share(r.revenue, r.possible))}</td>
                  <td className="num hide-sm">{pctText(share(r.revenue, r.possible))}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="num nowrap">{of(total.sold, total.made)}</td>
              <td className="num hide-sm">{total.givenAway || '—'}</td>
              <td className="num nowrap">{of(total.revenue, total.possible, money)}</td>
              <td className="num hide-sm">{pctText(share(total.revenue, total.possible))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {!toDecimal(report.totals.fees).isZero() && (
        <p className="muted">Customers also paid {money(report.totals.fees)} in Venmo and Cash App fees, which those apps keep; revenue leaves them out.</p>
      )}
    </section>
  );
}

/**
 * The shopping list as printed: one dense table grouped by category, with a box to tick
 * per line. Shown only in print (see styles.css).
 */
function PrintedList({ s, title, day, guests }) {
  // Water comes from the tap; a line zeroed out (all in stock) goes under Inventory, at the end.
  const lines = groceries(s).filter((l) => !TAP_WATER.test(l.name.trim()));
  const groups = new Map();
  for (const l of lines) {
    const key = l.packsSet && toDecimal(l.packsToBuy).isZero() ? INVENTORY
      : l.blendId ? (l.category === 'Sauce' ? 'Sauces to make' : 'Spice blends to make') : l.category || 'Other';
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const last = (g) => (g === INVENTORY ? 2 : g === 'Other' ? 1 : 0);
  const order = [...groups.keys()].sort((a, b) => last(a) - last(b) || a.localeCompare(b));
  const total = sumOf(lines, 'purchaseCost');
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
                  {group === INVENTORY ? 'In stock' : l.blendId
                    ? `${l.packsToBuy} batch${l.packsToBuy === '1' ? '' : 'es'} (${qty(l.packSize, 2)} ${l.uom})`
                    : l.packSize ? `${l.packsToBuy} × ${pack(l.packSize, l.uom, 2)}` : '—'}
                </td>
                <td className="num nowrap">{qty(l.amount, 2)} {l.uom}</td>
                <td className="num">{l.purchaseCost && group !== INVENTORY ? money(l.purchaseCost) : '—'}</td>
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

/** Where and when an ingredient's price is from: "H Mart, Oct 1, 2026". */
const bought = (l) => [l.vendor, date(l.priceDate)].filter(Boolean).join(', ');

// The shopping list's columns, each sortable: `value` is what it sorts by (a number for `num`
// columns), `first` the direction a click starts in (largest first for amounts and money).
const SHOP_COLUMNS = [
  { key: 'name', label: 'Ingredient', first: 1, value: (l) => l.name },
  { key: 'bought', label: 'Bought', wide: true, first: 1, title: 'Where and when the latest price is from', value: (l) => (l.priceDate ? `${l.vendor ?? '\uffff'}\u0000${l.priceDate}` : null) },
  { key: 'amount', label: 'Needed', num: true, first: -1, title: "Total amount used across recipes, in the ingredient's unit of measurement", value: (l) => l.amount },
  { key: 'packs', label: 'Packs to buy', short: 'Packs', num: true, first: -1, title: "Whole store packs, at the latest purchase's pack size. Type over one for what's in stock or a spare.", value: (l) => l.packsToBuy },
  { key: 'packSize', label: 'Pack size', wide: true, num: false, numeric: true, first: -1, value: (l) => l.packSize },
  { key: 'purchaseCost', label: 'Total cost', num: true, first: -1, title: "Packs to buy × the latest pack price: what you'll pay", value: (l) => l.purchaseCost },
  { key: 'usedCost', label: 'Used cost', wide: true, num: true, first: -1, title: "Cost of the amount the recipes use; matches the recipes' total cost", value: (l) => l.usedCost },
  { key: 'recipes', label: 'Used in', wide: true, first: 1, value: (l) => l.recipes.join(', ') },
];

/** Compares two shopping lines by a column (both have a value in it). */
function compareShop(a, b, col) {
  const [x, y] = [col.value(a), col.value(b)];
  if (col.num || col.numeric) return (toDecimal(x) ?? new Decimal(0)).comparedTo(toDecimal(y) ?? new Decimal(0));
  return String(x).localeCompare(String(y), undefined, { sensitivity: 'base' });
}

/**
 * Packs to buy on the shopping list, typed over by the chef (stock on hand, a spare); leaving the
 * box saves it, and Total cost follows. Blank, or Reset, goes back to whole packs covering what's
 * needed. Blend batches aren't set this way.
 */
function PacksInput({ eventId, line }) {
  const shown = line.packsToBuy;
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const send = async (method, body) => {
    setError(null);
    try {
      await api(`/events/${eventId}/packs/${line.ingredientId}`, { method, body });
      notifyDataChanged();
    } catch (err) {
      setError(err.message);
    }
    setDraft(null);
  };
  const save = () => {
    if (draft === null || draft.trim() === shown) return setDraft(null);
    if (draft.trim() === '') return line.packsSet ? send('DELETE') : setDraft(null);
    const d = toDecimal(draft);
    if (!d || d.lt(0)) return setError('Enter 0 or more');
    return send('PUT', { packs: d.toString() });
  };
  return (
    <div className="packs-input">
      <input className="input num" inputMode="decimal" value={draft ?? shown} aria-label={`Packs of ${line.name} to buy`} aria-invalid={!!error}
        title="Type over it for what's in stock or a spare; Total cost follows"
        onChange={(e) => setDraft(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(null); setError(null); } }} />
      {line.packsSet && (
        <small className="muted">
          calc. {line.calculatedPacks}{' '}
          <button type="button" className="link-btn" onClick={() => send('DELETE')} aria-label={`Reset ${line.name} to ${line.calculatedPacks} packs`}>Reset</button>
        </small>
      )}
      {error && <small style={{ color: 'var(--tomato)' }}>{error}</small>}
    </div>
  );
}

/**
 * The event's labor hours or hourly rate, typed in on Financials (as "5 hrs × $20.00/hr"); leaving
 * the box saves it. A blank rate clears it; hours can't be blank.
 */
export function LaborInput({ eventId, field, value }) {
  const hours = field === 'hours';
  const shown = value === null ? '' : hours ? toDecimal(value).toDecimalPlaces(2).toString() : toDecimal(value).toFixed(2);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const save = async () => {
    if (draft === null || draft.trim() === shown) return setDraft(null);
    const d = toDecimal(draft.replace(/^\$/, ''));
    if (draft.trim() === '' ? hours : !d || d.lt(0)) return setError(hours ? 'Enter 0 or more' : 'Enter an amount, or leave it blank');
    setError(null);
    try {
      await api(`/events/${eventId}/labor`, { method: 'PUT', body: { [field]: draft.trim() === '' ? '' : d.toString() } });
      notifyDataChanged();
    } catch (err) {
      setError(err.message);
    }
    setDraft(null);
  };
  // Kept narrow: the unit sits inside the box.
  return (
    <div className="needed-input">
      <span className="labor-input">
        {!hours && <span aria-hidden="true">× $</span>}
        <span className={`unit-input${hours ? '' : ' rate'}`}>
          <input className="input num" inputMode="decimal" value={draft ?? shown} placeholder={hours ? '0' : '0.00'}
            aria-label={hours ? 'Labor hours' : 'Labor rate, dollars per hour'} aria-invalid={!!error}
            onChange={(e) => setDraft(e.target.value)} onBlur={save}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(null); setError(null); } }} />
          <span aria-hidden="true">{hours ? 'hrs' : '/hr'}</span>
        </span>
      </span>
      {error && <small style={{ color: 'var(--tomato)' }}>{error}</small>}
    </div>
  );
}

/**
 * What to buy (labor isn't bought: it's set on Financials).
 */
export function ShoppingList({ s, eventId, title, date: day, guests }) {
  const lines = groceries(s);
  const purchaseCost = sumOf(lines, 'purchaseCost');
  const usedCost = sumOf(lines, 'usedCost');
  const adjusted = toDecimal(s.packsAdjustment) ?? new Decimal(0); // from packs typed over
  const [viewing, setViewing] = useState(null); // ingredient id whose detail panel is open
  const [sort, setSort] = useState({ key: 'name', dir: 1 });
  const toggleSort = (c) => setSort((was) => ({ key: c.key, dir: was.key === c.key ? -was.dir : c.first }));
  const col = SHOP_COLUMNS.find((c) => c.key === sort.key);
  // A line with nothing in the column goes last either way; ties stay in name order.
  const blank = (l) => col.value(l) == null;
  const sorted = lines.slice().sort((a, b) => (blank(a) - blank(b)) || (blank(a) ? 0 : sort.dir * compareShop(a, b, col)) || a.name.localeCompare(b.name));
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
            {SHOP_COLUMNS.map((c) => (
              <th key={c.key} className={[c.num && 'num', c.wide && 'hide-sm'].filter(Boolean).join(' ') || undefined} title={c.title}
                aria-sort={sort.key === c.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
                <button type="button" className="sort-btn" onClick={() => toggleSort(c)}>
                  {c.short ? <><span className="hide-sm">{c.label}</span><span className="show-sm">{c.short}</span></> : c.label}
                  {sort.key === c.key && (sort.dir > 0 ? <Icon.up /> : <Icon.down />)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((l) => (
            <tr key={l.key} className={l.packsSet ? 'packs-set' : undefined}>
              <td style={{ fontWeight: 600 }}>
                {l.ingredientId
                  ? <button type="button" className="line-name" data-tip="View/edit" aria-label={`${l.name}: view/edit`} onClick={() => setViewing(l.ingredientId)}>{l.name}</button>
                  : l.name}
                {l.missingPrice && <> <span className="badge warn">No price</span></>}
                {l.blendId && <div><small className="muted" style={{ fontWeight: 400 }}>{l.category ?? 'Spice blend'}: make {l.packsToBuy} batch{l.packsToBuy === '1' ? '' : 'es'}</small></div>}
                {/* On a phone the Bought and Used in columns are hidden; they go under the name. */}
                {l.ingredientId && l.priceDate && <div className="show-sm"><small className="muted" style={{ fontWeight: 400 }}>{bought(l)}</small></div>}
                <div className="show-sm"><small className="muted" style={{ fontWeight: 400 }}>{l.recipes.join(', ')}</small></div>
              </td>
              <td className="hide-sm">
                {l.ingredientId && l.priceDate
                  ? <>{l.vendor ?? <span className="muted">No store</span>}<div><small className="muted">{date(l.priceDate)}</small></div></>
                  : <span className="muted">—</span>}
              </td>
              <td className="num nowrap">{qty(l.amount, 2)} {l.uom}</td>
              <td className="num" style={{ fontWeight: 700 }}>
                {l.ingredientId ? <PacksInput key={`${l.key}:${l.packsToBuy}`} eventId={eventId} line={l} /> : l.packsToBuy}
                {l.packSize && <div className="show-sm"><small className="muted" style={{ fontWeight: 400 }}>× {pack(l.packSize, l.uom, 2)}</small></div>}
              </td>
              <td className="nowrap hide-sm">{l.packSize ? `${pack(l.packSize, l.uom, 2)}${l.blendId ? ' batch' : ''}` : '—'}</td>
              <td className="num" style={{ fontWeight: 650 }}>{l.purchaseCost ? money(l.purchaseCost) : '—'}</td>
              <td className="num hide-sm">{money(l.usedCost)}</td>
              <td className="muted hide-sm">{l.recipes.join(', ')}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="shop-total">
          <tr>
            <td>Total <span className="muted" style={{ fontWeight: 500 }}>({lines.length} items)</span></td><td className="hide-sm" /><td /><td /><td className="hide-sm" />
            <td className="num">
              {money(purchaseCost)}
              {!adjusted.isZero() && (
                <div className="packs-adjust" title="Packs to buy typed over above: what that changed the total by">
                  <small>{money(purchaseCost.minus(adjusted))} calculated</small>
                  <small>{adjusted.lt(0) ? '−' : '+'}{money(adjusted.abs())} from edits</small>
                </div>
              )}
              {/* The Used cost column is hidden on a phone; its total goes here. */}
              <div className="show-sm"><small className="muted" style={{ fontWeight: 600 }}>Used {money(usedCost)}</small></div>
            </td>
            <td className="num hide-sm">{money(usedCost)}</td><td className="hide-sm" />
          </tr>
        </tfoot>
      </table>
    </div>
      {viewing && <IngredientDrawer id={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
