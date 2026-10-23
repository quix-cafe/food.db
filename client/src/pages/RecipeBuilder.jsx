import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { calculateRecipe, DEFAULT_MARGIN, isLabor, laborLast } from '@kitchen/shared';
import { api, imageForm, notifyDataChanged } from '../api.js';
import { useLeaveGuard, useRowReorder } from '../hooks.js';
import ImageGallery, { useLocalImages } from '../components/ImageGallery.jsx';
import { date, money, pack, percent, perUnit, qty, unitMoney, toDecimal } from '../format.js';
import IngredientCombobox from '../components/IngredientCombobox.jsx';
import { Field, Icon, LeaveModal, Modal, Notice, Spinner, TestBadge, useToast } from '../components/ui.jsx';
import { AddToEventModal } from './RecipeGallery.jsx';
import { IngredientDrawer } from './IngredientsPage.jsx';

let nextKey = 1;
const blank = { name: '', baseServings: '4', servingSize: '', totalYield: '', yieldUnit: '', targetMargin: String(DEFAULT_MARGIN), lines: [] };

// The recipe stores its total yield; the header edits it as size per serving × expected
// (base) servings, so the size per serving is derived from it on load.
const sizePerServing = (totalYield, servings) => {
  const t = toDecimal(totalYield);
  const n = toDecimal(servings);
  return t && n && n.gt(0) ? t.div(n).toDecimalPlaces(4).toString() : '';
};
const totalQty = (size, servings) => {
  const s = toDecimal(size);
  const n = toDecimal(servings);
  return s && n ? s.times(n).toDecimalPlaces(4).toString() : '';
};

const fromServer = (r) => ({
  name: r.name,
  baseServings: String(r.baseServings),
  servingSize: sizePerServing(r.totalYield, r.baseServings),
  totalYield: r.totalYield ? toDecimal(r.totalYield).toString() : '',
  yieldUnit: r.yieldUnit ?? '',
  targetMargin: toDecimal(r.targetMargin).toString(),
  isTest: r.isTest,
  lines: laborLast(r.lines).map((l) => ({
    key: nextKey++,
    ingredientId: l.ingredientId,
    blendId: l.blendId,
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
// its latest purchase: price per unit = store price / store pack size. A spice blend line is
// measured in grams (a sauce in oz), its "pack" being one batch of the blend.
const apiLines = (lines) => lines.map(({ ingredientId, blendId, amount }) => (blendId ? { blendId, amount } : { ingredientId, amount }));
const amountProblem = (lines) => lines.some((l) => { const a = toDecimal(l.amount); return !a || a.lt(0); });

const savedShape = (f) => JSON.stringify({ ...f, lines: apiLines(f.lines) });

export default function RecipeBuilder() {
  const { id } = useParams();
  const [form, setForm] = useState(id ? null : blank);
  const [saved, setSaved] = useState(id ? null : savedShape(blank));
  const [expected, setExpected] = useState(id ? '' : blank.baseServings);
  const [loadError, setLoadError] = useState(null);
  const [removing, setRemoving] = useState(null); // the line waiting on "Remove it?"
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState(null); // ingredient id whose detail panel is open over the recipe
  const [search, setSearch] = useState('');
  const { rowProps, handleProps } = useRowReorder((from, to) => setForm((f) => {
    if (to < 0 || to >= f.lines.length || from === to) return f;
    const lines = f.lines.slice();
    const [item] = lines.splice(from, 1);
    lines.splice(to, 0, item);
    return { ...f, lines: laborLast(lines) };
  }));
  const [addToEvent, setAddToEvent] = useState(false);
  const [images, setImages] = useState([]); // saved photos (existing recipe)
  const [pendingPhotos, setPendingPhotos] = useState([]); // chosen before a new recipe is created
  const [priceDraft, setPriceDraft] = useState(null); // target price while it's being typed
  const pendingImages = useLocalImages(pendingPhotos);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState(null);
  const navigate = useNavigate();
  const toast = useToast();

  // After the ingredient panel closes, its lines pick up any rename or new price; amounts and
  // unsaved edits stay as they are.
  const closeIngredient = async (ingredientId) => {
    setViewing(null);
    try {
      const ing = await api(`/ingredients/${ingredientId}`);
      setForm((f) => ({
        ...f,
        lines: f.lines.map((l) => (l.ingredientId === ingredientId ? {
          ...l,
          name: ing.name,
          category: ing.category,
          uom: ing.uom,
          packSize: ing.latestPackSize,
          packPrice: ing.latestPackPrice,
          vendor: ing.latestVendor,
          priceDate: ing.latestPurchaseDate,
        } : l)),
      }));
    } catch {
      // Deleted from the panel: the line stays, and saving reports it.
    }
  };

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
  const { blocker, allowLeave } = useLeaveGuard(dirty, id);

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
  // Total qty needed follows size per serving × expected servings; it's what's saved as the yield.
  const setServingSize = (e) => {
    const servingSize = e.target.value;
    setForm((f) => ({ ...f, servingSize, totalYield: totalQty(servingSize, f.baseServings) }));
  };
  const setServings = (e) => {
    const baseServings = e.target.value;
    setForm((f) => ({ ...f, baseServings, totalYield: f.servingSize.trim() ? totalQty(f.servingSize, baseServings) : f.totalYield }));
  };
  const unitLabel = form.yieldUnit.trim() || 'units';

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
  const addIngredient = (ing) => {
    const line = ing.kind === 'blend'
      ? { key: nextKey++, blendId: ing.id, name: ing.name, category: ing.blendKind === 'sauce' ? 'Sauce' : 'Spice blend', uom: ing.uom, packSize: ing.batchSize, packPrice: ing.cost, amount: '1' }
      : null;
    setForm((f) => ({
      ...f,
      lines: laborLast([...f.lines, line ?? {
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
      const { servingSize, ...fields } = form; // eslint-disable-line no-unused-vars
      const body = { ...fields, lines: apiLines(form.lines) };
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
        allowLeave();
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
          <h1>{form.name || (id ? 'Untitled recipe' : 'New recipe')}<TestBadge item={form} /></h1>
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
            <div className="recipe-header">
              <Field label="Recipe name"><input className="input" value={form.name} onChange={set('name')} placeholder="e.g. Marinara sauce" /></Field>
              <Field label="Unit of measurement" hint="What a serving is measured in"><input className="input" value={form.yieldUnit} onChange={set('yieldUnit')} placeholder="oz, tacos, bowls…" /></Field>
              <Field label="Size per serving" hint={`${unitLabel} in one serving`}>
                <input className="input num" inputMode="decimal" value={form.servingSize} onChange={setServingSize} placeholder="Optional"
                  aria-invalid={form.servingSize.trim() !== '' && !(toDecimal(form.servingSize)?.gt(0))} />
              </Field>
              <Field label="Expected servings" hint="What the recipe makes as written"><input className="input num" inputMode="numeric" value={form.baseServings} onChange={setServings} /></Field>
              <div className="field">
                <span id="total-qty-label">Total qty needed</span>
                <output className="input num readonly-value" aria-labelledby="total-qty-label">{form.totalYield ? `${qty(form.totalYield)} ${unitLabel}` : '—'}</output>
                <small>Size per serving × expected servings</small>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Ingredients</h2>
              <span className="muted">Total cost = unit price × amount used</span>
            </div>
            <div className="table-wrap">
              <table className="grid builder-lines">
                <thead>
                  <tr>
                    <th style={{ width: 28 }}><span className="visually-hidden">Reorder</span></th>
                    <th style={{ minWidth: 180 }}>Ingredient</th>
                    <th className="num">Unit price</th>
                    <th className="num">Pack size</th>
                    <th className="num">Store price</th>
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
                      <tr key={l.key} {...rowProps(i)} className={`${isLabor(l) ? 'labor-row' : ''} ${rowProps(i).className}`}>
                        <td>
                          <button className="icon-btn drag-handle" aria-label={`Move ${l.name} (drag, or use arrow keys)`} {...handleProps(i)}><Icon.grip /></button>
                        </td>
                        <td>
                          <div>
                            {l.blendId
                              // A blend opens in the Spice Lab; the leave guard asks first when the recipe has unsaved changes.
                              ? <Link className="line-name" data-tip="View/edit" aria-label={`${l.name}: view/edit`} to={`/spice-lab/${l.blendId}`}>{l.name}</Link>
                              : <button type="button" className="line-name" data-tip="View/edit" aria-label={`${l.name}: view/edit`} onClick={() => setViewing(l.ingredientId)}>{l.name}</button>}
                          </div>
                          {l.blendId
                            ? <small><Link to={`/spice-lab/${l.blendId}`} className="muted"><Icon.starburst /> {l.category}, batch of {qty(l.packSize)} {l.uom}</Link>{c?.missingPrice && <> <span className="badge warn">No prices</span></>}</small>
                            : c?.missingPrice
                              ? <span className="badge warn">No purchase price</span>
                              : isLabor(l)
                                ? <small className="muted">Service rate</small>
                                : <small className="muted">{l.vendor ? `${l.vendor}, ` : ''}bought {date(l.priceDate)}</small>}
                        </td>
                        <td className="num nowrap">{c?.unitPrice ? (l.blendId ? `${money(c.unitPrice)} / ${l.uom}` : perUnit(c.unitPrice, l.uom)) : '—'}</td>
                        <td className="num nowrap">{l.packPrice && !isLabor(l) ? pack(l.packSize, l.uom) : '—'}</td>
                        <td className="num">{l.packPrice && !isLabor(l) ? (l.blendId ? money(l.packPrice) : unitMoney(l.packPrice)) : '—'}</td>
                        <td className="num">
                          <span className="unit-input">
                            <input className="input num" inputMode="decimal" value={l.amount} aria-label={`${l.name} amount used, in ${l.uom ?? 'each'}`} aria-invalid={amountProblem([l])} onChange={(e) => setLine(l.key, { amount: e.target.value })} />
                            <span aria-hidden="true">{l.uom ?? 'each'}</span>
                          </span>
                        </td>
                        <td className="num" style={{ fontWeight: 650 }}>{c ? money(c.baseCost) : '—'}</td>
                        {scaled && <td className="num scaled nowrap">{c ? `${qty(c.scaledAmount)} ${l.uom ?? ''}` : '—'}</td>}
                        {scaled && <td className="num scaled">{c ? money(c.scaledCost) : '—'}</td>}
                        <td><button className="icon-btn" aria-label={`Remove ${l.name}`} onClick={() => (l.name ? setRemoving(l) : removeLine(l.key))}><Icon.trash /></button></td>
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
                exclude={form.lines.map((l) => l.ingredientId ?? l.blendId)}
                includeBlends
                placeholder="Add an ingredient, spice blend or sauce…"
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
              <h2>Cost Calculator</h2>
              {costing && <span className={scaled ? 'scaled' : 'muted'}>×{toDecimal(costing.scale).toDecimalPlaces(2).toString()}</span>}
            </div>
            <div className="servings-input">
              <label htmlFor="expected" title="Cost the recipe for a different number of servings; the saved recipe doesn’t change">Scale to servings</label>
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
                <label htmlFor="target-price">Menu Price per Order</label>
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
                    <span>Cost Per Order</span>
                    <b>{money(costing.costPerServing)}</b>
                  </div>
                  <div className={`hero-profit ${toDecimal(costing.profitPerServing).lt(0) ? 'loss' : ''}`}>
                    <span>Profit Per Order</span>
                    <b>{money(costing.profitPerServing)}</b>
                  </div>
                </div>
                <dl className="ticket-rows">
                  <div><dt>Total Batch Cost</dt><span className="leader" /><dd className={scaled ? 'scaled' : ''}>{money(costing.scaledCost)}</dd></div>
                  <div><dt>Max Batch Revenue</dt><span className="leader" /><dd>{money(costing.revenue)}</dd></div>
                  <div className={`total ${toDecimal(costing.profit).lt(0) ? 'loss' : 'profit'}`}><dt>Total Batch Profit</dt><span className="leader" /><dd>{money(costing.profit)}</dd></div>
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

      {removing && (
        <Modal title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)}>
          <p>It comes out of this recipe only; the ingredient and its prices are kept. Nothing is saved until you save the recipe.</p>
          <div className="form-actions">
            <button className="btn ghost" onClick={() => setRemoving(null)}>Keep it</button>
            <button className="btn danger" onClick={() => { removeLine(removing.key); setRemoving(null); }}>Remove</button>
          </div>
        </Modal>
      )}
      {viewing && <IngredientDrawer id={viewing} onClose={() => closeIngredient(viewing)} />}
      <LeaveModal blocker={blocker} error={saveError} onSave={id ? save : undefined} saving={saving}>
        Your changes to {form.name || 'this recipe'} haven’t been saved. If you leave now, they’re lost.
      </LeaveModal>
      {addToEvent && <AddToEventModal recipe={{ id, name: form.name, baseServings: form.baseServings, costPerServing: costing?.costPerServing, recommendedPrice: costing?.recommendedPrice }} onClose={() => setAddToEvent(false)} />}
    </main>
  );
}
