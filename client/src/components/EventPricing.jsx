import { useState } from 'react';
import { eventPricing } from '@kitchen/shared';
import { money, toDecimal } from '../format.js';

// A recipe's price at one event, edited in the event planner's recipe table and the
// "Add to event" dialog. Values are the text typed; '' means "not set".

export const blankOrPrice = (v) => v.trim() === '' || (toDecimal(v.replace(/[$,]/g, ''))?.gte(0) ?? false);
/** A whole number, 0 or more. */
export const isInt = (v) => /^\d+$/.test(String(v).trim());
export const blankOrCount = (v) => v.trim() === '' || /^[1-9]\d*$/.test(v.trim());
export const priceText = (v) => v.replace(/[$,]/g, '').trim();

/** What the pricing typed so far works out to; null while something is invalid. */
export function pricingFor(recipe, p = {}) {
  try {
    return eventPricing({
      costPerServing: recipe.costPerServing,
      recommendedPrice: recipe.recommendedPrice,
      salePrice: p.salePrice ? priceText(p.salePrice) : null,
      discountAmount: p.discountAmount ? priceText(p.discountAmount) : null,
      discountQty: p.discountQty?.trim() || null,
    });
  } catch {
    return null;
  }
}

/**
 * Sale price per serving. Blank (`value` '') follows the recipe's target price, which is what
 * the box shows until it's changed; clearing the box goes back to it.
 */
export function SalePriceInput({ value, recipePrice, onChange, label, id }) {
  const [draft, setDraft] = useState(null);
  const recipeText = recipePrice == null ? '' : toDecimal(recipePrice).toFixed(2);
  const shown = draft ?? (value !== '' ? value : recipeText);
  const set = value !== '' && !(toDecimal(priceText(value))?.eq(recipeText || -1));
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
        <small className="muted nowrap">
          Recipe {money(recipePrice)} · <button type="button" className="link-btn" onClick={() => { setDraft(null); onChange(''); }}>Use it</button>
        </small>
      )}
    </span>
  );
}

/** An optional deal: `amount` off every `qty` servings ("buy 2, get $1 off"); a blank count is per serving. */
export function DealInput({ amount, qty, onChange, label }) {
  return (
    <span className="deal-input" title="For a deal like “buy 2, get $1 off”: $1.00 off per 2 servings">
      <span className="money-input">
        <span aria-hidden="true">$</span>
        <input className="input num" inputMode="decimal" value={amount} placeholder="0.00" aria-label={`${label}: discount amount`}
          aria-invalid={!blankOrPrice(amount)} onChange={(e) => onChange({ discountAmount: e.target.value, discountQty: qty })} />
      </span>
      <span className="muted nowrap">off per</span>
      <input className="input num deal-qty" inputMode="numeric" value={qty} placeholder="1" aria-label={`${label}: discount applies per this many servings`}
        aria-invalid={!blankOrCount(qty)} onChange={(e) => onChange({ discountAmount: amount, discountQty: e.target.value })} />
    </span>
  );
}

/** Margin per serving after any discount, with its percent of the net price. */
export function MarginCell({ pricing }) {
  if (!pricing) return <span className="muted">—</span>;
  const m = toDecimal(pricing.marginPerServing);
  return (
    <span className={m.lt(0) ? 'price-up' : ''} title={pricing.discountAmount ? `After the discount (${money(pricing.netPrice)} a serving net), as if every serving sells on the deal` : undefined}>
      {money(m)}
      {pricing.marginPercent != null && <small className="muted"> · {pricing.marginPercent}%</small>}
    </span>
  );
}
