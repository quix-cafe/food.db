import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, notifyDataChanged } from '../api.js';
import { saveDraftPhotos } from '../receiptDraft.js';
import { useApi } from '../hooks.js';
import { todayIso, toDecimal, money } from '../format.js';
import { Field, Notice, Spinner, useToast } from './ui.jsx';

export const emptyPurchase = () => ({ date: todayIso(), vendor: '', quantity: '1', weight: '', unit: '', unitCost: '', totalCost: '' });

/** Purchase inputs; whichever of unit/total cost is blank is derived from the other. */
export function PurchaseFields({ value, onChange }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  const q = toDecimal(value.quantity);
  const u = toDecimal(value.unitCost);
  const t = toDecimal(value.totalCost);
  const derivedTotal = !t && u && q ? money(u.times(q)) : null;
  const derivedUnit = !u && t && q && !q.isZero() ? money(t.div(q), 4) : null;
  return (
    <div className="form-grid">
      <Field label="Date"><input className="input" type="date" value={value.date} onChange={set('date')} required /></Field>
      <Field label="Vendor"><input className="input" value={value.vendor} onChange={set('vendor')} placeholder="e.g. Sysco" /></Field>
      <Field label="Quantity"><input className="input num" inputMode="decimal" value={value.quantity} onChange={set('quantity')} required /></Field>
      <Field label="Unit" hint="What one unit is"><input className="input" value={value.unit} onChange={set('unit')} placeholder="case 36 lb" /></Field>
      <Field label="Weight" hint="Optional"><input className="input num" inputMode="decimal" value={value.weight} onChange={set('weight')} /></Field>
      <Field label="Unit cost" hint={derivedUnit && `= ${derivedUnit}`}><input className="input num" inputMode="decimal" value={value.unitCost} onChange={set('unitCost')} placeholder="0.00" /></Field>
      <Field label="Total cost" hint={derivedTotal && `= ${derivedTotal}`}><input className="input num" inputMode="decimal" value={value.totalCost} onChange={set('totalCost')} placeholder="0.00" /></Field>
    </div>
  );
}

export function CategoryInput({ value, onChange, id = 'category-options' }) {
  const { data } = useApi('/ingredients/categories');
  return (
    <>
      <input className="input" list={id} value={value} onChange={onChange} placeholder="e.g. Produce" />
      <datalist id={id}>{(data ?? []).map((c) => <option key={c} value={c} />)}</datalist>
    </>
  );
}

/** Manual entry: a new master ingredient plus its first purchase. */
export function NewIngredientForm({ onDone }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [yieldPct, setYieldPct] = useState('100');
  const [purchase, setPurchase] = useState(emptyPurchase);
  const [withPurchase, setWithPurchase] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api('/ingredients', {
        method: 'POST',
        body: { name, category, defaultYieldPercent: yieldPct, purchase: withPurchase ? purchase : undefined },
      });
      notifyDataChanged();
      toast(`Added ${created.name}`);
      onDone?.(created);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="modal-body" style={{ padding: 0 }}>
      <div className="form-grid">
        <Field label="Name" className="span-2"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></Field>
        <Field label="Category"><CategoryInput value={category} onChange={(e) => setCategory(e.target.value)} /></Field>
        <Field label="Usable yield %" hint="After trim loss"><input className="input num" inputMode="decimal" value={yieldPct} onChange={(e) => setYieldPct(e.target.value)} /></Field>
      </div>
      <label className="nowrap" style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600 }}>
        <input type="checkbox" checked={withPurchase} onChange={(e) => setWithPurchase(e.target.checked)} /> Record the first purchase
      </label>
      {withPurchase && <PurchaseFields value={purchase} onChange={setPurchase} />}
      {error && <Notice kind="error">{error}</Notice>}
      <div className="form-actions">
        <button className="btn primary" disabled={busy}>{busy ? <Spinner /> : null} Add ingredient</button>
      </div>
    </form>
  );
}

/**
 * Takes receipt JSON produced outside the app (e.g. by qwen), asks the server to
 * normalise it and suggest matching ingredients, then opens the review grid.
 * Optional receipt photos are shown beside the grid and stored with the receipt on save.
 */
export function ReceiptImportForm({ onDone }) {
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const navigate = useNavigate();

  const readFile = async (file) => {
    if (!file) return;
    if (file.type.startsWith('image/')) return setPhotos((p) => [...p, file]);
    setText(await file.text());
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return setError(`That isn't valid JSON: ${err.message}`);
    }
    setBusy(true);
    try {
      const receipt = await api('/ingredients/import-receipt', { method: 'POST', body: parsed });
      navigate('/ingredients/review', {
        state: { receipt, source: JSON.stringify(parsed, null, 2), draftId: saveDraftPhotos(photos) },
      });
      onDone?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="modal-body" style={{ padding: 0 }}>
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); [...e.dataTransfer.files].forEach(readFile); }}
      >
        Drop a receipt <b>.json</b> file and its photos here, or{' '}
        <label style={{ color: 'var(--basil)', fontWeight: 650, cursor: 'pointer' }}>
          choose files
          <input type="file" accept=".json,application/json,image/*" multiple className="visually-hidden" onChange={(e) => [...e.target.files].forEach(readFile)} />
        </label>
      </div>
      <Field label="Receipt JSON" hint="Most key names work: vendor or merchant, items with name or description, quantity, unit_price, and total or price.">
        <textarea className="input" rows={9} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
          placeholder={'{\n  "vendor": "Restaurant Depot",\n  "date": "2026-10-14",\n  "items": [{ "name": "Flour 50 lb", "quantity": 1, "total": 28.90 }]\n}'} />
      </Field>
      {photos.length > 0 && (
        <p className="muted">
          {photos.length} photo{photos.length === 1 ? '' : 's'} attached ({photos.map((p) => p.name).join(', ')}).{' '}
          <button type="button" className="link-btn" onClick={() => setPhotos([])}>Remove</button>
        </p>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      <div className="form-actions">
        <button className="btn primary" disabled={busy || !text.trim()}>{busy ? <Spinner /> : null} Review items</button>
      </div>
    </form>
  );
}
