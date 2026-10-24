import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, notifyDataChanged } from '../api.js';
import { isLabor, laborLast } from '@kitchen/shared';
import { useApi, useDebounced } from '../hooks.js';
import { date, money, pack, perUnit, toDecimal } from '../format.js';
import { NewIngredientForm } from '../components/forms.jsx';
import MergeModal from '../components/MergeModal.jsx';
import { Icon, Modal, Notice, TestBadge, useToast } from '../components/ui.jsx';
import { IngredientDrawer } from '../components/IngredientDrawer.jsx';

const COLUMNS = [
  { key: 'name', label: 'Ingredient' },
  { key: 'category', label: 'Category' },
  { key: 'latestUnitPrice', label: 'Unit cost', num: true },
  { key: 'latestPackSize', label: 'Pack size', num: true },
  { key: 'latestPackPrice', label: 'Store price', num: true },
  { key: 'latestVendor', label: 'Vendor' },
  { key: 'latestPurchaseDate', label: 'Last bought' },
  { key: 'purchaseCount', label: 'Purchases', num: true, title: 'Shopping trips: all the lines of one receipt count once' },
  { key: 'useCount', label: 'Used in', num: true, title: 'Recipes using it (directly or through a blend or sauce), plus the Spice Lab blends and sauces holding it' },
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
                    <td className="num">{r.useCount || <span className="muted">—</span>}</td>
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
