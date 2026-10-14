import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api, notifyDataChanged } from '../api.js';
import { money, toDecimal, todayIso, Decimal } from '../format.js';
import IngredientCombobox from '../components/IngredientCombobox.jsx';
import { ReceiptImportForm } from '../components/forms.jsx';
import { Field, Icon, Notice, Spinner, useToast } from '../components/ui.jsx';

let nextKey = 1;
const toRow = (item) => ({
  key: nextKey++,
  source: item.name ?? '',
  name: item.match?.name ?? item.name ?? '',
  ingredientId: item.match?.id ?? null,
  category: item.match?.category ?? '',
  quantity: item.quantity ?? '1',
  unit: item.unit ?? '',
  unitCost: item.unitCost ?? '',
  totalCost: item.totalCost ?? '',
  confirmed: false,
});

function rowProblem(r) {
  if (!r.name.trim()) return 'Needs a name';
  const q = toDecimal(r.quantity);
  if (!q || q.lte(0)) return 'Quantity must be above 0';
  if (!toDecimal(r.unitCost) && !toDecimal(r.totalCost)) return 'Needs a unit or total cost';
  return null;
}

/** OCR "Review & Confirm": nothing is saved until each row is checked and committed. */
export default function ReceiptReviewPage() {
  const { state } = useLocation();
  if (!state?.receipt) {
    return (
      <main className="page">
        <div className="page-head">
          <div>
            <h1>Review a receipt</h1>
            <p>Paste the JSON your receipt extractor produced. Each line is checked against the database before anything is saved.</p>
          </div>
        </div>
        <section className="panel panel-pad" style={{ maxWidth: 720 }}>
          <ReceiptImportForm />
        </section>
      </main>
    );
  }
  return <ReviewGrid key={state.source} {...state} />;
}

function ReviewGrid({ receipt, source, photoUrl }) {
  const [vendor, setVendor] = useState(receipt.vendor ?? '');
  const [date, setDate] = useState(receipt.date ?? todayIso());
  const [rows, setRows] = useState(() => receipt.items.map(toRow));
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState(photoUrl ? 'photo' : 'json');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();
  const toast = useToast();

  const update = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const confirmed = rows.filter((r) => r.confirmed);
  const lineSum = useMemo(
    () => rows.reduce((acc, r) => acc.plus(toDecimal(r.totalCost) ?? (toDecimal(r.unitCost)?.times(toDecimal(r.quantity) ?? 0) ?? 0)), new Decimal(0)),
    [rows],
  );

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api('/ingredients/purchase', {
        method: 'POST',
        body: {
          vendor,
          date,
          items: confirmed.map((r) => ({
            ingredientId: r.ingredientId ?? undefined,
            name: r.name,
            category: r.category,
            quantity: r.quantity,
            unit: r.unit,
            unitCost: r.unitCost,
            totalCost: r.totalCost,
          })),
        },
      });
      notifyDataChanged();
      const created = res.createdIngredients.length;
      toast(`Saved ${res.purchases.length} purchase${res.purchases.length === 1 ? '' : 's'}${created ? `, ${created} new ingredient${created === 1 ? '' : 's'}` : ''}`);
      const remaining = rows.filter((r) => !r.confirmed);
      if (remaining.length) setRows(remaining);
      else navigate('/ingredients');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Review receipt</h1>
          <p>Check each line against the receipt, fix anything that was misread, then tick it. Only ticked lines are saved.</p>
        </div>
        <div className="form-actions">
          <button className="btn ghost" onClick={() => navigate('/ingredients')}>Discard</button>
          <button className="btn primary" disabled={!confirmed.length || busy} onClick={commit}>
            {busy && <Spinner />} Save {confirmed.length || ''} confirmed {confirmed.length === 1 ? 'line' : 'lines'}
          </button>
        </div>
      </div>

      <div className="split">
        <section className="panel source-pane" aria-label="Receipt">
          <div className="panel-head">
            <div className="chips" role="group" aria-label="Receipt view">
              {photoUrl && <button className="chip" aria-pressed={view === 'photo'} onClick={() => setView('photo')}>Photo</button>}
              <button className="chip" aria-pressed={view === 'json'} onClick={() => setView('json')}>JSON</button>
            </div>
            {view === 'photo' && (
              <div className="zoom">
                <button className="icon-btn" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>−</button>
                <button className="btn small ghost" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
                <button className="icon-btn" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>+</button>
              </div>
            )}
          </div>
          <div className="source-view">
            {view === 'photo' && photoUrl
              ? <img src={photoUrl} alt="Receipt photo" style={{ width: `${zoom * 100}%` }} />
              : <pre>{source}</pre>}
          </div>
        </section>

        <section className="panel" aria-label="Extracted lines">
          <div className="panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="form-grid">
              <Field label="Vendor"><input className="input" value={vendor} onChange={(e) => setVendor(e.target.value)} /></Field>
              <Field label="Purchase date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
              <Field label="Receipt total">
                <span style={{ padding: '7px 0', fontWeight: 650 }}>
                  {receipt.printedTotal ? money(receipt.printedTotal) : '—'} <span className="muted">(lines add up to {money(lineSum)})</span>
                </span>
              </Field>
            </div>
            {receipt.warnings.length > 0 && <Notice>{receipt.warnings.map((w) => <div key={w}>{w}</div>)}</Notice>}
          </div>

          <div className="table-wrap">
            <table className="grid review-grid">
              <thead>
                <tr>
                  <th className="check"><span className="visually-hidden">Confirmed</span>✓</th>
                  <th style={{ minWidth: 200 }}>Ingredient</th>
                  <th>Category</th>
                  <th className="num">Qty</th>
                  <th>Unit</th>
                  <th className="num">Unit cost</th>
                  <th className="num">Total</th>
                  <th><span className="visually-hidden">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const problem = rowProblem(r);
                  return (
                    <tr key={r.key} className={r.confirmed ? 'confirmed' : ''}>
                      <td className="check">
                        <input type="checkbox" checked={r.confirmed} disabled={!!problem} title={problem ?? 'Confirm this line'}
                          aria-label={`Confirm line ${i + 1}${problem ? ` (${problem})` : ''}`} onChange={(e) => update(r.key, { confirmed: e.target.checked })} />
                      </td>
                      <td>
                        <IngredientCombobox
                          ariaLabel={`Line ${i + 1} ingredient`}
                          value={r.name}
                          onInput={(name) => update(r.key, { name, ingredientId: null })}
                          onPick={(ing) => update(r.key, { name: ing.name, ingredientId: ing.id, category: ing.category ?? '' })}
                          placeholder="Ingredient name"
                        />
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap', fontSize: '0.8rem' }}>
                          {r.ingredientId ? <span className="badge good">In database</span> : <span className="badge new">New ingredient</span>}
                          {r.source && r.source !== r.name && <span className="muted">Receipt: “{r.source}”</span>}
                          {problem && <span style={{ color: 'var(--tomato)' }}>{problem}</span>}
                        </div>
                      </td>
                      <td><input className="input" value={r.category} disabled={!!r.ingredientId} aria-label={`Line ${i + 1} category`} onChange={(e) => update(r.key, { category: e.target.value })} /></td>
                      <td><input className="input num" style={{ width: 72 }} inputMode="decimal" value={r.quantity} aria-label={`Line ${i + 1} quantity`} aria-invalid={!toDecimal(r.quantity) || toDecimal(r.quantity).lte(0)} onChange={(e) => update(r.key, { quantity: e.target.value })} /></td>
                      <td><input className="input" style={{ width: 90 }} value={r.unit} aria-label={`Line ${i + 1} unit`} onChange={(e) => update(r.key, { unit: e.target.value })} /></td>
                      <td><input className="input num" style={{ width: 90 }} inputMode="decimal" value={r.unitCost} aria-label={`Line ${i + 1} unit cost`} onChange={(e) => update(r.key, { unitCost: e.target.value })} /></td>
                      <td><input className="input num" style={{ width: 90 }} inputMode="decimal" value={r.totalCost} aria-label={`Line ${i + 1} total`} onChange={(e) => update(r.key, { totalCost: e.target.value })} /></td>
                      <td><button className="icon-btn" aria-label={`Remove line ${i + 1}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Icon.trash /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="panel-pad" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn small" onClick={() => setRows((rs) => [...rs, toRow({ quantity: '1' })])}><Icon.plus /> Add line</button>
            <span className="muted">{confirmed.length} of {rows.length} lines confirmed</span>
          </div>
          {error && <div className="panel-pad" style={{ paddingTop: 0 }}><Notice kind="error">{error}</Notice></div>}
        </section>
      </div>
    </main>
  );
}
