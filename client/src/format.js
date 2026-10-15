import { Decimal, toDecimal } from '@kitchen/shared';

const CURRENCY = 'USD';
const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: CURRENCY });

/** Format a decimal string as currency without passing through a float. */
export function money(value, dp = 2) {
  const d = toDecimal(value);
  if (!d) return '—';
  const fmt = dp === 2 ? moneyFmt : new Intl.NumberFormat('en-US', { style: 'currency', currency: CURRENCY, minimumFractionDigits: 2, maximumFractionDigits: dp });
  return fmt.format(d.toFixed(dp));
}

/** Unit costs keep up to 4 places but drop trailing zeros past the cents. */
export function unitMoney(value) {
  const d = toDecimal(value);
  if (!d) return '—';
  const dp = Math.max(2, Math.min(4, d.decimalPlaces()));
  return money(d.toDecimalPlaces(dp), dp);
}

/** A measurement with at most `dp` decimal places, e.g. "1,250.5". */
export function qty(value, dp = 3) {
  const d = toDecimal(value);
  return d ? new Intl.NumberFormat('en-US', { maximumFractionDigits: dp }).format(d.toDecimalPlaces(dp).toString()) : '—';
}

/** A store pack in the ingredient's unit of measure, e.g. "36 lb". */
export function pack(size, uom, dp) {
  return `${qty(size ?? 1, dp)} ${uom ?? 'each'}`;
}

/**
 * Price per unit of measure, to the nearest cent, e.g. "$3.13 / lb". A price too small to
 * show in cents (a pinch of salt) keeps its decimals rather than reading "$0.00". Costing
 * always keeps full precision.
 */
export function perUnit(price, uom) {
  const d = toDecimal(price);
  const tiny = d && d.gt(0) && d.toDecimalPlaces(2).isZero();
  return `${tiny ? unitMoney(d) : money(price)} / ${uom ?? 'each'}`;
}

export function percent(value, dp = 1) {
  const d = toDecimal(value);
  return d ? `${d.toDecimalPlaces(dp).toString()}%` : '—';
}

export function signedPercent(value) {
  const d = toDecimal(value);
  if (!d) return '—';
  return `${d.gt(0) ? '+' : ''}${d.toFixed(1)}%`;
}

export function date(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function dateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const todayIso = () => new Date().toLocaleDateString('en-CA');

export { Decimal, toDecimal };
