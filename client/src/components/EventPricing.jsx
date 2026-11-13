import { useState } from 'react';
import { eventPricing } from '@kitchen/shared';
import { api, notifyDataChanged } from '../api.js';
import { money, toDecimal } from '../format.js';

// A recipe's price at one event, edited in the event planner's recipe table and the
// "Add to event" dialog. Values are the text typed; '' means "not set".

export const blankOrPrice = (v) => v.trim() === '' || (toDecimal(v.replace(/[$,]/g, ''))?.gte(0) ?? false);
/** A whole number, 0 or more. */
export const isInt = (v) => /^\d+$/.test(String(v).trim());
export const priceText = (v) => v.replace(/[$,]/g, '').trim();
/** What's wrong with a deal as typed, or null. Both blank is no deal. */
export function dealProblem({ dealQty, dealPrice }) {
  const qty = dealQty.trim();
  const price = priceText(dealPrice);
  if (!qty && !price) return null;
  if (!qty || !price) return 'A deal needs how many and a price, like 3 for $15';
  if (!/^\d+$/.test(qty) || Number(qty) < 2) return 'A deal is for 2 or more servings';
  return toDecimal(price)?.gt(0) ? null : 'A deal’s price must be an amount above 0';
}

/** What the pricing typed so far works out to; null while something is invalid. */
export function pricingFor(recipe, p = {}) {
  try {
    return eventPricing({
      costPerServing: recipe.costPerServing,
      recommendedPrice: recipe.recommendedPrice,
      salePrice: p.salePrice ? priceText(p.salePrice) : null,
      dealPrice: p.dealPrice ? priceText(p.dealPrice) : null,
      dealQty: p.dealPrice && p.dealQty?.trim() || null,
    });
  } catch {
    return null;
  }
}

/**
 * Sale price per serving. Blank (`value` '') follows the recipe's target price, which is what
 * the box shows until it's changed; clearing the box goes back to it. `onSetRecipePrice`, where given,
 * also offers to make this the recipe's own price.
 */
export function SalePriceInput({ value, recipePrice, onChange, onSetRecipePrice, label, id }) {
  const [draft, setDraft] = useState(null);
  const [adopted, setAdopted] = useState(null); // made the recipe's price, ahead of `recipePrice` catching up
  const [error, setError] = useState(null);
  const recipeText = recipePrice == null ? '' : toDecimal(recipePrice).toFixed(2);
  // The draft only matters while the box is being cleared; any other text is already `value`, which may also change from another window.
  const shown = draft !== null && draft.trim() === '' ? draft : (value !== '' ? value : recipeText);
  const typed = toDecimal(priceText(value));
  const set = value !== '' && !typed?.eq(recipeText || -1) && value !== adopted;
  const setRecipePrice = async () => {
    setError(null);
    try {
      await onSetRecipePrice(priceText(value));
      setAdopted(value);
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <span className="sale-price">
      <span className="money-input">
        <span aria-hidden="true">$</span>
        <input id={id} className="input num" inputMode="decimal" value={shown} aria-label={label} aria-invalid={!blankOrPrice(shown)}
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value.trim() !== '') onChange(e.target.value);
          }}
          onBlur={() => {
            if (draft !== null && draft.trim() === '') onChange('');
            setDraft(null);
          }} />
      </span>
      {set && recipeText && (
        <small className="muted sale-price-note">
          Recipe {money(recipePrice)} · <button type="button" className="link-btn" onClick={() => { setDraft(null); setError(null); onChange(''); }}>Use it</button>
          {onSetRecipePrice && typed?.gt(0) && <span className="nowrap"> or <button type="button" className="link-btn set-new" onClick={setRecipePrice}>Set new price</button></span>}
        </small>
      )}
      {set && error && <small className="sale-price-error" role="alert">{error}</small>}
    </span>
  );
}

/** An optional deal: `qty` servings for `price`, "3 for $15". */
function DealInput({ qty, price, onChange, label, autoFocus = false }) {
  return (
    <span className="deal-input" title="For a deal like 3 for $15: how many, and what they cost together">
      <input className="input num deal-qty" inputMode="numeric" value={qty} placeholder="3" autoFocus={autoFocus} aria-label={`${label}: how many for the discount price`}
        onChange={(e) => onChange({ dealQty: e.target.value, dealPrice: price })} />
      <span className="muted nowrap">for</span>
      <span className="money-input">
        <span aria-hidden="true">$</span>
        <input className="input num" inputMode="decimal" value={price} placeholder="15.00" aria-label={`${label}: discount price`}
          aria-invalid={!blankOrPrice(price)} onChange={(e) => onChange({ dealQty: qty, dealPrice: e.target.value })} />
      </span>
    </span>
  );
}

/**
 * A deal that stays out of the way: a checkbox, with the inputs only once it's ticked. Ticking fills in
 * the deal last entered for the recipe (`saved`); unticking removes it from this event and remembers
 * what it said, at once, since the autosave that would have told the server may never have run.
 */
export function DealToggle({ qty, price, saved, onChange, label, note }) {
  const [ticked, setOpen] = useState(false);
  const open = ticked || price !== '' || qty !== ''; // a deal can also arrive from another window
  const [typing, setTyping] = useState(false); // ticked with nothing to fill in, so how many is what comes next
  const [last, setLast] = useState(null); // what was unticked here, ahead of `saved` catching up
  const tick = (on) => {
    const fill = last ?? (saved?.dealQty ? { dealQty: String(saved.dealQty), dealPrice: toDecimal(saved.dealPrice).toFixed(2) } : null);
    setOpen(on);
    setTyping(on && !fill);
    if (on) {
      if (fill) onChange(fill);
      return;
    }
    onChange({ dealQty: '', dealPrice: '' });
    if (qty.trim() && !dealProblem({ dealQty: qty, dealPrice: price })) {
      const entered = { dealQty: qty.trim(), dealPrice: priceText(price) };
      setLast(entered);
      if (saved?.id) api(`/recipes/${saved.id}/deal`, { method: 'PUT', body: entered }).then(notifyDataChanged, () => {}); // only a convenience: the event's own save reports any trouble
    }
  };
  return (
    <span className="deal-toggle-cell">
      <input type="checkbox" className="deal-check" checked={open} aria-label={`${label}: has a discount`} onChange={(e) => tick(e.target.checked)} />
      {open && <DealInput qty={qty} price={price} label={label} autoFocus={typing} onChange={onChange} />}
      {open && note && <small className="deal-note">{note}</small>}
    </span>
  );
}

/** Why a complete deal won't apply: it has to be cheaper than the servings at their price. */
export function dealNote(p, pricing) {
  if (!pricing || pricing.dealQty || !p.dealPrice.trim() || !p.dealQty.trim() || dealProblem(p)) return null;
  return `${p.dealQty.trim()} at ${money(pricing.salePrice)} is ${money(toDecimal(pricing.salePrice).times(p.dealQty.trim()))}, so this won’t apply`;
}

/** Margin per serving after any discount, with its percent of the net price. */
export function MarginCell({ pricing }) {
  if (!pricing) return <span className="muted">—</span>;
  const m = toDecimal(pricing.marginPerServing);
  return (
    <span className={m.lt(0) ? 'price-up' : ''} title={pricing.dealQty ? `After the discount (${money(pricing.netPrice)} a serving net), as if every serving sells on the deal` : undefined}>
      {money(m)}
      {pricing.marginPercent != null && <small className="muted"> · {pricing.marginPercent}%</small>}
    </span>
  );
}
