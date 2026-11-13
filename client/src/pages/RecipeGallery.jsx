import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, notifyDataChanged } from '../api.js';
import { useApi } from '../hooks.js';
import { Decimal, date, money, percent, qty, toDecimal, todayIso } from '../format.js';
import { Field, Icon, Menu, Modal, Notice, Spinner, TestBadge, useToast } from '../components/ui.jsx';
import { DealToggle, MarginCell, SalePriceInput, blankOrPrice, dealNote, dealProblem, priceText, pricingFor } from '../components/EventPricing.jsx';

// Grid of cards or a table, remembered per browser.
const VIEW_KEY = 'recipesView';
const savedView = () => { try { return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'grid'; } catch { return 'grid'; } };

// The table's columns, each sortable: `value` is what it sorts by (a number for `num` columns),
// `first` the direction a click starts in (largest first for money and counts).
const RECIPE_COLUMNS = [
  { key: 'name', label: 'Recipe', first: 1, value: (r) => r.name },
  { key: 'cost', label: 'Cost / serving', num: true, first: -1, value: (r) => r.costPerServing },
  { key: 'price', label: 'Price', num: true, first: -1, value: (r) => r.recommendedPrice },
  { key: 'profit', label: 'Profit / serving', num: true, first: -1, value: (r) => r.profitPerServing },
  { key: 'margin', label: 'Margin', num: true, first: -1, value: (r) => r.targetMargin },
  { key: 'servings', label: 'Servings', num: true, first: -1, value: (r) => r.baseServings },
  { key: 'batch', label: 'Batch profit', num: true, first: -1, value: (r) => r.batchProfit },
  { key: 'ingredients', label: 'Ingredients', num: true, first: -1, value: (r) => r.ingredientCount },
  { key: 'updated', label: 'Updated', first: -1, value: (r) => r.updatedAt },
];

function compareRecipes(a, b, col) {
  const [x, y] = [col.value(a), col.value(b)];
  if (col.num) return (toDecimal(x) ?? new Decimal(0)).comparedTo(toDecimal(y) ?? new Decimal(0));
  return String(x).localeCompare(String(y), undefined, { sensitivity: 'base' });
}

export default function RecipeGallery() {
  const { data, error, loading } = useApi('/recipes');
  const [view, setView] = useState(savedView);
  const pickView = (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* only for this visit */ } };
  const [sort, setSort] = useState({ key: 'name', dir: 1 });
  const toggleSort = (c) => setSort((was) => ({ key: c.key, dir: was.key === c.key ? -was.dir : c.first }));
  const col = RECIPE_COLUMNS.find((c) => c.key === sort.key);
  const sorted = (data ?? []).slice().sort((a, b) => sort.dir * compareRecipes(a, b, col) || a.name.localeCompare(b.name));
  const [addTo, setAddTo] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const navigate = useNavigate();
  const toast = useToast();

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
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Recipes</h1>
          <p>Costs use each ingredient’s most recent purchase price.</p>
        </div>
        <div className="form-actions">
          <div className="view-toggle" role="group" aria-label="Show recipes as">
            <button type="button" className="btn small" aria-pressed={view === 'grid'} onClick={() => pickView('grid')}>Grid</button>
            <button type="button" className="btn small" aria-pressed={view === 'table'} onClick={() => pickView('table')}>Table</button>
          </div>
          <Link className="btn primary" to="/recipes/new"><Icon.plus /> New recipe</Link>
        </div>
      </div>

      {error && <Notice kind="error">{error.message}</Notice>}
      {loading && !data && <Spinner />}
      {data && !data.length && (
        <div className="panel empty">
          <h2>No recipes yet</h2>
          <p>Build one from ingredients in the database to see its cost per serving.</p>
          <Link className="btn primary" to="/recipes/new">Create a recipe</Link>
        </div>
      )}

      {view === 'table' && !!data?.length && (
        <div className="panel table-wrap">
          <table className="grid recipe-table">
            <thead>
              <tr>
                {RECIPE_COLUMNS.map((c) => (
                  <th key={c.key} className={c.num ? 'num' : undefined} aria-sort={sort.key === c.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" className="sort-btn" onClick={() => toggleSort(c)}>
                      {c.label}
                      {sort.key === c.key && (sort.dir > 0 ? <Icon.up /> : <Icon.down />)}
                    </button>
                  </th>
                ))}
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="recipe-cell">
                      {r.coverImage ? <img src={r.coverImage.thumbUrl} alt="" loading="lazy" /> : <span className="no-cover" aria-hidden="true" />}
                      <span>
                        <Link to={`/recipes/${r.id}`} style={{ fontWeight: 650 }}>{r.name}</Link> <TestBadge item={r} />
                        {(r.priceSet || r.missingPrices > 0) && (
                          <span className="recipe-cell-badges">
                            {r.priceSet && <span className="badge" title="Menu price set by hand: it stays when ingredient costs change">Price set</span>}
                            {r.missingPrices > 0 && <span className="badge warn">{r.missingPrices} unpriced</span>}
                          </span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td className="num">{money(r.costPerServing)}</td>
                  <td className="num">{money(r.recommendedPrice)}</td>
                  <td className="num" style={{ color: toDecimal(r.profitPerServing)?.lt(0) ? 'var(--tomato)' : undefined }}>{money(r.profitPerServing)}</td>
                  <td className="num">{percent(r.targetMargin, 0)}</td>
                  <td className="num">{r.baseServings}</td>
                  <td className="num">{money(r.batchProfit)}</td>
                  <td className="num">{r.ingredientCount}</td>
                  <td className="nowrap muted">{date(new Date(r.updatedAt).toLocaleDateString('en-CA'))}</td>
                  <td>
                    <Menu
                      label={`Actions for ${r.name}`}
                      items={[
                        { label: 'Edit', onSelect: () => navigate(`/recipes/${r.id}`) },
                        { label: 'Duplicate', onSelect: () => duplicate(r) },
                        { label: 'Add to event', onSelect: () => setAddTo(r) },
                        { label: 'Delete', danger: true, onSelect: () => setDeleting(r) },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === 'grid' && <div className="gallery">
        {(data ?? []).map((r) => (
          <article key={r.id} className="panel recipe-card">
            {r.coverImage && (
              <div className="card-cover"><img src={r.coverImage.thumbUrl} alt="" loading="lazy" /></div>
            )}
            <h3><Link to={`/recipes/${r.id}`}>{r.name}</Link> <TestBadge item={r} /></h3>
            <Menu
              label={`Actions for ${r.name}`}
              items={[
                { label: 'Edit', onSelect: () => navigate(`/recipes/${r.id}`) },
                { label: 'Duplicate', onSelect: () => duplicate(r) },
                { label: 'Add to event', onSelect: () => setAddTo(r) },
                { label: 'Delete', danger: true, onSelect: () => setDeleting(r) },
              ]}
            />
            <dl className="card-figures" aria-label="Per serving">
              <div><dt>Cost</dt><dd>{money(r.costPerServing)}</dd></div>
              <div><dt>Price</dt><dd>{money(r.recommendedPrice)}</dd></div>
              <div className={toDecimal(r.profitPerServing)?.lt(0) ? 'loss' : 'profit'}><dt>Profit</dt><dd>{money(r.profitPerServing)}</dd></div>
            </dl>
            <div className="card-pills">
              <span className={`badge ${toDecimal(r.targetMargin)?.lt(0) ? 'warn' : 'good'}`}>{percent(r.targetMargin, 0)} margin</span>
              {r.priceSet && <span className="badge" title="Menu price set by hand: it stays when ingredient costs change">Price set</span>}
              <span className="badge">{r.baseServings} servings</span>
              <span className="badge">{money(r.batchProfit)} batch profit</span>
              {r.missingPrices > 0 && <span className="badge warn">{r.missingPrices} unpriced</span>}
            </div>
            <div className="card-meta">
              <span>{r.ingredientCount} ingredient{r.ingredientCount === 1 ? '' : 's'}{r.imageCount > 1 ? `, ${r.imageCount} photos` : ''}</span>
              {!r.lastPriceSync && <span>No prices yet</span>}
              <span className="nowrap">Updated {date(new Date(r.updatedAt).toLocaleDateString('en-CA'))}</span>
            </div>
          </article>
        ))}
      </div>}

      {addTo && <AddToEventModal recipe={addTo} onClose={() => setAddTo(null)} />}
      {deleting && (
        <Modal title={`Delete ${deleting.name}?`} onClose={() => setDeleting(null)}>
          <p>The recipe will also be removed from any events that use it.</p>
          <div className="form-actions">
            <button className="btn ghost" onClick={() => setDeleting(null)}>Keep it</button>
            <button className="btn danger" onClick={remove}>Delete recipe</button>
          </div>
        </Modal>
      )}
    </main>
  );
}

export function AddToEventModal({ recipe, onClose }) {
  const { data: events } = useApi('/events');
  const [eventId, setEventId] = useState('new');
  const [newName, setNewName] = useState('');
  const [newDate, setNewDate] = useState(todayIso());
  const [servings, setServings] = useState(String(recipe.baseServings));
  const [pricing, setPricing] = useState({ salePrice: '', dealPrice: '', dealQty: '' });
  const priced = pricingFor(recipe, pricing);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();
  const upcoming = (events ?? []).filter((e) => e.date >= todayIso());

  const submit = async (e) => {
    e.preventDefault();
    if (!blankOrPrice(pricing.salePrice)) return setError('Prices must be amounts, like 4.50');
    if (dealProblem(pricing)) return setError(dealProblem(pricing));
    setBusy(true);
    setError(null);
    try {
      let id = eventId;
      if (id === 'new') {
        const created = await api('/events', { method: 'POST', body: { name: newName, date: newDate, guestCount: servings } });
        id = created.id;
      }
      // Only what was filled in: a recipe already in the event keeps its price and deal otherwise.
      const body = { recipeId: recipe.id, expectedServings: servings };
      if (pricing.salePrice.trim()) body.salePrice = priceText(pricing.salePrice);
      if (pricing.dealPrice.trim()) Object.assign(body, { dealPrice: priceText(pricing.dealPrice), dealQty: pricing.dealQty.trim() });
      const ev = await api(`/events/${id}/recipes`, { method: 'POST', body });
      notifyDataChanged();
      toast(`Added ${recipe.name} to ${ev.name}`);
      onClose();
      navigate(`/events/${id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Add ${recipe.name} to an event`} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Event">
          <select className="select" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="new">New event…</option>
            {upcoming.map((ev) => <option key={ev.id} value={ev.id}>{ev.name}, {date(ev.date)}</option>)}
          </select>
        </Field>
        {eventId === 'new' && (
          <div className="form-grid">
            <Field label="Event name" className="span-2"><input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} required /></Field>
            <Field label="Date"><input className="input" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} required /></Field>
          </div>
        )}
        <Field label="Servings for this event" hint={`The recipe makes ${recipe.baseServings}; it will be scaled.`}>
          <input className="input num" style={{ maxWidth: 140 }} inputMode="numeric" value={servings} onChange={(e) => setServings(e.target.value)} required />
        </Field>
        <div className="form-grid">
          <Field label="Sale price per serving" hint="Starts at the recipe’s target price. Changing it sets the price for this event only.">
            <SalePriceInput id="add-sale-price" value={pricing.salePrice} recipePrice={recipe.recommendedPrice} label="Sale price per serving"
              onChange={(salePrice) => setPricing((p) => ({ ...p, salePrice }))} />
          </Field>
          <Field label="Discount (optional)" hint="For a deal like 3 for $15.">
            <DealToggle qty={pricing.dealQty} price={pricing.dealPrice} saved={recipe} label="Discount" note={dealNote(pricing, priced)}
              onChange={(patch) => setPricing((p) => ({ ...p, ...patch }))} />
          </Field>
        </div>
        {recipe.costPerServing != null && (
          <p className="muted" style={{ margin: 0 }}>
            Margin per serving: <b><MarginCell pricing={priced} /></b> (cost {money(recipe.costPerServing)})
          </p>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>Add to event</button>
        </div>
      </form>
    </Modal>
  );
}
