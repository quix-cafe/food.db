import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import { calculateRecipe, DEFAULT_MARGIN, isLabor, laborLast } from '@kitchen/shared';
import { api, imageForm, notifyDataChanged } from '../api.js';
import ImageGallery, { useLocalImages } from '../components/ImageGallery.jsx';
import { date, money, pack, percent, perUnit, qty, unitMoney, toDecimal } from '../format.js';
import IngredientCombobox from '../components/IngredientCombobox.jsx';
import { Field, Icon, Modal, Notice, Spinner, useToast } from '../components/ui.jsx';
import { AddToEventModal } from './RecipeGallery.jsx';

let nextKey = 1;
const blank = { name: '', baseServings: '4', totalYield: '', yieldUnit: '', targetMargin: String(DEFAULT_MARGIN), lines: [] };

const fromServer = (r) => ({
  name: r.name,
  baseServings: String(r.baseServings),
  totalYield: r.totalYield ? toDecimal(r.totalYield).toString() : '',
  yieldUnit: r.yieldUnit ?? '',
  targetMargin: toDecimal(r.targetMargin).toString(),
  lines: laborLast(r.lines).map((l) => ({
    key: nextKey++,
    ingredientId: l.ingredientId,
    name: l.name,
    category: l.category,
    uom: l.uom,
    packSize: l.packSize,
    packPrice: l.packPrice,
    vendor: l.vendor,
    priceDate: l.priceDate,
    amount: toDecimal(l.amount).toString(),
  })),
});

// Each line's amount is in the ingredient's unit of measure (lb, oz, each…), priced from
// its latest purchase: price per unit = store price / store pack size.
const apiLines = (lines) => lines.map(({ ingredientId, amount }) => ({ ingredientId, amount }));
const amountProblem = (lines) => lines.some((l) => { const a = toDecimal(l.amount); return !a || a.lt(0); });

const savedShape = (f) => JSON.stringify({ ...f, lines: apiLines(f.lines) });

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
  const [images, setImages] = useState([]); // saved photos (existing recipe)
  const [pendingPhotos, setPendingPhotos] = useState([]); // chosen before a new recipe is created
  const [priceDraft, setPriceDraft] = useState(null); // target price while it's being typed
  const pendingImages = useLocalImages(pendingPhotos);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState(null);
  const navigate = useNavigate();
  const toast = useToast();

  useEffect(() => {
    if (!id) {
      setForm(blank);
      setSaved(savedShape(blank));
      setImages([]);
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
        setImages(r.images);
      })
      .catch((err) => !stale && setLoadError(err.message));
    return () => { stale = true; };
  }, [id]);

  const dirty = !!form && (saved !== savedShape(form) || pendingPhotos.length > 0);
  // Leaving the page in the app asks first; closing the tab or reloading gets the browser's prompt.
  const leavingAfterSave = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && !leavingAfterSave.current && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => { leavingAfterSave.current = false; }, [id]); // arrived at the saved recipe
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Instant, client-side costing with the same decimal math the API uses.
  const { costing, calcError } = useMemo(() => {
    if (!form) return {};
    if (amountProblem(form.lines)) return { calcError: 'Amount used must be a number, 0 or more (e.g. 0.25 lb, 2 each)' };
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

  // Typing a target price sets the margin that produces it: margin = 1 − cost / price.
  const cps = costing && toDecimal(costing.costPerServing);
  const draftPrice = priceDraft === null ? null : toDecimal(priceDraft);
  const priceProblem = priceDraft === null || !cps ? null
    : !draftPrice ? 'Enter a price'
      : cps.isZero() ? 'Add priced ingredients first'
        : draftPrice.lt(cps) ? `Can’t be below the cost per serving (${money(costing.costPerServing)})` : null;
  const setPrice = (text) => {
    setPriceDraft(text);
    const p = toDecimal(text);
    if (!cps || cps.isZero() || !p || p.lt(cps)) return;
    const margin = p.minus(cps).div(p).times(100).toDecimalPlaces(6);
    setForm((f) => ({ ...f, targetMargin: margin.toString() }));
  };
  const setLine = (key, patch) => setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const removeLine = (key) => setForm((f) => ({ ...f, lines: f.lines.filter((l) => l.key !== key) }));
  const move = (from, to) => setForm((f) => {
    if (to < 0 || to >= f.lines.length || from === to) return f;
    const lines = f.lines.slice();
    const [item] = lines.splice(from, 1);
    lines.splice(to, 0, item);
    return { ...f, lines: laborLast(lines) };
  });
  const addIngredient = (ing) => {
    setForm((f) => ({
      ...f,
      lines: laborLast([...f.lines, {
        key: nextKey++,
        ingredientId: ing.id,
        name: ing.name,
        category: ing.category,
        uom: ing.uom,
        packSize: ing.latestPackSize,
        packPrice: ing.latestPackPrice,
        vendor: ing.latestVendor,
        priceDate: ing.latestPurchaseDate,
        amount: '1',
      }]),
    }));
    setSearch('');
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body = { ...form, lines: apiLines(form.lines) };
      const r = await api(id ? `/recipes/${id}` : '/recipes', { method: id ? 'PUT' : 'POST', body });
      const f = fromServer(r);
      setForm(f);
      setSaved(savedShape(f));
      if (!id && pendingPhotos.length) {
        try {
          await api(`/recipes/${r.id}/images`, { method: 'POST', body: imageForm(pendingPhotos) });
          setPendingPhotos([]);
        } catch (err) {
          toast(`Recipe created, but the photos didn’t upload: ${err.message}`);
        }
      }
      notifyDataChanged();
      toast(id ? 'Recipe saved' : 'Recipe created');
      if (!id) {
        leavingAfterSave.current = true; // this render's blocker still sees the old, dirty form
        navigate(`/recipes/${r.id}`, { replace: true });
      }
      return true;
    } catch (err) {
      setSaveError(err.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  // Photos on a saved recipe are stored as soon as they're added; on a new recipe they wait for Create.
  const photoAction = async (fn) => {
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      setImages(await fn());
      notifyDataChanged();
    } catch (err) {
      setPhotoError(err.message);
    } finally {
      setPhotoBusy(false);
    }
  };
  const addPhotos = (files) => (id
    ? photoAction(async () => [...images, ...(await api(`/recipes/${id}/images`, { method: 'POST', body: imageForm(files) }))])
    : setPendingPhotos((p) => [...p, ...files]));
  const removePhoto = (img) => (id
    ? photoAction(async () => { await api(`/images/${img.id}`, { method: 'DELETE' }); return images.filter((i) => i.id !== img.id); })
    : setPendingPhotos((p) => p.filter((f) => f !== img.file)));
  const makeCover = (img) => (id
    ? photoAction(() => api(`/recipes/${id}/images/order`, { method: 'PUT', body: { imageIds: [img.id, ...images.filter((i) => i.id !== img.id).map((i) => i.id)] } }))
    : setPendingPhotos((p) => [img.file, ...p.filter((f) => f !== img.file)]));

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
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Ingredients</h2>
              <span className="muted">Total cost = store price ÷ pack size × amount used</span>
            </div>
            <div className="table-wrap">
              <table className="grid builder-lines">
                <thead>
                  <tr>
                    <th style={{ width: 28 }}><span className="visually-hidden">Reorder</span></th>
                    <th style={{ minWidth: 180 }}>Ingredient</th>
                    <th className="num">Store pack size</th>
                    <th className="num">Total store price</th>
                    <th className="num">Price per unit</th>
                    <th className="num" title="How many units of measurement the recipe uses, e.g. 0.25 or 2">Amount used</th>
                    <th className="num">Total cost</th>
                    {scaled && <th className="num">Scaled amount</th>}
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
                        className={`${isLabor(l) ? 'labor-row' : ''} ${drag.from === i ? 'dragging' : ''} ${drag.over === i && drag.from !== i ? 'drop-target' : ''}`}
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
                            : <small className="muted">{l.vendor ? `${l.vendor}, ` : ''}bought {date(l.priceDate)}</small>}
                        </td>
                        <td className="num nowrap">{l.packPrice ? pack(l.packSize, l.uom) : '—'}</td>
                        <td className="num">{l.packPrice ? unitMoney(l.packPrice) : '—'}</td>
                        <td className="num nowrap">{c?.unitPrice ? perUnit(c.unitPrice, l.uom) : '—'}</td>
                        <td className="num"><input className="input num" style={{ width: 84 }} inputMode="decimal" value={l.amount} aria-label={`${l.name} amount used, in ${l.uom ?? 'each'}`} aria-invalid={amountProblem([l])} onChange={(e) => setLine(l.key, { amount: e.target.value })} /></td>
                        <td className="num" style={{ fontWeight: 650 }}>{c ? money(c.baseCost) : '—'}</td>
                        {scaled && <td className="num scaled nowrap">{c ? `${qty(c.scaledAmount)} ${l.uom ?? ''}` : '—'}</td>}
                        {scaled && <td className="num scaled">{c ? money(c.scaledCost) : '—'}</td>}
                        <td><button className="icon-btn" aria-label={`Remove ${l.name}`} onClick={() => removeLine(l.key)}><Icon.trash /></button></td>
                      </tr>
                    );
                  })}
                  {!form.lines.length && (
                    <tr><td colSpan={10} className="muted" style={{ padding: 18 }}>Add ingredients from the database using the search below.</td></tr>
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

          <section className="panel">
            <div className="panel-head">
              <h2>Photos</h2>
              <span className="muted">{id ? 'Saved as soon as you add them. The first photo is the cover.' : 'Uploaded when you create the recipe.'}</span>
            </div>
            <div className="panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <ImageGallery
                images={id ? images : pendingImages}
                onAdd={addPhotos}
                onRemove={removePhoto}
                onMakeCover={makeCover}
                busy={photoBusy}
              />
              {photoError && <Notice kind="error">{photoError}</Notice>}
            </div>
          </section>
        </div>

        <aside className="ticket-rail" aria-label="Financials">
          <div className="ticket">
            <div className="ticket-title">
              <h2>Cost</h2>
              {costing && <span className={scaled ? 'scaled' : 'muted'}>×{toDecimal(costing.scale).toDecimalPlaces(2).toString()}</span>}
            </div>
            <div className="servings-input">
              <label htmlFor="expected">Expected servings</label>
              <input id="expected" className="input" inputMode="numeric" value={expected} onChange={(e) => setExpected(e.target.value)} />
            </div>
            <div className="margin-slider">
              <div className="margin-slider-head">
                <label htmlFor="margin">Target margin</label>
                <output htmlFor="margin">{percent(form.targetMargin)}</output>
              </div>
              <input
                id="margin"
                type="range"
                min="0"
                max="95"
                step="1"
                value={toDecimal(form.targetMargin)?.toNumber() ?? 70}
                onChange={(e) => { setPriceDraft(null); set('targetMargin')(e); }}
                style={{ '--fill': `${(Math.min(toDecimal(form.targetMargin)?.toNumber() ?? 70, 95) / 95) * 100}%` }}
              />
              <div className="price-input">
                <label htmlFor="target-price">Target price per serving</label>
                <span className="money-input">
                  <span aria-hidden="true">$</span>
                  <input
                    id="target-price"
                    className="input num"
                    inputMode="decimal"
                    disabled={!costing}
                    aria-invalid={!!priceProblem}
                    aria-describedby="target-price-note"
                    value={priceDraft ?? (costing ? toDecimal(costing.recommendedPrice).toFixed(2) : '')}
                    onChange={(e) => setPrice(e.target.value)}
                    onBlur={() => setPriceDraft(null)}
                  />
                </span>
              </div>
              <small id="target-price-note" style={priceProblem ? { color: 'var(--tomato)' } : undefined}>
                {priceProblem ?? 'Set either one; the other follows. The margin is saved, so the price moves with ingredient costs.'}
              </small>
            </div>
            {calcError && <Notice kind="error">{calcError}</Notice>}
            {costing && (
              <>
                <div className="ticket-hero">
                  <div>
                    <span>Cost per serving</span>
                    <b>{money(costing.costPerServing)}</b>
                  </div>
                  <div className={`hero-profit ${toDecimal(costing.profitPerServing).lt(0) ? 'loss' : ''}`}>
                    <span>Profit per serving</span>
                    <b>{money(costing.profitPerServing)}</b>
                  </div>
                </div>
                <dl className="ticket-rows">
                  <div><dt>Total cost, {costing.expectedServings} servings</dt><span className="leader" /><dd className={scaled ? 'scaled' : ''}>{money(costing.scaledCost)}</dd></div>
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

      {blocker.state === 'blocked' && (
        <Modal title="Leave without saving?" onClose={() => blocker.reset()}>
          <p>Your changes to {form.name || 'this recipe'} haven’t been saved. If you leave now, they’re lost.</p>
          {saveError && <Notice kind="error">{saveError}</Notice>}
          <div className="form-actions">
            <button className="btn ghost" onClick={() => blocker.reset()}>Keep editing</button>
            <button className="btn danger" onClick={() => blocker.proceed()}>Discard changes</button>
            {id && (
              <button className="btn primary" disabled={saving} onClick={async () => { if (await save()) blocker.proceed(); }}>
                {saving && <Spinner />} Save and leave
              </button>
            )}
          </div>
        </Modal>
      )}
      {addToEvent && <AddToEventModal recipe={{ id, name: form.name, baseServings: form.baseServings }} onClose={() => setAddToEvent(false)} />}
    </main>
  );
}
