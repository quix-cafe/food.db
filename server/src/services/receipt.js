// Normalise receipt JSON produced by an external extractor (e.g. qwen) into the
// purchase rows used by the "Review & Confirm" grid. Nothing is saved here.
//
// Extractors disagree on key names, so common variants are accepted, e.g.
//   { merchant | vendor | store_name | MerchantName,
//     date | Date,
//     items | Items | line_items: [{ name | description | Description,
//                                    quantity | qty, unit,
//                                    unit_price | unitCost | price_per_unit,
//                                    total | price | Price | amount | line_total }],
//     total | total_amount | TotalAmount }

import { toDecimal, Decimal } from '@kitchen/shared';
import { badRequest } from '../validate.js';

const KEYS = {
  vendor: ['vendor', 'merchant', 'store_name', 'store', 'merchantname', 'supplier'],
  date: ['date', 'purchase_date', 'transaction_date'],
  items: ['items', 'line_items', 'lineitems', 'products'],
  total: ['total', 'total_amount', 'totalamount', 'grand_total'],
  name: ['name', 'description', 'item', 'product'],
  quantity: ['quantity', 'qty', 'count'],
  unit: ['unit', 'uom', 'unit_of_measurement'],
  unitCost: ['unit_price', 'unitprice', 'unit_cost', 'unitcost', 'price_per_unit'],
  totalCost: ['total', 'line_total', 'linetotal', 'amount', 'price', 'total_cost', 'totalcost'],
};

const norm = (k) => k.toLowerCase().replace(/[\s-]/g, '_');

/** Read the first present key from `obj`, matching names case-insensitively. */
function pick(obj, field) {
  if (!obj || typeof obj !== 'object') return undefined;
  const wanted = new Set(KEYS[field].map(norm));
  const alt = new Set(KEYS[field].map((k) => norm(k).replace(/_/g, '')));
  for (const [k, v] of Object.entries(obj)) {
    const n = norm(k);
    if ((wanted.has(n) || alt.has(n.replace(/_/g, ''))) && v !== null && v !== undefined && v !== '') return v;
  }
  return undefined;
}

/** "$4.25", "4,25", 4.25 → Decimal; null if not a non-negative number. */
function money(v) {
  if (typeof v === 'string') v = v.replace(/[^\d.,-]/g, '').replace(/,(\d{1,2})$/, '.$1').replace(/,/g, '');
  const d = toDecimal(v);
  return d && d.gte(0) ? d : null;
}

function isoDate(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s); // US receipts: MM/DD/YY(YY)
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

export function normalizeReceipt(raw) {
  if (Array.isArray(raw)) raw = { items: raw };
  if (!raw || typeof raw !== 'object') throw badRequest('Receipt JSON must be an object or a list of items');

  const rawItems = pick(raw, 'items');
  if (rawItems !== undefined && !Array.isArray(rawItems)) throw badRequest('Receipt “items” must be a list');

  const warnings = [];
  const items = (rawItems ?? [])
    .map((it) => {
      const name = pick(it, 'name');
      if (typeof name !== 'string' || !name.trim()) return null;
      const q = money(pick(it, 'quantity'));
      const quantity = q && !q.isZero() ? q : new Decimal(1);
      let unitCost = money(pick(it, 'unitCost'));
      let totalCost = money(pick(it, 'totalCost'));
      if (!unitCost && totalCost) unitCost = totalCost.div(quantity);
      if (!totalCost && unitCost) totalCost = unitCost.times(quantity);
      const unit = pick(it, 'unit');
      return {
        name: name.trim(),
        quantity: quantity.toString(),
        unit: typeof unit === 'string' && unit.trim() ? unit.trim() : null,
        unitCost: unitCost ? unitCost.toDecimalPlaces(4).toString() : null,
        totalCost: totalCost ? totalCost.toDecimalPlaces(4).toString() : null,
      };
    })
    .filter(Boolean);

  const skipped = (rawItems?.length ?? 0) - items.length;
  if (skipped > 0) warnings.push(`${skipped} line${skipped === 1 ? ' had' : 's had'} no item name and ${skipped === 1 ? 'was' : 'were'} skipped.`);
  if (!items.length) warnings.push('No line items were found. Add them manually below.');

  const printedTotal = money(pick(raw, 'total'));
  if (printedTotal && items.length) {
    const sum = items.reduce((acc, it) => acc.plus(it.totalCost ?? 0), new Decimal(0));
    if (!sum.toDecimalPlaces(2).eq(printedTotal.toDecimalPlaces(2))) {
      warnings.push(`Line items add up to ${sum.toFixed(2)} but the receipt total is ${printedTotal.toFixed(2)}. Tax, deposits or a missed line can explain this.`);
    }
  }

  const vendor = pick(raw, 'vendor');
  return {
    vendor: typeof vendor === 'string' && vendor.trim() ? vendor.trim() : null,
    date: isoDate(pick(raw, 'date')),
    printedTotal: printedTotal ? printedTotal.toFixed(2) : null,
    items,
    warnings,
  };
}
