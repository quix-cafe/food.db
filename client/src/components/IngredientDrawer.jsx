import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, notifyDataChanged } from '../api.js';
import { estimatedCupGrams, normalizeUnit, unitRatio } from '@kitchen/shared';
import { useApi } from '../hooks.js';
import { useSkinPart } from '../skin.js';
import { Decimal, date, money, pack, perUnit, qty, signedPercent, toDecimal, unitMoney } from '../format.js';
import { CategoryInput, PurchaseFields, UomInput, emptyPurchase } from './forms.jsx';
import PriceChart from './PriceChart.jsx';
import { Drawer, Field, Icon, Notice, Spinner, TestBadge, useToast } from './ui.jsx';

const cupText = (v) => (v ? toDecimal(v).toString() : '');
/** 'weight' or 'volume' for a unit kitchen measures convert, else null (each, box). */
export const measurable = (uom) => {
  const u = normalizeUnit(uom);
  if (!u) return null;
  return unitRatio(u, 'g') ? 'weight' : unitRatio(u, 'tsp') ? 'volume' : null;
};

/**
 * An ingredient's detail panel: prices, details, where it's used, purchases. Also opened over the
 * recipe builder, which passes no `onMerge` (merging needs this page) and no duplicates.
 * A skin may bring its own panel (`registerSkinPart('IngredientDrawer', …)`), shown wherever this one is.
 */
export function IngredientDrawer(props) {
  const Skinned = useSkinPart('IngredientDrawer');
  return Skinned ? <Skinned {...props} /> : <DefaultIngredientDrawer {...props} />;
}

/** The panel's data, its details form and what it can change; shared by every skin's panel. */
export function useIngredientPanel(id, onClose) {
  const { data, error, reload } = useApi(`/ingredients/${id}/history`);
  const { data: vendors } = useApi('/ingredients/vendors');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [purchase, setPurchase] = useState(emptyPurchase);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toast = useToast();

  const ing = data?.ingredient;
  useEffect(() => {
    if (ing) setForm({ name: ing.name, category: ing.category ?? '', uom: ing.uom ?? '', cupGrams: cupText(ing.cupGrams) });
  }, [ing?.id, ing?.name, ing?.category, ing?.uom, ing?.cupGrams]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = form && ing && (form.name !== ing.name || form.category !== (ing.category ?? '') || form.uom !== (ing.uom ?? '') || form.cupGrams !== cupText(ing.cupGrams));

  const run = async (fn, ok) => {
    setSaving(true);
    setFormError(null);
    try {
      await fn();
      notifyDataChanged();
      if (ok) toast(ok);
      return true;
    } catch (err) {
      setFormError(err.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = (e) => {
    e.preventDefault();
    run(() => api(`/ingredients/${id}`, { method: 'PATCH', body: { name: form.name, category: form.category, uom: form.uom, cupGrams: form.cupGrams } }), 'Ingredient saved');
  };

  const addPurchase = async (e) => {
    e.preventDefault();
    if (await run(() => api(`/ingredients/${id}/purchases`, { method: 'POST', body: purchase }), 'Purchase recorded')) {
      setAdding(false);
      setPurchase(emptyPurchase());
    }
  };

  const remove = async () => {
    if (await run(() => api(`/ingredients/${id}`, { method: 'DELETE' }), `Deleted ${ing.name}`)) onClose();
  };

  const removeAlias = (a) => run(() => api(`/ingredients/${id}/aliases/${a.id}`, { method: 'DELETE' }), `Forgot “${a.alias}”`).then(reload);
  const removePurchase = (pid) => run(() => api(`/ingredients/${id}/purchases/${pid}`, { method: 'DELETE' }), 'Purchase removed').then(reload);

  const purchaseById = new Map((data?.purchases ?? []).map((p) => [p.id, p]));
  const latest = data?.trips[0]; // newest first; a trip is one receipt's lines, averaged
  const hike = latest?.priceHike ? latest : null;

  return {
    data, error, vendors, ing, form, setForm, dirty, saving, formError, adding, setAdding, purchase, setPurchase, confirmDelete, setConfirmDelete,
    run, save, addPurchase, remove, removeAlias, removePurchase, purchaseById, latest, hike,
  };
}

function DefaultIngredientDrawer({ id, onClose, duplicates = [], onReview, onMerge }) {
  const {
    data, error, vendors, ing, form, setForm, dirty, saving, formError, adding, setAdding, purchase, setPurchase, confirmDelete, setConfirmDelete,
    run, save, addPurchase, remove, removeAlias, removePurchase, purchaseById, hike,
  } = useIngredientPanel(id, onClose);

  return (
    <Drawer title={ing ? <>{ing.name} <TestBadge item={ing} /></> : 'Loading…'} subtitle={ing && `Asset ID ${ing.id.slice(0, 8)}`} onClose={onClose}>
      {error && <Notice kind="error">{error.message}</Notice>}
      {!data && !error && <Spinner />}
      {data && form && (
        <>
          {duplicates.map((d) => {
            const other = d.keep.id === id ? d.merge : d.keep;
            return (
              <Notice key={other.id}>
                Possibly the same as <b>{other.name}</b>: {d.reason.charAt(0).toLowerCase() + d.reason.slice(1)}.{' '}
                <button className="btn small" onClick={() => onReview(d)}>Review merge</button>
              </Notice>
            );
          })}
          <>
          <div className="stat-row">
            <div className="stat"><b>{ing.latestUnitPrice ? money(ing.latestUnitPrice) : '—'}</b><span>Latest per {ing.uom ?? 'unit'}{ing.latestPackSize ? ` (${ing.latestLines > 1 ? 'avg ' : ''}${pack(ing.latestPackSize, ing.uom)} for ${unitMoney(ing.latestPackPrice)})` : ''}{ing.latestLines > 1 ? `, averaged over ${ing.latestLines} lines of one receipt` : ''}</span></div>
            {data.trips.length > 1 && (
              <div className="stat" title="The mean of every trip's price per unit, from any store. Several lines of one receipt count once, at their average.">
                <b>{money(averageUnitPrice(data.trips))}</b><span>Average per {ing.uom ?? 'unit'} ({data.trips.length} trips)</span>
              </div>
            )}
            <div className="stat"><b>{data.purchases.length}</b><span>Purchases</span></div>
            <div className="stat"><b>{data.vendors.length}</b><span>Vendors</span></div>
          </div>

          {hike && (
            <Notice>
              Price up <b>{signedPercent(hike.changePercent)}</b>: {perUnit(hike.unitPrice, ing.uom)}{hike.vendor ? ` at ${hike.vendor}` : ''} on {date(hike.date)},
              {' '}was {perUnit(hike.previous.unitPrice, ing.uom)}{hike.previous.vendor ? ` at ${hike.previous.vendor}` : ''} on {date(hike.previous.date)}.
            </Notice>
          )}

          <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h3>Price history</h3>
            <PriceChart key={id} purchases={data.trips} uom={ing.uom} />
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h3>Vendors</h3>
            <div className="panel table-wrap">
              <table className="grid">
                <thead><tr><th>Vendor</th><th className="num">Latest per unit</th><th className="num">Pack</th><th>Last bought</th></tr></thead>
                <tbody>
                  {data.vendors.map((v) => (
                    <tr key={v.vendor}>
                      <td>{v.vendor}</td>
                      <td className="num">{perUnit(v.latestUnitPrice, ing.uom)}</td>
                      <td className="num muted">{pack(v.latestPackSize, ing.uom)} for {unitMoney(v.latestPackPrice)}</td>
                      <td className="nowrap">{date(v.latestDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          </>

          <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3>Details</h3>
            <div className="ingredient-details">
              <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
              <Field label="Category"><CategoryInput value={form.category} onChange={(category) => setForm((f) => ({ ...f, category }))} /></Field>
              <Field label="Unit of measurement">
                <UomInput value={form.uom} onChange={(uom) => setForm((f) => ({ ...f, uom }))} required />
              </Field>
              {measurable(form.uom) && (
                <Field label="1 cup weighs (g)">
                  <input className="input num" inputMode="decimal" value={form.cupGrams} aria-label="Grams in one cup"
                    title={`So recipes can use ${measurable(form.uom) === 'weight' ? 'cups and spoons' : 'ounces and grams'} of it. Blank: an estimate by name where there is one.`}
                    placeholder={estimatedCupGrams(form.name) ? `about ${estimatedCupGrams(form.name)}` : 'e.g. 185 for rice'}
                    onChange={(e) => setForm((f) => ({ ...f, cupGrams: e.target.value }))} />
                </Field>
              )}
            </div>
            {formError && <Notice kind="error">{formError}</Notice>}
            <div className="form-actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <small className="muted">Pack sizes and recipe amounts are in this unit; changing it doesn’t convert them.</small>
              <button className="btn primary small" disabled={!dirty || saving}>Save changes</button>
            </div>
          </form>

          <UsedIn usedIn={data.usedIn} ing={ing} />

          <>
          <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>Purchases</h3>
              {!adding && <button className="btn small" onClick={() => setAdding(true)}><Icon.plus /> Add purchase</button>}
            </div>
            {adding && (
              <form className="panel panel-pad" onSubmit={addPurchase} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <PurchaseFields value={purchase} onChange={setPurchase} uom={ing.uom} />
                <div className="form-actions">
                  <button type="button" className="btn ghost" onClick={() => setAdding(false)}>Cancel</button>
                  <button className="btn primary" disabled={saving}>Record purchase</button>
                </div>
              </form>
            )}
            <div className="panel table-wrap">
              <table className="grid">
                <thead><tr><th>Date</th><th>Vendor</th><th className="num">Packs</th><th className="num">Pack size</th><th className="num">Pack price</th><th className="num">Per unit</th><th className="num">Total</th><th className="num" title="Price per unit vs the previous purchase, any store">Change</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
                <tbody>
                  {data.trips.map((t) => {
                    const lines = t.purchaseIds.map((pid) => purchaseById.get(pid));
                    const row = (p, inTrip) => (
                      <tr key={p.id} className={inTrip ? 'trip-line' : undefined}>
                        <td className="nowrap">{inTrip ? <span className="muted">{date(p.date)}</span> : date(p.date)}</td>
                        <td><VendorInput purchase={p} ingredientId={id} run={run} /> <TestBadge item={p} />{p.receiptId && !inTrip && <> <Link to={`/purchases/${p.receiptId}`} className="muted" style={{ fontSize: '0.85rem' }}>Receipt</Link></>}</td>
                        <td className="num nowrap"><PurchaseNumberInput purchase={p} field="quantity" ingredientId={id} run={run} /></td>
                        <td className="num nowrap"><PurchaseNumberInput purchase={p} field="packSize" uom={ing.uom} ingredientId={id} run={run} /></td>
                        <td className="num nowrap"><PurchaseNumberInput purchase={p} field="unitCost" ingredientId={id} run={run} /></td>
                        <td className="num nowrap">{perUnit(p.unitPrice, ing.uom)}</td>
                        <td className="num nowrap"><PurchaseNumberInput purchase={p} field="totalCost" ingredientId={id} run={run} /></td>
                        <td className="num" title={p.previous ? `vs ${perUnit(p.previous.unitPrice, ing.uom)}${p.previous.vendor ? ` at ${p.previous.vendor}` : ''} on ${date(p.previous.date)}` : inTrip ? 'Part of the receipt’s average above' : undefined}>
                          {inTrip ? <span className="muted">in avg</span> : <Change value={p.changePercent} hike={p.priceHike} />}
                        </td>
                        <td><button className="icon-btn" aria-label={`Remove purchase from ${date(p.date)}`} onClick={() => removePurchase(p.id)}><Icon.trash /></button></td>
                      </tr>
                    );
                    if (t.lines === 1) return row(lines[0], false);
                    return (
                      <Fragment key={t.id}>
                        <tr className="trip-row">
                          <td className="nowrap">{date(t.date)}</td>
                          <td>
                            <b>{t.vendor ?? 'Unknown vendor'}</b> <span className="muted">· {t.lines} lines, averaged</span>
                            {t.receiptId && <> <Link to={`/purchases/${t.receiptId}`} className="muted" style={{ fontSize: '0.85rem' }}>Receipt</Link></>}
                          </td>
                          <td className="num">{qty(t.quantity)}</td>
                          <td className="num nowrap" title="Average pack size">avg {pack(t.packSize, ing.uom)}</td>
                          <td className="num" title="Average pack price">{unitMoney(t.unitCost)}</td>
                          <td className="num nowrap" title="What this receipt spent on it ÷ how much it bought">{perUnit(t.unitPrice, ing.uom)}</td>
                          <td className="num">{money(t.totalCost)}</td>
                          <td className="num" title={t.previous ? `vs ${perUnit(t.previous.unitPrice, ing.uom)}${t.previous.vendor ? ` at ${t.previous.vendor}` : ''} on ${date(t.previous.date)}` : undefined}><Change value={t.changePercent} hike={t.priceHike} /></td>
                          <td />
                        </tr>
                        {lines.map((p) => row(p, true))}
                      </Fragment>
                    );
                  })}
                  {!data.purchases.length && <tr><td colSpan={9} className="muted">No purchases yet.</td></tr>}
                </tbody>
              </table>
              <datalist id="vendor-options">{(vendors ?? []).map((v) => <option key={v} value={v} />)}</datalist>
            </div>
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3>Receipt names</h3>
            {data.aliases.length ? (
              <>
                <div className="alias-list">
                  {data.aliases.map((a) => (
                    <span key={a.id} className="badge">
                      {a.alias}{a.ambiguous && <span className="muted" title="Only suggested on new receipts: one receipt used this name for several ingredients"> · asks</span>}
                      <button aria-label={`Forget receipt name ${a.alias}`} title="Forget this receipt name" onClick={() => removeAlias(a)}><Icon.close /></button>
                    </span>
                  ))}
                </div>
                <small className="muted">
                  Receipt lines with these names are matched to {ing.name} automatically
                  {data.aliases.some((a) => a.ambiguous)
                    ? <>, except {data.aliases.filter((a) => a.ambiguous).map((a) => `“${a.alias}”`).join(', ')}: one receipt used it for several ingredients, so new receipts only suggest it.</>
                    : '.'}
                </small>
              </>
            ) : (
              <small className="muted">None yet. When you rename a receipt line to {ing.name}, the receipt’s wording is remembered here.</small>
            )}
          </section>
          </>

          <section className="form-actions" style={{ justifyContent: 'flex-start' }}>
            {confirmDelete ? (
              <>
                <span>Delete {ing.name} and all {data.purchases.length} purchases?</span>
                <button className="btn danger" onClick={remove} disabled={saving}>Delete</button>
                <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Keep it</button>
              </>
            ) : (
              <>
                {onMerge && (
                  <button className="btn" onClick={() => onMerge({ first: { ...ing, purchaseCount: data.purchases.length } })}>
                    Merge into another ingredient…
                  </button>
                )}
                <button className="btn danger" onClick={() => setConfirmDelete(true)}><Icon.trash /> Delete ingredient</button>
              </>
            )}
          </section>
        </>
      )}
    </Drawer>
  );
}

const PURCHASE_FIELDS = {
  quantity: { label: 'Packs', done: (d) => `Packs changed to ${qty(d)}; the total stays` },
  packSize: { label: 'Pack size', done: (d, uom) => `Pack size changed to ${pack(d, uom)}` },
  unitCost: { label: 'Pack price', money: true, done: (d) => `Pack price changed to ${money(d)}` },
  totalCost: { label: 'Total', money: true, done: (d) => `Total changed to ${money(d)}` },
};

/**
 * One number of a purchase, editable in place to correct it (saved on Enter or when leaving the
 * field; Escape undoes): packs bought, pack size, pack price or total. The server keeps packs ×
 * pack price and the total in agreement: new packs keep the total, a new price or total works out
 * the other.
 */
export function PurchaseNumberInput({ purchase, field, uom, ingredientId, run }) {
  const spec = PURCHASE_FIELDS[field];
  const stored = toDecimal(purchase[field]);
  const saved = spec.money && stored.decimalPlaces() <= 2 ? stored.toFixed(2) : stored.toString(); // $1.50, but $0.3317 a lime
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);
  const d = toDecimal(value.replace(/[$,]/g, ''));
  const valid = d && (field === 'quantity' || field === 'packSize' ? d.gt(0) : d.gte(0));
  const commit = () => {
    if (!valid) return setValue(saved);
    if (d.eq(saved)) return;
    run(() => api(`/ingredients/${ingredientId}/purchases/${purchase.id}`, { method: 'PATCH', body: { [field]: d.toString() } }), spec.done(d, uom));
  };
  return (
    <span className={`pack-size-edit ${spec.money ? 'money-input' : ''}`}>
      {spec.money && <span aria-hidden="true">$</span>}
      <input className="input num" inputMode="decimal" value={value} aria-label={`${spec.label} for the purchase on ${date(purchase.date)}${field === 'packSize' ? `, in ${uom ?? 'units'}` : ''}`}
        aria-invalid={!valid} onChange={(e) => setValue(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') undo(e, value, saved, setValue); }} />
      {field === 'packSize' && <>{' '}{uom}</>}
    </span>
  );
}

/**
 * A purchase's vendor, editable in place to fill in a missing one or fix a wrong one (saved on
 * Enter or when leaving the field; Escape undoes; blank clears it). Suggests vendors already in use.
 */
export function VendorInput({ purchase, ingredientId, run }) {
  const saved = purchase.vendor ?? '';
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);
  const commit = () => {
    const v = value.trim();
    if (v === saved) return setValue(saved);
    run(() => api(`/ingredients/${ingredientId}/purchases/${purchase.id}`, { method: 'PATCH', body: { vendor: v } }),
      v ? `Vendor changed to ${v}` : 'Vendor cleared');
  };
  return (
    <input className="input vendor-edit" list="vendor-options" value={value} placeholder="Add vendor" maxLength={120}
      aria-label={`Vendor for the purchase on ${date(purchase.date)}`} title={purchase.receiptId ? 'Changes this purchase only, not the receipt' : undefined}
      onChange={(e) => setValue(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') undo(e, value, saved, setValue); }} />
  );
}

/** The recipes an ingredient is in, directly or through a Spice Lab blend or sauce. */
export function UsedIn({ usedIn, ing }) {
  const { recipes, blends } = usedIn;
  return (
    <section className="used-in">
      <h3>Used in</h3>
      {!recipes.length && !blends.length ? (
        <small className="muted">No recipes or Spice Lab blends use {ing.name} yet.</small>
      ) : (
        <ul>
          {recipes.map((r) => (
            <li key={`${r.id}:${r.unit ?? ''}`}>
              <Link to={`/recipes/${r.id}`}>{r.name}</Link> <TestBadge item={r} />
              <span className="muted">{qty(r.amount)} {r.unit ?? ing.uom}</span>
            </li>
          ))}
          {blends.map((b) => (
            <li key={b.id}>
              <Link to={`/spice-lab/${b.id}`}>{b.name}</Link> <span className="badge">{b.kind === 'sauce' ? 'Sauce' : 'Spice blend'}</span>
              <span className="muted">
                {b.recipes.length
                  ? <>in {b.recipes.map((r, i) => <Fragment key={r.id}>{i > 0 && ', '}<Link to={`/recipes/${r.id}`}>{r.name}</Link></Fragment>)}</>
                  : 'not in a recipe yet'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Escape in an in-place edit undoes it without closing the drawer; with nothing to undo it closes as usual. */
function undo(e, value, saved, setValue) {
  if (value === saved) return;
  e.stopPropagation();
  setValue(saved);
}

export const averageUnitPrice = (purchases) =>
  purchases.reduce((sum, p) => sum.plus(p.unitPrice), new Decimal(0)).div(purchases.length);

export function Change({ value, hike }) {
  if (value == null) return <span className="muted">—</span>;
  const d = toDecimal(value);
  const cls = hike ? 'price-up' : d.lt(0) ? 'price-down' : '';
  return <span className={cls}>{signedPercent(value)}{hike && <span className="visually-hidden"> (price hike)</span>}</span>;
}
