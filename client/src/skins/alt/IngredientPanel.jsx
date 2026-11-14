// An ingredient, opened: the answer first (what it costs now, and whether that moved), then one
// thing at a time instead of one long scroll: Price, Purchases, Used in, Details. The data, the
// form and every change are the default panel's (useIngredientPanel), so both save the same way.
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { estimatedCupGrams } from '@kitchen/shared';
import { date, money, pack, perUnit, qty, signedPercent, toDecimal, unitMoney } from '../../format.js';
import { CategoryInput, PurchaseFields, UomInput } from '../../components/forms.jsx';
import PriceChart from '../../components/PriceChart.jsx';
import { Field, Icon, Notice, Spinner, TestBadge } from '../../components/ui.jsx';
import { Change, PurchaseNumberInput, UsedIn, VendorInput, averageUnitPrice, measurable, useIngredientPanel } from '../../components/IngredientDrawer.jsx';
import { DayDot, Segments, count } from './parts.jsx';

/** Where it's been bought, cheapest first, each price as a bar against the dearest. */
function Stores({ vendors, uom }) {
  const rows = [...vendors].sort((a, b) => toDecimal(a.latestUnitPrice).cmp(toDecimal(b.latestUnitPrice)));
  const top = toDecimal(rows.at(-1).latestUnitPrice);
  return (
    <ul className="ip-stores">
      {rows.map((v, i) => (
        <li key={v.vendor}>
          <span className="s-name">
            {v.vendor} {i === 0 && rows.length > 1 && <span className="badge good">Cheapest</span>}
            <small>{pack(v.latestPackSize, uom)} for {unitMoney(v.latestPackPrice)}, {date(v.latestDate)}</small>
          </span>
          <span className="bar" aria-hidden="true"><i style={{ width: `${top.gt(0) ? toDecimal(v.latestUnitPrice).div(top).times(100).toNumber() : 0}%` }} /></span>
          <b>{perUnit(v.latestUnitPrice, uom)}</b>
        </li>
      ))}
    </ul>
  );
}

/** One purchase as a sentence you can correct: packs × size at a price, and what that came to. */
function PurchaseLine({ p, ing, id, run, inTrip, onRemove }) {
  return (
    <li className={`ip-buy ${inTrip ? 'in-trip' : ''}`}>
      {inTrip ? <span className="ip-indent" aria-hidden="true" /> : <DayDot iso={p.date} />}
      <div className="b-top">
        {inTrip ? <span className="muted">One line of it</span> : <VendorInput purchase={p} ingredientId={id} run={run} />}
        <TestBadge item={p} />
        {p.receiptId && !inTrip && <Link to={`/purchases/${p.receiptId}`}>Receipt</Link>}
        <span className="b-unit">
          <b>{perUnit(p.unitPrice, ing.uom)}</b>
          {!inTrip && (
            <small title={p.previous ? `The purchase before: ${perUnit(p.previous.unitPrice, ing.uom)}${p.previous.vendor ? ` at ${p.previous.vendor}` : ''} on ${date(p.previous.date)}` : undefined}>
              <Change value={p.changePercent} hike={p.priceHike} />
            </small>
          )}
        </span>
      </div>
      <div className="b-sum">
        <PurchaseNumberInput purchase={p} field="quantity" ingredientId={id} run={run} />
        <span aria-hidden="true">×</span>
        <PurchaseNumberInput purchase={p} field="packSize" uom={ing.uom} ingredientId={id} run={run} />
        <span>at</span>
        <PurchaseNumberInput purchase={p} field="unitCost" ingredientId={id} run={run} />
        <span aria-hidden="true">=</span>
        <PurchaseNumberInput purchase={p} field="totalCost" ingredientId={id} run={run} />
        <button className="icon-btn" aria-label={`Remove purchase from ${date(p.date)}`} title="Remove this purchase" onClick={() => onRemove(p.id)}><Icon.trash /></button>
      </div>
    </li>
  );
}

const TABS = ['price', 'purchases', 'used', 'details'];

export default function IngredientPanel({ id, onClose, duplicates = [], onReview, onMerge }) {
  const {
    data, error, vendors, ing, form, setForm, dirty, saving, formError, adding, setAdding, purchase, setPurchase, confirmDelete, setConfirmDelete,
    run, save, addPurchase, remove, removeAlias, removePurchase, purchaseById, latest,
  } = useIngredientPanel(id, onClose);
  // The tab stays as you go from one ingredient to the next, so prices or purchases can be compared.
  const [tab, setTab] = useState('price');
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ready = data && form;
  const uses = ready ? data.usedIn.recipes.length + data.usedIn.blends.length : 0;
  const labels = { price: 'Price', purchases: ready ? `Purchases ${data.purchases.length}` : 'Purchases', used: ready ? `Used in ${uses}` : 'Used in', details: 'Details' };
  const moved = latest?.changePercent != null && !toDecimal(latest.changePercent).isZero() ? toDecimal(latest.changePercent) : null;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer ip" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <header className="ip-head">
          <div className="ip-title">
            <h2 id={titleId}>{ing ? <>{ing.name} <TestBadge item={ing} /></> : 'Loading…'}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon.close /></button>
          </div>
          {ready && (
            <>
              <p className="ip-shelf">{ing.category ?? 'No category'}</p>
              {ing.latestUnitPrice ? (
                <div className="ip-price">
                  <b>{perUnit(ing.latestUnitPrice, ing.uom)}</b>
                  {moved && (
                    <span className={latest.priceHike ? 'up hike' : moved.gt(0) ? 'up' : 'down'}
                      title={`The trip before: ${perUnit(latest.previous.unitPrice, ing.uom)}${latest.previous.vendor ? ` at ${latest.previous.vendor}` : ''} on ${date(latest.previous.date)}`}>
                      {moved.gt(0) ? 'Up' : 'Down'} {signedPercent(moved.abs()).replace('+', '')} from {perUnit(latest.previous.unitPrice, ing.uom)}
                    </span>
                  )}
                  <small>
                    {ing.latestLines > 1 ? `Averaged over ${ing.latestLines} lines of one receipt: about ` : ''}{pack(ing.latestPackSize, ing.uom)} for {unitMoney(ing.latestPackPrice)}
                    {latest?.vendor ? ` at ${latest.vendor}` : ''}{latest ? `, ${date(latest.date)}` : ''}
                  </small>
                </div>
              ) : (
                <div className="ip-price none"><b>No price yet</b><small>Record a purchase and recipes using it can be costed.</small></div>
              )}
              <Segments label="Show" value={tab} onChange={setTab} options={TABS.map((t) => [t, labels[t]])} />
            </>
          )}
        </header>

        <div className="drawer-body ip-body">
          {error && <Notice kind="error">{error.message}</Notice>}
          {!data && !error && <Spinner />}
          {ready && duplicates.map((d) => {
            const other = d.keep.id === id ? d.merge : d.keep;
            return (
              <Notice key={other.id}>
                Possibly the same as <b>{other.name}</b>: {d.reason.charAt(0).toLowerCase() + d.reason.slice(1)}.{' '}
                <button className="btn small" onClick={() => onReview(d)}>Review merge</button>
              </Notice>
            );
          })}
          {ready && tab !== 'details' && formError && <Notice kind="error">{formError}</Notice>}

          {ready && tab === 'price' && (
            data.trips.length ? (
              <>
                <PriceChart key={id} purchases={data.trips} uom={ing.uom} />
                {data.trips.length > 1 && (
                  <p className="ip-average" title="The mean of every trip's price per unit, from any store. Several lines of one receipt count once, at their average.">
                    Over {count(data.trips.length, 'trip')} it has averaged <b>{perUnit(averageUnitPrice(data.trips), ing.uom)}</b>.
                  </p>
                )}
                <section>
                  <h3>{data.vendors.length > 1 ? 'Where it’s cheapest' : 'Where it’s bought'}</h3>
                  <Stores vendors={data.vendors} uom={ing.uom} />
                </section>
              </>
            ) : <p className="muted">Nothing bought yet, so there’s no price to chart. <button type="button" className="link-btn" onClick={() => { setTab('purchases'); setAdding(true); }}>Add a purchase</button></p>
          )}

          {ready && tab === 'purchases' && (
            <>
              {adding ? (
                <form className="ip-add" onSubmit={addPurchase}>
                  <PurchaseFields value={purchase} onChange={setPurchase} uom={ing.uom} />
                  <div className="form-actions">
                    <button type="button" className="btn ghost" onClick={() => setAdding(false)}>Cancel</button>
                    <button className="btn primary" disabled={saving}>Record purchase</button>
                  </div>
                </form>
              ) : (
                <div className="ip-row">
                  <small className="muted">Type over a number or a store to correct it.</small>
                  <button className="btn small primary" onClick={() => setAdding(true)}><Icon.plus /> Add a purchase</button>
                </div>
              )}
              {!data.purchases.length && <p className="muted">No purchases yet.</p>}
              <ul className="ip-buys">
                {data.trips.map((t) => {
                  const lines = t.purchaseIds.map((pid) => purchaseById.get(pid));
                  if (t.lines === 1) return <PurchaseLine key={lines[0].id} p={lines[0]} ing={ing} id={id} run={run} onRemove={removePurchase} />;
                  return (
                    <li key={t.id} className="ip-trip">
                      <div className="ip-buy">
                        <DayDot iso={t.date} />
                        <div className="b-top">
                          <b>{t.vendor ?? 'Unknown vendor'}</b>
                          {t.receiptId && <Link to={`/purchases/${t.receiptId}`}>Receipt</Link>}
                          <span className="b-unit">
                            <b title="What this receipt spent on it ÷ how much it bought">{perUnit(t.unitPrice, ing.uom)}</b>
                            <small title={t.previous ? `The trip before: ${perUnit(t.previous.unitPrice, ing.uom)}${t.previous.vendor ? ` at ${t.previous.vendor}` : ''} on ${date(t.previous.date)}` : undefined}><Change value={t.changePercent} hike={t.priceHike} /></small>
                          </span>
                        </div>
                        <div className="b-sum plain">
                          {t.lines} lines on one receipt, averaged: {qty(t.quantity)} × about {pack(t.packSize, ing.uom)} for {money(t.totalCost)}
                        </div>
                      </div>
                      <ul>{lines.map((p) => <PurchaseLine key={p.id} p={p} ing={ing} id={id} run={run} inTrip onRemove={removePurchase} />)}</ul>
                    </li>
                  );
                })}
              </ul>
              <datalist id="vendor-options">{(vendors ?? []).map((v) => <option key={v} value={v} />)}</datalist>
            </>
          )}

          {ready && tab === 'used' && <UsedIn usedIn={data.usedIn} ing={ing} />}

          {ready && tab === 'details' && (
            <>
              <form className="ip-form" onSubmit={save}>
                <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
                <div className="ip-pair">
                  <Field label="Category"><CategoryInput value={form.category} onChange={(category) => setForm((f) => ({ ...f, category }))} /></Field>
                  <Field label="Unit of measurement" hint="Pack sizes and recipe amounts are in this unit; changing it doesn’t convert them.">
                    <UomInput value={form.uom} onChange={(uom) => setForm((f) => ({ ...f, uom }))} required />
                  </Field>
                </div>
                {measurable(form.uom) && (
                  <Field label="1 cup weighs (g)" hint={`So recipes can use ${measurable(form.uom) === 'weight' ? 'cups and spoons' : 'ounces and grams'} of it. Blank: an estimate by name where there is one.`}>
                    <input className="input num" inputMode="decimal" value={form.cupGrams} aria-label="Grams in one cup"
                      placeholder={estimatedCupGrams(form.name) ? `about ${estimatedCupGrams(form.name)}` : 'e.g. 185 for rice'}
                      onChange={(e) => setForm((f) => ({ ...f, cupGrams: e.target.value }))} />
                  </Field>
                )}
                {formError && <Notice kind="error">{formError}</Notice>}
                <div className="form-actions"><button className="btn primary" disabled={!dirty || saving}>Save changes</button></div>
              </form>

              <section>
                <h3>Names on receipts</h3>
                {data.aliases.length ? (
                  <>
                    <div className="alias-list">
                      {data.aliases.map((a) => (
                        <span key={a.id} className="badge">
                          {a.alias}{a.ambiguous && <span className="muted" title="Only suggested on new receipts: one receipt used this name for several ingredients"> (asks)</span>}
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

              <section className="ip-danger">
                {confirmDelete ? (
                  <>
                    <span>Delete {ing.name} and all {count(data.purchases.length, 'purchase')}?</span>
                    <button className="btn danger" onClick={remove} disabled={saving}>Delete</button>
                    <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Keep it</button>
                  </>
                ) : (
                  <>
                    {onMerge && (
                      <button className="btn" onClick={() => onMerge({ first: { ...ing, purchaseCount: data.purchases.length } })}>Merge into another ingredient…</button>
                    )}
                    <button className="btn danger" onClick={() => setConfirmDelete(true)}><Icon.trash /> Delete ingredient</button>
                  </>
                )}
                <small className="muted">Asset ID {ing.id.slice(0, 8)}</small>
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
