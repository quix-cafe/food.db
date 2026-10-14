import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { calculateRecipe, DEFAULT_MARGIN } from '@kitchen/shared';
import { api, notifyDataChanged } from '../api.js';
import { date, money, qty, unitMoney, toDecimal } from '../format.js';
import IngredientCombobox from '../components/IngredientCombobox.jsx';
import { Field, Icon, Notice, Spinner, useToast } from '../components/ui.jsx';
import { AddToEventModal } from './RecipeGallery.jsx';

let nextKey = 1;
const blank = { name: '', baseServings: '4', totalYield: '', yieldUnit: '', targetMargin: String(DEFAULT_MARGIN), lines: [] };

const fromServer = (r) => ({
  name: r.name,
  baseServings: String(r.baseServings),
  totalYield: r.totalYield ? toDecimal(r.totalYield).toString() : '',
  yieldUnit: r.yieldUnit ?? '',
  targetMargin: toDecimal(r.targetMargin).toString(),
  lines: r.lines.map((l) => ({
    key: nextKey++,
    ingredientId: l.ingredientId,
    name: l.name,
    unit: l.unit,
    unitCost: l.unitCost,
    priceDate: l.priceDate,
    usePercent: toDecimal(l.usePercent).toString(),
    baseQuantity: toDecimal(l.baseQuantity).toString(),
  })),
});

const savedShape = (f) => JSON.stringify({ ...f, lines: f.lines.map(({ ingredientId, usePercent, baseQuantity }) => ({ ingredientId, usePercent, baseQuantity })) });

export default function RecipeBuilder() {
  const { id } = useParams();
  const [form, setForm] = useState(id ? null : blank);
  const [saved, setSaved] = useState(id ? null : savedShape(blank));
  const [expected, setExpected] = useState(id ? '' : blank.baseServings);
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [drag, setDrag] = useState({ from: null, over: null });
  const [addToEvent, setAddToEvent] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  useEffect(() => {
    if (!id) {
      setForm(blank);
      setSaved(savedShape(blank));
      setExpected(blank.baseServings);
      return;
    }
    let stale = false;
    api(`/recipes/${id}`)
      .then((r) => {
        if (stale) return;
        const f = fromServer(r);
        setForm(f);
        setSaved(savedShape(f));
        setExpected(f.baseServings);
      })
      .catch((err) => !stale && setLoadError(err.message));
    return () => { stale = true; };
  }, [id]);

  const dirty = form && saved !== savedShape(form);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Instant, client-side costing with the same decimal math the API uses.
  const { costing, calcError } = useMemo(() => {
    if (!form) return {};
    try {
      return {
        costing: calculateRecipe({
          lines: form.lines,
          baseServings: form.baseServings,
          expectedServings: toDecimal(expected) ? expected : form.baseServings,
          targetMargin: form.targetMargin,
          totalYield: form.totalYield,
        }),
      };
    } catch (err) {
      return { calcError: err.message };
    }
  }, [form, expected]);

  if (loadError) return <main className="page"><Notice kind="error">{loadError}</Notice><Link to="/recipes">Back to recipes</Link></main>;
  if (!form) return <main className="page"><Spinner /></main>;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setLine = (key, patch) => setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const removeLine = (key) => setForm((f) => ({ ...f, lines: f.lines.filter((l) => l.key !== key) }));
  const move = (from, to) => setForm((f) => {
    if (to < 0 || to >= f.lines.length || from === to) return f;
    const lines = f.lines.slice();
    const [item] = lines.splice(from, 1);
    lines.splice(to, 0, item);
    return { ...f, lines };
  });
  const addIngredient = (ing) => {
    setForm((f) => ({
      ...f,
      lines: [...f.lines, {
        key: nextKey++,
        ingredientId: ing.id,
        name: ing.name,
        unit: ing.latestUnit,
        unitCost: ing.latestUnitCost,
        priceDate: ing.latestPurchaseDate,
        usePercent: toDecimal(ing.defaultYieldPercent).toString(),
        baseQuantity: '1',
      }],
    }));
    setSearch('');
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body = { ...form, lines: form.lines.map(({ ingredientId, usePercent, baseQuantity }) => ({ ingredientId, usePercent, baseQuantity })) };
      const r = await api(id ? `/recipes/${id}` : '/recipes', { method: id ? 'PUT' : 'POST', body });
      const f = fromServer(r);
      setForm(f);
      setSaved(savedShape(f));
      notifyDataChanged();
      toast(id ? 'Recipe saved' : 'Recipe created');
      if (!id) navigate(`/recipes/${r.id}`, { replace: true });
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const lineById = new Map((costing?.lines ?? []).map((l) => [l.key, l]));
  const scaled = costing && costing.scale !== '1';

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <Link to="/recipes" className="muted">Recipes</Link>
          <h1>{form.name || (id ? 'Untitled recipe' : 'New recipe')}</h1>
        </div>
        <div className="form-actions">
          {id && <button className="btn" onClick={() => setAddToEvent(true)}>Add to event</button>}
          <button className="btn primary" disabled={(!dirty && !!id) || saving} onClick={save}>
            {saving && <Spinner />} {id ? (dirty ? 'Save changes' : 'Saved') : 'Create recipe'}
          </button>
        </div>
      </div>
      {saveError && <Notice kind="error">{saveError}</Notice>}

      <div className="builder">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <section className="panel panel-pad">
            <div className="form-grid">
              <Field label="Recipe name" className="span-2"><input className="input" value={form.name} onChange={set('name')} placeholder="e.g. Marinara sauce" /></Field>
              <Field label="Base servings" hint="What the recipe makes as written"><input className="input num" inputMode="numeric" value={form.baseServings} onChange={set('baseServings')} /></Field>
              <Field label="Total yield"><input className="input num" inputMode="decimal" value={form.totalYield} onChange={set('totalYield')} placeholder="Optional" /></Field>
              <Field label="Yield unit"><input className="input" value={form.yieldUnit} onChange={set('yieldUnit')} placeholder="qt, portions…" /></Field>
              <Field label="Target margin %"><input className="input num" inputMode="decimal" value={form.targetMargin} onChange={set('targetMargin')} /></Field>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Ingredients</h2>
              <span className="muted">Cost = unit cost × Use % × quantity</span>
            </div>
            <div className="table-wrap">
              <table className="grid builder-lines">
                <thead>
                  <tr>
                    <th style={{ width: 28 }}><span className="visually-hidden">Reorder</span></th>
                    <th style={{ minWidth: 180 }}>Ingredient</th>
                    <th className="num">Unit cost</th>
                    <th className="num">Qty</th>
                    <th className="num">Use %</th>
                    <th className="num">Cost</th>
                    {scaled && <th className="num">Scaled qty</th>}
                    {scaled && <th className="num">Scaled cost</th>}
                    <th><span className="visually-hidden">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {form.lines.map((l, i) => {
                    const c = lineById.get(l.key);
                    return (
                      <tr
                        key={l.key}
                        className={`${drag.from === i ? 'dragging' : ''} ${drag.over === i && drag.from !== i ? 'drop-target' : ''}`}
                        onDragOver={(e) => { if (drag.from !== null) { e.preventDefault(); setDrag((d) => ({ ...d, over: i })); } }}
                        onDrop={(e) => { e.preventDefault(); move(drag.from, i); setDrag({ from: null, over: null }); }}
                      >
                        <td>
                          <button
                            className="icon-btn drag-handle"
                            draggable
                            aria-label={`Move ${l.name} (use arrow keys)`}
                            onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDrag({ from: i, over: i }); }}
                            onDragEnd={() => setDrag({ from: null, over: null })}
                            onKeyDown={(e) => {
                              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                                e.preventDefault();
                                move(i, i + (e.key === 'ArrowUp' ? -1 : 1));
                                requestAnimationFrame(() => e.target.focus());
                              }
                            }}
                          ><Icon.grip /></button>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{l.name}</div>
                          {c?.missingPrice
                            ? <span className="badge warn">No purchase price</span>
                            : <small className="muted">per {l.unit ?? 'unit'}, bought {date(l.priceDate)}</small>}
                        </td>
                        <td className="num">{l.unitCost ? unitMoney(l.unitCost) : '—'}</td>
                        <td><input className="input num" style={{ width: 80 }} inputMode="decimal" value={l.baseQuantity} aria-label={`${l.name} quantity`} aria-invalid={!toDecimal(l.baseQuantity)} onChange={(e) => setLine(l.key, { baseQuantity: e.target.value })} /></td>
                        <td><input className="input num" style={{ width: 72 }} inputMode="decimal" value={l.usePercent} aria-label={`${l.name} use percent`} aria-invalid={!toDecimal(l.usePercent)} onChange={(e) => setLine(l.key, { usePercent: e.target.value })} /></td>
                        <td className="num">{c ? money(c.baseCost) : '—'}</td>
                        {scaled && <td className="num scaled">{c ? `${qty(c.scaledQuantity)}` : '—'}</td>}
                        {scaled && <td className="num scaled">{c ? money(c.scaledCost) : '—'}</td>}
                        <td><button className="icon-btn" aria-label={`Remove ${l.name}`} onClick={() => removeLine(l.key)}><Icon.trash /></button></td>
                      </tr>
                    );
                  })}
                  {!form.lines.length && (
                    <tr><td colSpan={9} className="muted" style={{ padding: 18 }}>Add ingredients from the database using the search below.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="panel-pad">
              <IngredientCombobox
                ariaLabel="Add an ingredient"
                value={search}
                onInput={setSearch}
                onPick={addIngredient}
                exclude={form.lines.map((l) => l.ingredientId)}
                placeholder="Add an ingredient…"
                footer={(q) => q.trim() && (
                  <div className="option muted" style={{ cursor: 'default' }}>Not listed? Add “{q.trim()}” to the database with Quick add first.</div>
                )}
              />
            </div>
          </section>
        </div>

        <aside className="ticket-rail" aria-label="Financials">
          <div className="ticket">
            <div className="ticket-title">
              <h2>Costing</h2>
              {costing && <span className={scaled ? 'scaled' : 'muted'}>×{toDecimal(costing.scale).toDecimalPlaces(2).toString()}</span>}
            </div>
            <div className="servings-input">
              <label htmlFor="expected">Expected servings</label>
              <input id="expected" className="input" inputMode="numeric" value={expected} onChange={(e) => setExpected(e.target.value)} />
            </div>
            {calcError && <Notice kind="error">{calcError}</Notice>}
            {costing && (
              <>
                <div className="ticket-hero">
                  <span>Cost per serving</span>
                  <b>{money(costing.costPerServing)}</b>
                </div>
                <dl className="ticket-rows">
                  <div><dt>Total cost, {costing.expectedServings} servings</dt><span className="leader" /><dd className={scaled ? 'scaled' : ''}>{money(costing.scaledCost)}</dd></div>
                  <div><dt>Sell per serving at {toDecimal(costing.targetMargin).toString()}%</dt><span className="leader" /><dd>{money(costing.recommendedPrice)}</dd></div>
                  <div><dt>Revenue</dt><span className="leader" /><dd>{money(costing.revenue)}</dd></div>
                  <div className={`total ${toDecimal(costing.profit).lt(0) ? 'loss' : 'profit'}`}><dt>Net profit</dt><span className="leader" /><dd>{money(costing.profit)}</dd></div>
                </dl>
                {costing.warnings.length > 0 && <Notice>{costing.warnings.map((w) => <div key={w}>{w}</div>)}</Notice>}
                <p className="ticket-foot">
                  As written: {costing.baseServings} servings for {money(costing.baseCost)}
                  {form.totalYield && costing.scaledYield ? `. Scaled batch makes ${qty(costing.scaledYield)} ${form.yieldUnit}` : ''}.
                  Changing servings here never edits the saved recipe.
                </p>
              </>
            )}
          </div>
        </aside>
      </div>

      {addToEvent && <AddToEventModal recipe={{ id, name: form.name, baseServings: form.baseServings }} onClose={() => setAddToEvent(false)} />}
    </main>
  );
}
