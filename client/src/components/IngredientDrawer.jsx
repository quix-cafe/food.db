import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, notifyDataChanged } from '../api.js';
import { isLabor } from '@kitchen/shared';
import { useApi } from '../hooks.js';
import { Decimal, date, money, pack, perUnit, qty, signedPercent, toDecimal, todayIso, unitMoney } from '../format.js';
import { CategoryInput, PurchaseFields, UomInput, emptyPurchase } from './forms.jsx';
import PriceChart from './PriceChart.jsx';
import { Drawer, Field, Icon, Notice, Spinner, TestBadge, useToast } from './ui.jsx';

/**
 * An ingredient's detail panel: prices, details, where it's used, purchases. Also opened over the
 * recipe builder, which passes no `onMerge` (merging needs this page) and no duplicates.
 */
export function IngredientDrawer({ id, onClose, duplicates = [], onReview, onMerge }) {
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
    if (ing) setForm({ name: ing.name, category: ing.category ?? '', uom: ing.uom ?? '' });
  }, [ing?.id, ing?.name, ing?.category, ing?.uom]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = form && ing && (form.name !== ing.name || form.category !== (ing.category ?? '') || form.uom !== (ing.uom ?? ''));

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
    run(() => api(`/ingredients/${id}`, { method: 'PATCH', body: { name: form.name, category: form.category, uom: form.uom } }), 'Ingredient saved');
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

  const labor = isLabor(ing);
  const purchaseById = new Map((data?.purchases ?? []).map((p) => [p.id, p]));
  const latest = data?.trips[0]; // newest first; a trip is one receipt's lines, averaged
  const hike = latest?.priceHike ? latest : null;

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
          {labor && <LaborRate ingredient={ing} purchases={data.purchases} run={run} saving={saving} />}
          {!labor && (<>
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
          </>)}

          <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3>Details</h3>
            <div className="ingredient-details">
              <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
              <Field label="Category"><CategoryInput value={form.category} onChange={(category) => setForm((f) => ({ ...f, category }))} /></Field>
              <Field label="Unit of measurement">
                <UomInput value={form.uom} onChange={(uom) => setForm((f) => ({ ...f, uom }))} required />
              </Field>
            </div>
            {formError && <Notice kind="error">{formError}</Notice>}
            <div className="form-actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <small className="muted">Pack sizes and recipe amounts are in this unit; changing it doesn’t convert them.</small>
              <button className="btn primary small" disabled={!dirty || saving}>Save changes</button>
            </div>
          </form>

          <UsedIn usedIn={data.usedIn} ing={ing} />

          {!labor && (<>
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
                        <td className="num">{qty(p.quantity)}</td>
                        <td className="num nowrap"><PackSizeInput purchase={p} uom={ing.uom} ingredientId={id} run={run} /></td>
                        <td className="num">{unitMoney(p.unitCost)}</td>
                        <td className="num nowrap">{perUnit(p.unitPrice, ing.uom)}</td>
                        <td className="num">{money(p.totalCost)}</td>
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
          </>)}

          <section className="form-actions" style={{ justifyContent: 'flex-start' }}>
            {confirmDelete ? (
              <>
                <span>Delete {ing.name} and all {data.purchases.length} purchases?</span>
                <button className="btn danger" onClick={remove} disabled={saving}>Delete</button>
                <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Keep it</button>
              </>
            ) : (
              <>
                {!labor && onMerge && (
                  <button className="btn" onClick={() => onMerge({ first: { ...ing, purchaseCount: data.trips.length } })}>
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

/**
 * A purchase's pack size, editable in place to fix a mis-entered size (saved on Enter or
 * when leaving the field; Escape undoes). The price paid isn't touched.
 */
function PackSizeInput({ purchase, uom, ingredientId, run }) {
  const saved = toDecimal(purchase.packSize).toString();
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);
  const d = toDecimal(value);
  const valid = d && d.gt(0);
  const commit = () => {
    if (!valid) return setValue(saved);
    if (d.eq(saved)) return;
    run(() => api(`/ingredients/${ingredientId}/purchases/${purchase.id}`, { method: 'PATCH', body: { packSize: d.toString() } }),
      `Pack size changed to ${pack(d, uom)}`);
  };
  return (
    <span className="pack-size-edit">
      <input className="input num" inputMode="decimal" value={value} aria-label={`Pack size for the purchase on ${date(purchase.date)}, in ${uom ?? 'units'}`}
        aria-invalid={!valid} onChange={(e) => setValue(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') undo(e, value, saved, setValue); }} />
      {' '}{uom}
    </span>
  );
}

/**
 * A purchase's vendor, editable in place to fill in a missing one or fix a wrong one (saved on
 * Enter or when leaving the field; Escape undoes; blank clears it). Suggests vendors already in use.
 */
function VendorInput({ purchase, ingredientId, run }) {
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
function UsedIn({ usedIn, ing }) {
  const { recipes, blends } = usedIn;
  return (
    <section className="used-in">
      <h3>Used in</h3>
      {!recipes.length && !blends.length ? (
        <small className="muted">No recipes or Spice Lab blends use {ing.name} yet.</small>
      ) : (
        <ul>
          {recipes.map((r) => (
            <li key={r.id}>
              <Link to={`/recipes/${r.id}`}>{r.name}</Link> <TestBadge item={r} />
              <span className="muted">{qty(r.amount)} {ing.uom}</span>
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

/**
 * Labor is a service, not something bought from a vendor: its price is a rate you set here.
 * Each change is stored as a price record (1 × 1 unit at the new rate), so recipe costs pick
 * up the latest rate the same way they pick up an ingredient's latest purchase.
 */
function LaborRate({ ingredient, purchases, run, saving }) {
  const unit = ingredient.uom ?? 'hour';
  const current = ingredient.latestUnitPrice ? toDecimal(ingredient.latestUnitPrice).toFixed(2) : '';
  const [rate, setRate] = useState(current);
  useEffect(() => setRate(current), [current]);
  const d = toDecimal(rate);
  const valid = d && d.gte(0);
  const changed = valid && (!current || !d.eq(current));
  const save = (e) => {
    e.preventDefault();
    run(() => api(`/ingredients/${ingredient.id}/purchases`, {
      method: 'POST',
      body: { date: todayIso(), quantity: 1, packSize: 1, unitCost: d.toString() },
    }), `Rate set to ${perUnit(d, unit)}`);
  };
  return (
    <>
      <form onSubmit={save} className="panel panel-pad labor-rate" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h3>Rate</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label={`Price per ${unit}`}>
            <span className="money-input" style={{ width: 140 }}>
              <span aria-hidden="true">$</span>
              <input className="input num" inputMode="decimal" value={rate} aria-invalid={!valid && rate !== ''} onChange={(e) => setRate(e.target.value)} />
            </span>
          </Field>
          <button className="btn primary" disabled={!changed || saving}>Save rate</button>
        </div>
        <small className="muted">A service cost, not a purchase: recipes use the current rate × the hours on each line.</small>
      </form>
      {purchases.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h3>Rate history</h3>
          <ul className="rate-history">
            {purchases.map((p) => <li key={p.id}><span>{date(p.date)}</span><b>{perUnit(p.unitPrice, unit)}</b></li>)}
          </ul>
        </section>
      )}
    </>
  );
}

const averageUnitPrice = (purchases) =>
  purchases.reduce((sum, p) => sum.plus(p.unitPrice), new Decimal(0)).div(purchases.length);

function Change({ value, hike }) {
  if (value == null) return <span className="muted">—</span>;
  const d = toDecimal(value);
  const cls = hike ? 'price-up' : d.lt(0) ? 'price-down' : '';
  return <span className={cls}>{signedPercent(value)}{hike && <span className="visually-hidden"> (price hike)</span>}</span>;
}
