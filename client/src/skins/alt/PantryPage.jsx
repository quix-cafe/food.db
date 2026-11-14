// The pantry: every ingredient on its shelf (its category), with what it costs now. On a wide
// screen the ingredient you open sits beside the list instead of over it (theme.css docks the drawer).
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, notifyDataChanged } from '../../api.js';
import { useApi, useDebounced } from '../../hooks.js';
import { Decimal, date, money, pack, perUnit, toDecimal } from '../../format.js';
import { NewIngredientForm } from '../../components/forms.jsx';
import MergeModal from '../../components/MergeModal.jsx';
import { Icon, Modal, Notice, Spinner, TestBadge, useToast } from '../../components/ui.jsx';
import { IngredientDrawer } from '../../components/IngredientDrawer.jsx';
import { DuplicatesNotice } from '../../pages/IngredientsPage.jsx';
import { Segments, SubNav, Tape, count } from './parts.jsx';

export const PANTRY_NAV = [
  { to: '/ingredients', label: 'Ingredients' },
  { to: '/purchases', label: 'Receipts' },
];

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const num = (v) => toDecimal(v) ?? new Decimal(-1);
// By name the pantry is shelved by category; any other order is one list, since the order is the point.
const SORTS = {
  name: ['Name', byName],
  recent: ['Last bought', (a, b) => (b.latestPurchaseDate ?? '').localeCompare(a.latestPurchaseDate ?? '') || byName(a, b)],
  cost: ['Total cost', (a, b) => num(b.latestPackPrice).cmp(num(a.latestPackPrice)) || byName(a, b)], // what a pack costs, not per unit
  used: ['Most used', (a, b) => b.useCount - a.useCount || byName(a, b)],
};
const NO_SHELF = 'No category';
const shelfOf = (r) => r.category ?? NO_SHELF;

export default function PantryPage() {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('name');
  const [adding, setAdding] = useState(false);
  const q = useDebounced(filter, 200);
  const { data, error, loading } = useApi(`/ingredients${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const { data: duplicates } = useApi('/ingredients/duplicates');
  const [merging, setMerging] = useState(null); // MergeModal props, plus returnTo: the drawer to reopen on cancel
  const toast = useToast();
  const openId = params.get('open');
  const open = (id) => setParams(id ? { open: id } : {}, { replace: !id });

  // The category picked in the sidebar: only its ingredients show. null: all of them.
  const [shelf, setShelf] = useState(null);
  // Every category with its count, in name order, the uncategorised one last.
  const categories = useMemo(() => {
    const counts = new Map();
    for (const r of data ?? []) counts.set(shelfOf(r), (counts.get(shelfOf(r)) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => (a === NO_SHELF) - (b === NO_SHELF) || a.localeCompare(b));
  }, [data]);
  const picked = shelf && categories.some(([name]) => name === shelf) ? shelf : null; // a search can empty the picked one
  // What's listed: by name, a shelf per category; any other order, one list (under its heading when one category is picked).
  const shelves = useMemo(() => {
    const rows = (data ?? []).filter((r) => !picked || shelfOf(r) === picked);
    if (sort !== 'name') return rows.length ? [{ name: picked, rows: rows.sort(SORTS[sort][1]) }] : [];
    return categories
      .filter(([name]) => !picked || name === picked)
      .map(([name]) => ({ name, rows: rows.filter((r) => shelfOf(r) === name).sort(byName) }));
  }, [data, categories, picked, sort]);
  const total = data?.length ?? 0;

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
  const closeMerge = () => {
    const back = merging.returnTo;
    setMerging(null);
    if (back) open(back);
  };

  return (
    <main className={`page alt-page pantry ${openId ? 'has-open' : ''}`}>
      <header className="alt-head">
        <h1>Pantry</h1>
        <SubNav label="Pantry" items={PANTRY_NAV} />
      </header>
      <div className="alt-tools">
        <span className="name-filter">
          <input className="input" type="search" placeholder="Find an ingredient" aria-label="Find an ingredient by name or receipt name" value={filter} onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && filter) { e.preventDefault(); setFilter(''); } }} />
          {filter && <button type="button" className="clear-filter" aria-label="Clear" title="Clear" onClick={(e) => { setFilter(''); e.currentTarget.previousElementSibling.focus(); }}><Icon.close /></button>}
        </span>
        <Segments label="Order" value={sort} onChange={setSort} options={Object.entries(SORTS).map(([k, [label]]) => [k, label])} />
        <button className="btn primary" onClick={() => setAdding(true)}><Icon.plus /> New ingredient</button>
      </div>
      {adding && (
        <Modal title="New ingredient" onClose={() => setAdding(false)}>
          <NewIngredientForm onDone={(created) => { setAdding(false); open(created.id); }} />
        </Modal>
      )}

      <DuplicatesNotice duplicates={duplicates} onReview={(d) => review(d)} onDismiss={dismiss} />
      {error && <Notice kind="error">{error.message}</Notice>}
      {loading && !data && <Spinner />}
      {data && !total && (
        <div className="alt-empty">
          <p>{q ? `Nothing matches “${q}”.` : 'No ingredients yet. Add one by hand, or import a receipt and they come in with their prices.'}</p>
        </div>
      )}

      {total > 0 && (
        <div className="shelves">
          <nav className="shelf-index" aria-label="Show a category">
            <select className="select" aria-label="Show a category" value={picked ?? ''} onChange={(e) => setShelf(e.target.value || null)}>
              <option value="">All items ({total})</option>
              {categories.map(([name, n]) => <option key={name} value={name}>{name} ({n})</option>)}
            </select>
            <ul>
              <li><button type="button" aria-pressed={!picked} onClick={() => setShelf(null)}><span>All items</span><small>{total}</small></button></li>
              {categories.map(([name, n]) => (
                <li key={name}><button type="button" aria-pressed={picked === name} onClick={() => setShelf(name)}><span>{name}</span><small>{n}</small></button></li>
              ))}
            </ul>
          </nav>
          <div className="shelf-list">
            {shelves.map((s) => (
              <section key={s.name ?? 'all'} className="shelf">
                {s.name && <div className="shelf-head"><Tape>{s.name}</Tape><small>{s.rows.length}</small></div>}
                <ul className={s.name ? '' : 'flat'}>
                  {s.rows.map((r) => (
                    <li key={r.id} className={openId === r.id ? 'open' : ''}>
                      <button type="button" onClick={() => open(r.id)} aria-label={`Open ${r.name}`}>
                        <span className="i-name">{r.name} <TestBadge item={r} />{!s.name && <small>{shelfOf(r)}</small>}</span>
                        <span className="i-price" title={r.latestLines > 1 ? `Average of ${r.latestLines} lines on the latest receipt` : undefined}>
                          {r.latestUnitPrice ? perUnit(r.latestUnitPrice, r.uom) : <span className="badge">No price</span>}
                        </span>
                        <span className="i-pack">{r.latestPackPrice ? <><b>{money(r.latestPackPrice)}</b> for {pack(r.latestPackSize, r.uom)}</> : ''}</span>
                        <span className="i-where">{r.latestVendor ?? ''}{r.latestPurchaseDate && <small>{date(r.latestPurchaseDate)}</small>}</span>
                        <span className="i-used" title="Recipes, sauces and spice blends using it">{r.useCount ? `in ${r.useCount}` : ''}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}

      {total > 0 && !openId && <aside className="pantry-side" aria-hidden="true"><p>Open an ingredient to see its price history, where it was bought and what uses it.</p></aside>}
      {openId && (
        <IngredientDrawer
          id={openId}
          onClose={() => open(null)}
          duplicates={(duplicates ?? []).filter((d) => d.keep.id === openId || d.merge.id === openId)}
          onReview={(d) => { open(null); review(d, openId); }}
          onMerge={(props) => { open(null); setMerging({ ...props, returnTo: openId }); }}
        />
      )}
      {merging && <MergeModal {...merging} onClose={closeMerge} onMerged={(keptId) => { setMerging(null); open(keptId); }} />}
    </main>
  );
}
