// Normalise receipt JSON produced by an external extractor (e.g. qwen) into the
// purchase rows used by the "Review & Confirm" grid. Nothing is saved here.
//
// Extractors disagree on structure, so this accepts common variants:
// - vendor as a string (vendor, merchant, store_name…) or an object ({ store: { name } })
// - date at the top level or one level down ({ transaction: { date } }), ISO or MM/DD/YY(YY)
// - items as a flat list, a list of groups ({ section, entries: [...] }), or a map of
//   groups ({ sections: { Produce: [...] } }); the group name becomes the category
// - per line: name/description/item, quantity ("2.21 lb"), weight ("1.46 lb", which wins
//   over quantity: unit_price is then per lb), unit_price ("0.59/lb"),
//   quantity_detail ("2 @ $2.99 ea"), and total/price/amount
// - discount lines ({ discount: 1 } or a negative price) reduce the item above them;
//   label lines ({ label: "PRICE YOU PAY", price }) give the item above its net price;
//   lines with no amount (savings summaries, coupon info) are ignored
// - totals at the top level or under { totals: { subtotal, total } }

import { toDecimal, Decimal } from '@kitchen/shared';
import { badRequest } from '../validate.js';

const KEYS = {
  vendor: ['vendor', 'merchant', 'store_name', 'store', 'merchantname', 'supplier'],
  date: ['date', 'purchase_date', 'transaction_date'],
  items: ['items', 'line_items', 'lineitems', 'products', 'sections', 'departments', 'entries', 'lines'],
  group: ['section', 'category', 'department', 'group'],
  total: ['total', 'total_amount', 'totalamount', 'grand_total'],
  subtotal: ['subtotal', 'sub_total'],
  name: ['name', 'description', 'item', 'product', 'item_name'],
  label: ['label'],
  quantity: ['quantity', 'qty', 'count'],
  weight: ['weight', 'net_weight'],
  quantityDetail: ['quantity_detail', 'qty_detail', 'quantity_text'],
  unit: ['unit', 'uom', 'unit_of_measurement'],
  unitCost: ['unit_price', 'unitprice', 'unit_cost', 'unitcost', 'price_per_unit'],
  totalCost: ['total', 'line_total', 'linetotal', 'amount', 'price', 'total_cost', 'totalcost'],
  discount: ['discount', 'coupon', 'markdown', 'discount_amount'],
};

const norm = (k) => k.toLowerCase().replace(/[\s_-]/g, '');
const NORMALISED = Object.fromEntries(Object.entries(KEYS).map(([f, ks]) => [f, new Set(ks.map(norm))]));

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Read the first present key from `obj`, matching names case- and separator-insensitively. */
function pick(obj, field) {
  if (!isObject(obj)) return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (NORMALISED[field].has(norm(k)) && v !== null && v !== undefined && v !== '') return v;
  }
  return undefined;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** "$4.25", "4,25", "0.59/lb", -0.5 → Decimal (sign kept); null if not numeric. */
function amount(v) {
  if (typeof v === 'string') {
    const m = /(-)?\s*\$?\s*(\d[\d,]*(?:\.\d+)?)/.exec(v);
    if (!m) return null;
    const digits = /^\d+,\d{1,2}$/.test(m[2]) ? m[2].replace(',', '.') : m[2].replace(/,/g, '');
    v = (m[1] ?? '') + digits;
  }
  return toDecimal(v);
}
const positive = (v) => {
  const d = amount(v);
  return d && d.gt(0) ? d : null;
};

const fmt = (d) => `$${d.toFixed(2)}`;

function isoDate(v) {
  const s = str(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(s); // US receipts: MM/DD/YY(YY)
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

/** Look for a field at the top level, then one level down in nested objects. */
function pickDeep(raw, field) {
  const top = pick(raw, field);
  if (top !== undefined) return top;
  for (const v of Object.values(raw)) {
    const inner = pick(v, field);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

/** "CLEANING SUPPLIES" → "Cleaning Supplies"; mixed-case names are left alone. */
const tidyCategory = (s) => (s && s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s/&-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : s);

function parseLine(el, category) {
  const name = str(pick(el, 'name'));
  let unit = str(pick(el, 'unit'));
  let quantity = null;
  // A weighed line sells by its weight; its quantity, if any, is the count of items weighed.
  const q = pick(el, 'weight') ?? pick(el, 'quantity');
  if (typeof q === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/.exec(q);
    if (m) {
      quantity = toDecimal(m[1]);
      unit ??= m[2] ?? null;
    }
  } else {
    quantity = positive(q);
  }

  const uc = pick(el, 'unitCost');
  let unitCost = positive(uc);
  if (typeof uc === 'string') unit ??= /\/\s*([a-zA-Z]+)/.exec(uc)?.[1] ?? null;

  const detail = str(pick(el, 'quantityDetail'));
  const dm = detail && /(\d+(?:\.\d+)?)\s*@\s*\$?\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/.exec(detail);
  if (dm) {
    quantity ??= toDecimal(dm[1]);
    unitCost ??= toDecimal(dm[2]);
    unit ??= dm[3] ?? null;
  }

  return { name, category, unit, quantity, unitCost, total: amount(pick(el, 'totalCost')) };
}

function childList(el) {
  const children = pick(el, 'items');
  return children !== undefined && (Array.isArray(children) || isObject(children)) ? children : null;
}

function walkCollection(coll, category, ctx) {
  if (Array.isArray(coll)) return walkList(coll, category, ctx);
  if (isObject(coll)) {
    for (const [group, list] of Object.entries(coll)) {
      if (Array.isArray(list) || isObject(list)) walkCollection(list, group, ctx);
    }
  }
}

function walkList(list, category, ctx) {
  let prev = null; // discounts and "price you pay" lines refer to the item above them
  for (const el of list) {
    if (!isObject(el)) continue;

    const children = childList(el);
    if (children) {
      walkCollection(children, str(pick(el, 'group')) ?? category, ctx);
      prev = null;
      continue;
    }

    const line = parseLine(el, category);
    const ownDiscount = positive(pick(el, 'discount'));

    // A discount/coupon line: reduce the item above.
    const discount = ownDiscount ?? (line.total?.lt(0) ? line.total.neg() : null);
    if (discount && !(line.total?.gt(0))) {
      if (prev) applyDiscount(prev, discount, line.name, ctx);
      else ctx.warnings.push(`A ${fmt(discount)} discount (“${line.name ?? 'unnamed'}”) has no item above it and was not applied.`);
      continue;
    }

    if (!line.name) {
      const label = str(pick(el, 'label'));
      if (label && line.total && prev) {
        // e.g. "PRICE YOU PAY": the net price of the item above.
        if (!prev.total.eq(line.total)) {
          prev.notes.push(`“${label}” ${fmt(line.total)} used instead of ${fmt(prev.total)}`);
          setTotal(prev, line.total);
          prev.adjusted = true;
        }
      } else if (line.total) {
        ctx.skipped += 1;
      }
      continue;
    }

    // Informational lines carry no amount (savings summaries, coupon descriptions).
    if (!line.total && !line.unitCost) continue;

    const quantity = line.quantity && !line.quantity.isZero() ? line.quantity : new Decimal(1);
    const item = {
      name: line.name,
      category: tidyCategory(line.category),
      unit: line.unit,
      quantity,
      unitCost: line.unitCost ?? line.total.div(quantity),
      total: line.total ?? line.unitCost.times(quantity),
      notes: [],
      lines: 1,
      adjusted: false,
    };
    if (ownDiscount) applyDiscount(item, ownDiscount, null, ctx);
    ctx.items.push(item);
    prev = item;
  }
}

function setTotal(item, total) {
  item.total = total;
  item.unitCost = total.div(item.quantity);
}

function applyDiscount(item, discount, label, ctx) {
  let total = item.total.minus(discount);
  if (total.lt(0)) {
    ctx.warnings.push(`${item.name}: a ${fmt(discount)} discount is larger than its price, so it was capped at ${fmt(item.total)}.`);
    total = new Decimal(0);
  }
  item.notes.push(`Includes ${fmt(discount)} off${label ? ` (${label})` : ''}`);
  setTotal(item, total);
  item.adjusted = true;
}

/** Fold repeated identical lines (same name, category, unit and price) into one row. */
function combineDuplicates(items) {
  const out = [];
  const seen = new Map();
  for (const it of items) {
    const key = [it.name.toLowerCase(), it.category ?? '', it.unit ?? '', it.unitCost.toFixed(4)].join('|');
    const first = !it.adjusted && seen.get(key);
    if (first) {
      first.quantity = first.quantity.plus(it.quantity);
      first.total = first.total.plus(it.total);
      first.lines += 1;
    } else {
      out.push(it);
      if (!it.adjusted) seen.set(key, it);
    }
  }
  for (const it of out) if (it.lines > 1) it.notes.unshift(`${it.lines} identical receipt lines combined`);
  return out;
}

export function normalizeReceipt(raw) {
  if (Array.isArray(raw)) raw = { items: raw };
  if (!isObject(raw)) throw badRequest('Receipt JSON must be an object or a list of items');

  const collection = pick(raw, 'items');
  if (collection !== undefined && !Array.isArray(collection) && !isObject(collection)) {
    throw badRequest('Receipt items must be a list or a set of named sections');
  }

  const ctx = { items: [], warnings: [], skipped: 0 };
  walkCollection(collection ?? [], null, ctx);
  const merged = combineDuplicates(ctx.items);

  const warnings = [...ctx.warnings];
  if (ctx.skipped > 0) warnings.push(`${ctx.skipped} priced line${ctx.skipped === 1 ? ' had' : 's had'} no item name and ${ctx.skipped === 1 ? 'was' : 'were'} skipped.`);
  if (!merged.length) warnings.push('No line items were found. Add them manually below.');

  // Compare against the pre-tax subtotal when there is one, else the total.
  const totals = Object.entries(raw).find(([k, v]) => norm(k) === 'totals' && isObject(v))?.[1] ?? null;
  const subtotal = positive(pick(raw, 'subtotal') ?? pick(totals, 'subtotal'));
  const total = positive(pick(raw, 'total') ?? pick(totals, 'total'));
  const printed = subtotal ?? total;
  const totalLabel = subtotal ? 'subtotal' : 'total';
  if (printed && merged.length) {
    const sum = merged.reduce((acc, it) => acc.plus(it.total), new Decimal(0));
    if (!sum.toDecimalPlaces(2).eq(printed.toDecimalPlaces(2))) {
      warnings.push(`Line items add up to ${fmt(sum)} but the receipt ${totalLabel} is ${fmt(printed)}. Tax, deposits or a missed line can explain this.`);
    }
  }
  for (const [k, v] of Object.entries(totals ?? {})) {
    const d = /saving|discount/i.test(k) ? positive(v) : null;
    if (d) warnings.push(`The receipt also shows ${fmt(d)} in order-level savings (${k}) that aren’t applied to individual lines.`);
  }

  const vendorRaw = pick(raw, 'vendor');
  const vendor = str(vendorRaw) ?? str(pick(vendorRaw, 'name'));

  return {
    vendor,
    date: isoDate(pickDeep(raw, 'date')),
    printedTotal: printed ? printed.toFixed(2) : null,
    totalLabel,
    items: merged.map((it) => ({
      name: it.name,
      category: it.category ?? null,
      quantity: it.quantity.toString(),
      unit: it.unit,
      unitCost: it.unitCost.toDecimalPlaces(4).toString(),
      totalCost: it.total.toDecimalPlaces(4).toString(),
      note: it.notes.join('; ') || null,
    })),
    warnings,
  };
}
