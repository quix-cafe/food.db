import { toDecimal } from '../format.js';
import ReceiptNameCell, { rowTarget } from './ReceiptNameCell.jsx';
import { Icon } from './ui.jsx';

// Editable receipt lines, shared by the import review screen and a saved receipt's
// "not saved yet" list. Nothing here talks to the server; callers save ticked rows
// with toPurchaseItem().

let nextKey = 1;

/** item: a normalised receipt line ({ name, quantity, …, match, suggestion }); `line` is its receipt_lines position. */
export const toRow = (item, line = item.line ?? null) => ({
  key: nextKey++,
  line,
  source: item.name ?? '',
  keep: !!item.name, // use the receipt's wording as-is
  resolved: item.match ?? null, // what that wording resolves to (saved alias or exact name)
  suggestion: item.suggestion ?? null,
  name: '', // the rename, when not keeping the receipt wording
  ingredientId: null,
  category: item.category ?? '',
  note: item.note ?? null,
  quantity: item.quantity ?? '1',
  unit: item.unit ?? '',
  unitCost: item.unitCost ?? '',
  totalCost: item.totalCost ?? '',
  confirmed: false,
});

export function rowProblem(r) {
  if (!rowTarget(r).name) return r.source ? 'Type a name or keep the receipt name' : 'Needs a name';
  const q = toDecimal(r.quantity);
  if (!q || q.lte(0)) return 'Quantity must be above 0';
  if (!toDecimal(r.unitCost) && !toDecimal(r.totalCost)) return 'Needs a unit or total cost';
  return null;
}

/** Body item for POST /ingredients/purchase; a renamed row carries its receipt wording as `alias`. */
export function toPurchaseItem(r) {
  const t = rowTarget(r);
  return {
    receiptLine: r.line ?? undefined,
    ingredientId: t.kind === 'existing' ? t.id : undefined,
    name: t.kind === 'new' ? t.name : undefined,
    alias: t.alias ? r.source : undefined,
    category: r.category,
    quantity: r.quantity,
    unit: r.unit,
    unitCost: r.unitCost,
    totalCost: r.totalCost,
  };
}

export function savedMessage(res) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [plural(res.purchases.length, 'purchase')];
  if (res.createdIngredients.length) parts.push(plural(res.createdIngredients.length, 'new ingredient'));
  if (res.aliasesSaved.length) parts.push(plural(res.aliasesSaved.length, 'receipt name') + ' remembered');
  return `Saved ${parts.join(', ')}`;
}

/**
 * pending: rows from a saved receipt that were never added; shown grayed out until ticked,
 * and can't be removed (they stay on the receipt).
 */
export default function ReviewLinesTable({ rows, setRows, pending = false, allowAdd = true }) {
  const update = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const confirmed = rows.filter((r) => r.confirmed).length;

  return (
    <>
      <div className="table-wrap">
        <table className={`grid review-grid ${pending ? 'pending' : ''}`}>
          <thead>
            <tr>
              <th className="check" title="Tick to save this line">Save</th>
              <th style={{ minWidth: 200 }}>Ingredient <span className="muted" style={{ fontWeight: 500 }}>(click a name to rename)</span></th>
              <th>Category</th>
              <th className="num">Qty</th>
              <th>Unit</th>
              <th className="num">Unit cost</th>
              <th className="num">Total</th>
              {!pending && <th><span className="visually-hidden">Remove</span></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const problem = rowProblem(r);
              return (
                <tr key={r.key} className={r.confirmed ? 'confirmed' : ''}>
                  <td className="check">
                    <input type="checkbox" checked={r.confirmed} disabled={!!problem} title={problem ?? 'Save this line'}
                      aria-label={`Confirm line ${i + 1}${problem ? ` (${problem})` : ''}`} onChange={(e) => update(r.key, { confirmed: e.target.checked })} />
                  </td>
                  <td>
                    <ReceiptNameCell row={r} index={i} onChange={(patch) => update(r.key, patch)} />
                    {problem && <div className="name-status" style={{ color: 'var(--tomato)' }}>{problem}</div>}
                  </td>
                  <td><input className="input" style={{ minWidth: 140 }} value={r.category} disabled={rowTarget(r).kind === 'existing'} aria-label={`Line ${i + 1} category`} onChange={(e) => update(r.key, { category: e.target.value })} /></td>
                  <td className="num"><input className="input num" style={{ width: 72 }} inputMode="decimal" value={r.quantity} aria-label={`Line ${i + 1} quantity`} aria-invalid={!toDecimal(r.quantity) || toDecimal(r.quantity).lte(0)} onChange={(e) => update(r.key, { quantity: e.target.value })} /></td>
                  <td><input className="input" style={{ width: 90 }} value={r.unit} aria-label={`Line ${i + 1} unit`} onChange={(e) => update(r.key, { unit: e.target.value })} /></td>
                  <td className="num"><input className="input num" style={{ width: 90 }} inputMode="decimal" value={r.unitCost} aria-label={`Line ${i + 1} unit cost`} onChange={(e) => update(r.key, { unitCost: e.target.value })} /></td>
                  <td className="num"><input className="input num" style={{ width: 90 }} inputMode="decimal" value={r.totalCost} aria-label={`Line ${i + 1} total`} onChange={(e) => update(r.key, { totalCost: e.target.value })} /></td>
                  {!pending && <td><button className="icon-btn" aria-label={`Remove line ${i + 1}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Icon.trash /></button></td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="panel-pad" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {allowAdd ? <button className="btn small" onClick={() => setRows((rs) => [...rs, toRow({ quantity: '1' }, null)])}><Icon.plus /> Add line</button> : <span />}
        <span className="muted">{confirmed} of {rows.length} lines ticked</span>
      </div>
    </>
  );
}
