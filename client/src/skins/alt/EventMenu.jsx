// The event's menu as a board of what each dish brings in. A line reads as a sum, servings × price
// = what it takes, with a bar for that take against the biggest dish and the food's cost filled in.
// The boxes used most (servings, price) are on the line; size, deal and removal open under it.
import { useState } from 'react';
import { Link } from 'react-router';
import { SAUCE_CONTAINERS, amountLabel, eventPricing, eventServing, parseAmount } from '@kitchen/shared';
import { Decimal, money, qty, toDecimal } from '../../format.js';
import { Icon } from '../../components/ui.jsx';
import { DealToggle, SalePriceInput, dealNote, isInt, priceText, pricingFor } from '../../components/EventPricing.jsx';
import { blankOrSize, containerOf, containersOf, isCount, noPricing } from '../../pages/EventPlanner.jsx';

/** A whole number with − and + either side; the box still takes typing. */
export function Stepper({ value, onChange, label, invalid, min = 0 }) {
  const n = isInt(value) ? Number(value) : null;
  const bump = (by) => onChange(String(Math.max(min, (n ?? min) + by)));
  return (
    <span className="stepper">
      <button type="button" aria-label={`One fewer: ${label}`} disabled={n == null || n <= min} onClick={() => bump(-1)}>−</button>
      <input className="input num" inputMode="numeric" value={value} aria-label={label} aria-invalid={invalid} onChange={(e) => onChange(e.target.value)} />
      <button type="button" aria-label={`One more: ${label}`} onClick={() => bump(1)}>+</button>
    </span>
  );
}

/** What a market dish takes at the servings and pricing typed so far; null while something is invalid. */
function marketTake(costed, p, servings) {
  if (!costed || !isInt(servings)) return null;
  try {
    const pricing = eventPricing({
      costPerServing: costed.costPerServing,
      recommendedPrice: costed.recommendedPrice,
      salePrice: p.salePrice ? priceText(p.salePrice) : null,
      dealPrice: p.dealPrice ? priceText(p.dealPrice) : null,
      dealQty: (p.dealPrice && p.dealQty?.trim()) || null,
      expectedServings: servings,
    });
    const revenue = new Decimal(pricing.revenue);
    const cost = (toDecimal(costed.costPerServing) ?? new Decimal(0)).times(servings);
    return { revenue, cost, profit: revenue.minus(cost), perServing: pricing };
  } catch {
    return null;
  }
}

/** The take as a bar: as long as its share of the biggest dish's, the food's cost filled in. */
function TakeBar({ take, most }) {
  if (!take || !most.gt(0)) return <span className="take-bar none" aria-hidden="true" />;
  const width = Math.max(2, take.revenue.div(most).times(100).toNumber());
  const food = take.revenue.gt(0) ? Math.min(100, take.cost.div(take.revenue).times(100).toNumber()) : 100;
  return (
    <span className="take-bar" role="img" aria-label={`Food is ${food.toFixed(0)}% of its revenue`} title={`${money(take.cost)} of food in ${money(take.revenue)}`}>
      <span style={{ width: `${width}%` }}><i style={{ width: `${food}%` }} /></span>
    </span>
  );
}

function Take({ take, pending }) {
  if (!take) return <span className="d-take muted">—</span>;
  return (
    <span className={`d-take ${pending ? 'pending' : ''}`}>
      <b>{money(take.revenue)}</b>
      <small className={take.profit.lt(0) ? 'loss' : ''}>{take.profit.lt(0) ? `loss ${money(take.profit.abs())}` : `profit ${money(take.profit)}`}</small>
    </span>
  );
}

/**
 * `plan` is useEventPlan's; `summed` the saved summary's rows by key (a flat-rate event's shares come
 * from there, so they follow once a change saves: `pending`).
 */
export default function EventMenu({ plan, dishes, jars, colors, flat, pool, summed, pending }) {
  const { form, toggle, toggleSauce, setServings, setPrice, setSauce, setSauceMake, saveOwnPrice } = plan;
  const [open, setOpen] = useState(() => new Set());
  const flip = (key) => setOpen((was) => { const next = new Set(was); if (!next.delete(key)) next.add(key); return next; });

  // Every line worked out first, so the bars can be drawn against the biggest take.
  const saved = (key) => {
    const row = summed.get(key);
    return row?.revenue != null ? { revenue: new Decimal(row.revenue), cost: new Decimal(row.scaledCost), profit: new Decimal(row.revenue).minus(row.scaledCost), perServing: row, share: row.share } : null;
  };
  const lines = [
    ...dishes.map((r) => {
      const p = form.prices[r.id] ?? noPricing();
      const served = eventServing(r, parseAmount(p.servingSize));
      return { key: r.id, r, p, served, take: flat ? saved(r.id) : marketTake(served, p, form.servings[r.id]) };
    }),
    ...jars.map((b) => {
      const x = form.sauces[b.id];
      const c = containerOf(b, x.container);
      const costed = c && { costPerServing: c.costPerServing ?? '0', recommendedPrice: c.recommendedPrice };
      const key = `blend:${b.id}`;
      return { key, b, x, c, costed, take: flat ? saved(key) : marketTake(costed, { salePrice: x.salePrice }, x.servings) };
    }),
  ];
  const most = lines.reduce((m, l) => (l.take && l.take.revenue.gt(m) ? l.take.revenue : m), new Decimal(0));

  const perServing = (take, costPerServing) => {
    const ps = take?.perServing;
    return (
      <small className="d-each">
        {costPerServing ? `Cost ${money(costPerServing)}` : 'No cost yet'}
        {flat && ps?.netPrice != null && <span title={`${take.share}% of the food cost, so ${take.share}% of the ${pool}`}>, revenue {money(ps.netPrice)}</span>}
        {ps?.marginPerServing != null && <>, profit <b className={toDecimal(ps.marginPerServing).lt(0) ? 'loss' : ''}>{money(ps.marginPerServing)}</b>{ps.marginPercent != null && ` (${ps.marginPercent}%)`}</>} per serving
      </small>
    );
  };

  return (
    <ul className={`dishes ${flat ? 'flat' : ''}`}>
      {lines.map(({ key, r, p, served, b, x, c, costed, take }) => {
        const isOpen = open.has(key);
        const moreId = `more-${key}`;
        if (r) {
          const sized = p.servingSize.trim() !== '' && blankOrSize(p.servingSize);
          const total = sized && served.servingLabel && isInt(form.servings[r.id]);
          const deal = !flat && p.dealQty.trim() && p.dealPrice.trim();
          return (
            <li key={key} className={`dish ${isOpen ? 'open' : ''}`} style={{ '--tile': colors.get(key) }}>
              <div className="dish-line">
                <span className="d-name">
                  <Link to={`/recipes/${r.id}`}>{r.name}</Link>
                  {sized && <span className="badge new">{amountLabel(parseAmount(p.servingSize), served.unit)} each</span>}
                  {deal && <span className="badge good">{p.dealQty.trim()} for {money(priceText(p.dealPrice))}</span>}
                  {perServing(take, served.costPerServing)}
                </span>
                <span className="d-count">
                  <Stepper value={form.servings[r.id]} label={`Servings of ${r.name}`} invalid={!isInt(form.servings[r.id])} onChange={(v) => setServings(r.id, v)} />
                  <small>{total ? `${amountLabel(toDecimal(form.servings[r.id]).times(parseAmount(p.servingSize)), served.unit)} in all` : 'servings'}</small>
                </span>
                {!flat && (
                  <>
                    <span className="d-op" aria-hidden="true">×</span>
                    <span className="d-price">
                      <SalePriceInput value={p.salePrice} recipePrice={served.recommendedPrice} label={`Sale price per serving of ${r.name}`} onChange={(v) => setPrice(r.id, { salePrice: v })}
                        onSetRecipePrice={toDecimal(served.ratio).eq(1) ? (price) => saveOwnPrice(`/recipes/${r.id}/price`, { targetPrice: price }, r.name, price) : undefined} />
                    </span>
                    <span className="d-op" aria-hidden="true">=</span>
                  </>
                )}
                <Take take={take} pending={flat && pending} />
                <TakeBar take={take} most={most} />
                <button type="button" className="icon-btn d-more" aria-expanded={isOpen} aria-controls={moreId} onClick={() => flip(key)}
                  aria-label={`${isOpen ? 'Hide' : 'Show'} size${flat ? '' : ', deal'} and removal for ${r.name}`} title={flat ? 'Serving size, take off the menu' : 'Serving size, deal, take off the menu'}>
                  {isOpen ? <Icon.up /> : <Icon.down />}
                </button>
              </div>
              {isOpen && (
                <div className="dish-more" id={moreId}>
                  <label className="m-field">
                    <span>One serving is</span>
                    <span className="size-input">
                      <input className="input num" inputMode="decimal" value={p.servingSize} placeholder={qty(served.recipeSize, 2)} aria-label={`Size per serving of ${r.name}, in ${served.unit}`}
                        aria-invalid={!blankOrSize(p.servingSize)} onChange={(e) => setPrice(r.id, { servingSize: e.target.value })} />
                      <small>{served.unit}</small>
                    </span>
                    <small>Blank: the recipe’s own size. Cost and price follow it.</small>
                  </label>
                  {!flat && (
                    <div className="m-field">
                      <span>Deal, like 3 for $15</span>
                      <DealToggle qty={p.dealQty} price={p.dealPrice} saved={r} label={r.name} note={dealNote(p, pricingFor(served, p))} onChange={(patch) => setPrice(r.id, patch)} />
                    </div>
                  )}
                  <button type="button" className="btn small danger m-off" onClick={() => toggle(r)}><Icon.close /> Take off the menu</button>
                </div>
              )}
            </li>
          );
        }
        const made = x.count ?? String(containersOf(b, x));
        return (
          <li key={key} className="dish sauce" style={{ '--tile': colors.get(key) }}>
            <div className="dish-line">
              <span className="d-name">
                <Link to={`/spice-lab/${b.id}`}>{b.name}</Link> <span className="badge">Sauce</span>
                {perServing(take, c?.costPerServing)}
              </span>
              <span className="d-count">
                <span className="jar-make">
                  <Stepper value={made} min={1} label={`Containers of ${b.name}`} invalid={!isCount(made)} onChange={(v) => setSauceMake(b, { count: v })} />
                  <select className="select" value={x.container} aria-label={`Container for ${b.name}`} onChange={(e) => setSauceMake(b, { container: e.target.value, count: made })}>
                    {Object.keys(SAUCE_CONTAINERS).map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </span>
                <small title="Containers × the servings one holds">{x.servings} servings{c ? ` of ${qty(c.servingOz, 2)} oz` : ''}</small>
              </span>
              {!flat && (
                <>
                  <span className="d-op" aria-hidden="true">×</span>
                  <span className="d-price">
                    <SalePriceInput value={x.salePrice} recipePrice={c?.recommendedPrice} label={`Sale price per serving of ${b.name}`} onChange={(v) => setSauce(b.id, { salePrice: v })}
                      onSetRecipePrice={(price) => saveOwnPrice(`/blends/${b.id}/price`, { salePrice: price }, b.name, price)} />
                  </span>
                  <span className="d-op" aria-hidden="true">=</span>
                </>
              )}
              <Take take={take} pending={flat && pending} />
              <TakeBar take={take} most={most} />
              <button type="button" className="icon-btn d-more off" onClick={() => toggleSauce(b)} aria-label={`Take ${b.name} off the menu`} title="Take off the menu"><Icon.close /></button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
