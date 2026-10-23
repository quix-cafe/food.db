import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, notifyDataChanged } from '../api.js';
import { isLabor, laborLast } from '@kitchen/shared';
import { useApi, useDebounced } from '../hooks.js';
import { Decimal, date, money, pack, perUnit, qty, signedPercent, toDecimal, todayIso, unitMoney } from '../format.js';
import { CategoryInput, NewIngredientForm, PurchaseFields, UomInput, emptyPurchase } from '../components/forms.jsx';
import MergeModal from '../components/MergeModal.jsx';
import PriceChart from '../components/PriceChart.jsx';
import { Drawer, Field, Icon, Modal, Notice, Spinner, TestBadge, useToast } from '../components/ui.jsx';

const COLUMNS = [
  { key: 'name', label: 'Ingredient' },
  { key: 'category', label: 'Category' },
  { key: 'latestUnitPrice', label: 'Unit cost', num: true },
  { key: 'latestPackSize', label: 'Pack size', num: true },
  { key: 'latestPackPrice', label: 'Store price', num: true },
  { key: 'latestVendor', label: 'Vendor' },
  { key: 'latestPurchaseDate', label: 'Last bought' },
  { key: 'purchaseCount', label: 'Purchases', num: true },
  { key: 'recipeCount', label: 'Recipes', num: true, title: 'Recipes using it, directly or in a Spice Lab blend or sauce' },
];

const PAGE_SIZES = [25, 50, 100];
const PAGE_SIZE_KEY = 'ingredients.pageSize';

function savedPageSize() {
  try {
    const n = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return PAGE_SIZES.includes(n) ? n : 50;
  } catch {
    return 50;
  }
}

function compare(a, b, key, num) {
  const av = a[key];
  const bv = b[key];
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (num) return toDecimal(av).cmp(toDecimal(bv));
  return String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' });
}

export default function IngredientsPage() {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState(null);
  const [sort, setSort] = useState({ key: 'name', dir: 1 });
  const [adding, setAdding] = useState(false);
  const [pageSize, setPageSize] = useState(savedPageSize);
  const [page, setPage] = useState(1);
  const tableRef = useRef(null);
  const q = useDebounced(filter, 200);
  const { data, error, loading } = useApi(`/ingredients${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const { data: categories } = useApi('/ingredients/categories');
  const { data: duplicates } = useApi('/ingredients/duplicates');
  const [merging, setMerging] = useState(null); // MergeModal props, plus returnTo: the drawer to reopen on cancel
  const toast = useToast();
  const openId = params.get('open');

  const rows = useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sort.key);
    return laborLast((data ?? [])
      .filter((r) => !category || r.category === category)
      .slice()
      .sort((a, b) => sort.dir * compare(a, b, sort.key, col?.num)));
  }, [data, category, sort]);

  // A new filter, sort or page size starts again at page 1. Reloads (after a save) keep the page,
  // clamped in case rows were deleted or merged away.
  useEffect(() => setPage(1), [q, category, sort, pageSize]);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pageCount);
  const pageRows = rows.slice((current - 1) * pageSize, current * pageSize);
  const goTo = (n) => {
    setPage(n);
    const top = tableRef.current?.getBoundingClientRect().top;
    if (top != null && top < 0) tableRef.current.scrollIntoView({ block: 'start' });
  };
  const changePageSize = (n) => {
    setPageSize(n);
    try { localStorage.setItem(PAGE_SIZE_KEY, String(n)); } catch { /* only remembered for this visit */ }
  };

  const toggleSort = (key) => setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 }));
  const open = (id) => setParams(id ? { open: id } : {}, { replace: !id });

  const review = (d, returnTo) => setMerging({ first: d.merge, second: d.keep, keepId: d.keep.id, reason: d.reason, returnTo });
  const dismiss = async (d) => {
    try {
      await api('/ingredients/duplicates/dismiss', { method: 'POST', body: { ids: [d.keep.id, d.merge.id] } });
      notifyDataChanged();
      toast(`Won’t suggest ${d.merge.name} and ${d.keep.name} again`);
    } catch (err) {
      toast(err.message);
    }
  };
  // The merge dialog replaces the drawer (both close on Escape); cancelling brings the drawer back.
  const mergeFromDrawer = (props) => {
    open(null);
    setMerging({ ...props, returnTo: openId });
  };
  const closeMerge = () => {
    const back = merging.returnTo;
    setMerging(null);
    if (back) open(back);
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Ingredients</h1>
          <p>Every ingredient with its most recent purchase price. Open one to see its price history by vendor.</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}><Icon.plus /> New ingredient</button>
      </div>
      {adding && (
        <Modal title="New ingredient" onClose={() => setAdding(false)}>
          <NewIngredientForm onDone={(created) => { setAdding(false); open(created.id); }} />
        </Modal>
      )}

      <DuplicatesNotice duplicates={duplicates} onReview={(d) => review(d)} onDismiss={dismiss} />

      <section className="panel" ref={tableRef}>
        <div className="toolbar">
          {/* Chips on a wide screen; on a phone, where they'd take several rows, a dropdown. */}
          <div className="chips hide-sm" role="group" aria-label="Filter by category">
            <button className="chip" aria-pressed={!category} onClick={() => setCategory(null)}>All</button>
            {(categories ?? []).filter((c) => !isLabor({ category: c })).map((c) => (
              <button key={c} className="chip" aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>{c}</button>
            ))}
          </div>
          <select className="select show-sm category-select" aria-label="Filter by category" value={category ?? ''} onChange={(e) => setCategory(e.target.value || null)}>
            <option value="">All categories</option>
            {(categories ?? []).filter((c) => !isLabor({ category: c })).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input className="input name-filter" style={{ maxWidth: 260 }} type="search" placeholder="Filter by name" aria-label="Filter ingredients by name" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>

        {error && <div className="panel-pad"><Notice kind="error">{error.message}</Notice></div>}
        {rows.length > 0 && (
          <Pager place="top" page={current} pageCount={pageCount} pageSize={pageSize} total={rows.length} onPage={goTo} onPageSize={changePageSize} />
        )}

        {!loading && rows.length === 0 && !error ? (
          <div className="empty">
            <h2>{data?.length || q || category ? 'No ingredients match' : 'No ingredients yet'}</h2>
            <p>{data?.length || q || category ? 'Clear the filters to see everything.' : 'Use Quick add to import a receipt or enter an ingredient by hand.'}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.key} className={c.num ? 'num' : ''} title={c.title} aria-sort={sort.key === c.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
                      <button className="sort-btn" onClick={() => toggleSort(c.key)}>
                        {c.label}
                        {sort.key === c.key && (sort.dir > 0 ? <Icon.up /> : <Icon.down />)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.id} className={`clickable ${isLabor(r) ? 'labor-row' : ''} ${openId === r.id ? 'selected' : ''}`} onClick={() => open(r.id)}>
                    <td>
                      <button className="sort-btn" style={{ fontWeight: 650 }} onClick={(e) => { e.stopPropagation(); open(r.id); }}>{r.name}</button> <TestBadge item={r} />
                    </td>
                    <td>{r.category ?? <span className="muted">—</span>}</td>
                    <td className="num nowrap" style={{ fontWeight: 650 }} title={r.latestLines > 1 ? `Average of ${r.latestLines} lines on the latest receipt` : undefined}>
                      {r.latestUnitPrice ? <>{r.latestLines > 1 && <small className="muted">avg </small>}{perUnit(r.latestUnitPrice, r.uom)}</> : <span className="badge">No price</span>}
                    </td>
                    <td className="num">{!isLabor(r) && r.latestPackSize ? pack(r.latestPackSize, r.uom) : '—'}</td>
                    <td className="num">{!isLabor(r) && r.latestPackPrice ? money(r.latestPackPrice) : '—'}</td>
                    <td>{r.latestVendor ?? '—'}</td>
                    <td className="nowrap">{isLabor(r) ? <span className="muted">Service rate</span> : date(r.latestPurchaseDate)}</td>
                    <td className="num">{isLabor(r) ? '—' : r.purchaseCount}</td>
                    <td className="num">{r.recipeCount || <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 0 && (
          <Pager place="bottom" page={current} pageCount={pageCount} pageSize={pageSize} total={rows.length} onPage={goTo} onPageSize={changePageSize} />
        )}
      </section>

      {openId && (
        <IngredientDrawer
          id={openId}
          onClose={() => open(null)}
          duplicates={(duplicates ?? []).filter((d) => d.keep.id === openId || d.merge.id === openId)}
          onReview={(d) => { open(null); review(d, openId); }}
          onMerge={mergeFromDrawer}
        />
      )}
      {merging && <MergeModal {...merging} onClose={closeMerge} onMerged={(keptId) => { setMerging(null); open(keptId); }} />}
    </main>
  );
}

/** Above and below the table: which rows are showing, how many per page, and previous / next. */
function Pager({ place, page, pageCount, pageSize, total, onPage, onPageSize }) {
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return (
    <nav className={`pager ${place}`} aria-label={`Ingredient pages (${place})`}>
      <span className="muted">{total === 1 ? '1 ingredient' : `${first}–${last} of ${total} ingredients`}</span>
      <label className="pager-size">
        Show
        <select className="select" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        per page
      </label>
      {pageCount > 1 && (
        <span className="pager-nav">
          <button className="btn small" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
          <span aria-live={place === 'top' ? 'polite' : undefined}>Page {page} of {pageCount}</span>
          <button className="btn small" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next</button>
        </span>
      )}
    </nav>
  );
}

/** Ingredients that look like one thing under two names, each with Review merge and Not the same. */
function DuplicatesNotice({ duplicates, onReview, onDismiss }) {
  if (!duplicates?.length) return null;
  return (
    <Notice>
      <b>{duplicates.length === 1 ? 'Possible duplicate' : `${duplicates.length} possible duplicates`}</b>
      <ul className="duplicate-list">
        {duplicates.map((d) => (
          <li key={`${d.merge.id}-${d.keep.id}`}>
            <span>
              <b>{d.merge.name}</b> and <b>{d.keep.name}</b>
              <span className="duplicate-reason">{d.reason}</span>
            </span>
            <span className="duplicate-actions">
              <button className="btn small" onClick={() => onReview(d)}>Review merge</button>
              <button className="btn small ghost" onClick={() => onDismiss(d)}>Not the same</button>
            </span>
          </li>
        ))}
      </ul>
    </Notice>
  );
}

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

/** What one of the ingredient's units weighs, in oz for the details form ('' when not set). */

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
