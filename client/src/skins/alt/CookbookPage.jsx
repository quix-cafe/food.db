// Recipes, and the Spice Lab's sauces and spice blends that go into them. A recipe reads as a line
// on a menu board: its cost, its price, and a bar as long as the price with the food's cost filled in.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, notifyDataChanged } from '../../api.js';
import { useApi } from '../../hooks.js';
import { Decimal, date, money, percent, qty, toDecimal } from '../../format.js';
import { Icon, Menu, Modal, Notice, Spinner, TestBadge, useToast } from '../../components/ui.jsx';
import { AddToEventModal } from '../../pages/RecipeGallery.jsx';
import { BlendPie } from '../../pages/SpiceLabPage.jsx';
import { Segments, SubNav, Tape, count } from './parts.jsx';

export const COOKBOOK_NAV = [
  { to: '/recipes', label: 'Recipes' },
  { to: '/spice-lab', label: 'Spice Lab' },
];

const num = (v) => toDecimal(v) ?? new Decimal(0);
const SORTS = {
  name: ['Name', (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })],
  margin: ['Margin', (a, b) => num(b.targetMargin).cmp(num(a.targetMargin))],
  cost: ['Cost', (a, b) => num(b.costPerServing).cmp(num(a.costPerServing))],
  updated: ['Last changed', (a, b) => b.updatedAt.localeCompare(a.updatedAt)],
};
const SORT_KEY = 'alt.cookbookSort';
const savedSort = () => { try { const k = localStorage.getItem(SORT_KEY); return k in SORTS ? k : 'name'; } catch { return 'name'; } };

/**
 * The price as a bar: its length is the price against the dearest recipe's (`top`), and the food's
 * cost is filled in, so a long bar is a big-ticket dish and a short fill is a good margin.
 */
function PlateBar({ cost, price, top }) {
  const c = toDecimal(cost);
  const p = toDecimal(price);
  if (!c || !p || p.lte(0) || !top.gt(0)) return <span className="plate-track" aria-hidden="true" />;
  const share = Math.min(100, c.div(p).times(100).toNumber());
  return (
    <span className="plate-track" role="img" aria-label={`Food is ${share.toFixed(0)}% of the price`} title={`Cost ${money(c)} of a ${money(p)} price: ${share.toFixed(0)}%`}>
      <span className={`plate-bar ${share >= 100 ? 'over' : ''}`} style={{ width: `${Math.max(3, p.div(top).times(100).toNumber())}%` }}><i style={{ width: `${share}%` }} /></span>
    </span>
  );
}

function Dishes() {
  const { data, error, loading } = useApi('/recipes');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(savedSort);
  const pickSort = (k) => { setSort(k); try { localStorage.setItem(SORT_KEY, k); } catch { /* only for this visit */ } };
  const [addTo, setAddTo] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const navigate = useNavigate();
  const toast = useToast();
  const top = (data ?? []).reduce((m, r) => (num(r.recommendedPrice).gt(m) ? num(r.recommendedPrice) : m), new Decimal(0));
  const shown = (data ?? []).filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase())).sort(SORTS[sort][1]);

  const duplicate = async (r) => {
    try {
      const copy = await api(`/recipes/${r.id}/duplicate`, { method: 'POST' });
      notifyDataChanged();
      toast(`Duplicated as ${copy.name}`);
    } catch (err) {
      toast(err.message);
    }
  };
  const remove = async () => {
    try {
      await api(`/recipes/${deleting.id}`, { method: 'DELETE' });
      notifyDataChanged();
      toast(`Deleted ${deleting.name}`);
    } catch (err) {
      toast(err.message);
    }
    setDeleting(null);
  };

  return (
    <>
      <div className="alt-tools">
        <input className="input" type="search" placeholder="Find a recipe" aria-label="Find a recipe by name" value={q} onChange={(e) => setQ(e.target.value)} />
        <Segments label="Order" value={sort} onChange={pickSort} options={Object.entries(SORTS).map(([k, [label]]) => [k, label])} />
        <Link className="btn primary" to="/recipes/new"><Icon.plus /> New recipe</Link>
      </div>
      {error && <Notice kind="error">{error.message}</Notice>}
      {loading && !data && <Spinner />}
      {data && !data.length && (
        <div className="alt-empty">
          <p>No recipes yet. Build one from your ingredients to see the cost of a serving.</p>
          <Link className="btn primary" to="/recipes/new"><Icon.plus /> Create a recipe</Link>
        </div>
      )}
      {data?.length > 0 && !shown.length && <p className="muted">Nothing matches “{q}”.</p>}
      {shown.length > 0 && (
        <ul className="board">
          <li className="board-labels" aria-hidden="true">
            <span>Recipe</span><span>Cost</span><span>Price, with the food’s cost filled in</span><span>Price</span><span>Margin</span><span />
          </li>
          {shown.map((r) => (
            <li key={r.id} className="board-line">
              <span className="b-name">
                {r.coverImage && <img src={r.coverImage.thumbUrl} alt="" loading="lazy" />}
                <span>
                  {/* The link covers the whole line (CSS), so anywhere on it opens the recipe. */}
                  <Link to={`/recipes/${r.id}`} className="b-link">{r.name}</Link> <TestBadge item={r} />
                  <small>
                    Makes {r.baseServings}, {count(r.ingredientCount, 'ingredient')}, changed {date(new Date(r.updatedAt).toLocaleDateString('en-CA'))}
                    {r.missingPrices > 0 && <span className="badge warn">{r.missingPrices} unpriced</span>}
                  </small>
                </span>
              </span>
              <span className="b-cost" data-label="Cost">{money(r.costPerServing)}</span>
              <PlateBar cost={r.costPerServing} price={r.recommendedPrice} top={top} />
              <span className="b-price" data-label="Price">
                {money(r.recommendedPrice)}
                {r.priceSet && <small><span className="badge" title="Price set by hand: it stays when ingredient costs change">Price set</span></small>}
              </span>
              <span className={`b-margin ${toDecimal(r.profitPerServing)?.lt(0) ? 'loss' : ''}`} data-label="Margin">
                {percent(r.targetMargin, 0)}<small>{money(r.profitPerServing)} profit</small>
              </span>
              <Menu
                label={`Actions for ${r.name}`}
                items={[
                  { label: 'Edit', onSelect: () => navigate(`/recipes/${r.id}`) },
                  { label: 'Duplicate', onSelect: () => duplicate(r) },
                  { label: 'Add to event', onSelect: () => setAddTo(r) },
                  { label: 'Delete', danger: true, onSelect: () => setDeleting(r) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      {addTo && <AddToEventModal recipe={addTo} onClose={() => setAddTo(null)} />}
      {deleting && (
        <Modal title={`Delete ${deleting.name}?`} onClose={() => setDeleting(null)}>
          <p>The recipe and its photos will be removed. Events that used it keep their recorded sales.</p>
          <div className="form-actions">
            <button className="btn ghost" onClick={() => setDeleting(null)}>Keep it</button>
            <button className="btn danger" onClick={remove}>Delete recipe</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Jar({ b }) {
  const sauce = b.kind === 'sauce';
  const names = b.items.map((it) => it.name).filter(Boolean);
  return (
    <li className="jar">
      <BlendPie items={b.items} totalGrams={b.totalGrams} size={64} interactive={false} />
      <span className="j-name">
        <Link to={`/spice-lab/${b.id}`}>{b.name}</Link> <TestBadge item={b} />
        <small>{names.slice(0, 5).join(', ')}{names.length > 5 && ` and ${names.length - 5} more`}</small>
      </span>
      <span className="j-size">
        {sauce ? <>{b.container}<small>{b.servingOz ? `${qty(b.servingOz)} oz servings` : `${qty(b.batchSize)} oz`}</small></>
          : <>{qty(b.totalGrams, 0)} g<small>a batch</small></>}
      </span>
      <span className="j-cost">
        {money(b.cost)}<small>{b.costComplete ? 'cost' : 'cost so far, some unpriced'}</small>
      </span>
      <span className="j-price">
        {sauce && b.salePrice ? <>{money(b.salePrice)}<small>price a serving</small></> : null}
      </span>
    </li>
  );
}

function Lab() {
  const { data, error, loading } = useApi('/blends');
  const sauces = (data ?? []).filter((b) => b.kind === 'sauce');
  const blends = (data ?? []).filter((b) => b.kind !== 'sauce');
  return (
    <>
      <div className="alt-tools">
        <span className="grow muted">Each can go into a recipe like a single ingredient; a sauce can also be sold by the serving.</span>
        <Link className="btn" to="/spice-lab/new-sauce"><Icon.plus /> New sauce</Link>
        <Link className="btn primary" to="/spice-lab/new"><Icon.plus /> New spice blend</Link>
      </div>
      {error && <Notice kind="error">{error.message}</Notice>}
      {loading && !data && <Spinner />}
      {data && !data.length && (
        <div className="alt-empty">
          <p>No sauces or spice blends yet. Start with a few spices and adjust until the balance looks right.</p>
          <Link className="btn primary" to="/spice-lab/new"><Icon.plus /> Create a spice blend</Link>
        </div>
      )}
      {sauces.length > 0 && <section><Tape>Sauces</Tape><ul className="jars">{sauces.map((b) => <Jar key={b.id} b={b} />)}</ul></section>}
      {blends.length > 0 && <section><Tape>Spice blends</Tape><ul className="jars">{blends.map((b) => <Jar key={b.id} b={b} />)}</ul></section>}
    </>
  );
}

export default function CookbookPage({ show }) {
  return (
    <main className="page alt-page cookbook">
      <header className="alt-head">
        <h1>{show === 'lab' ? 'Spice Lab' : 'Recipes'}</h1>
        <SubNav label="Recipes" items={COOKBOOK_NAV} />
      </header>
      {show === 'lab' ? <Lab /> : <Dishes />}
    </main>
  );
}
