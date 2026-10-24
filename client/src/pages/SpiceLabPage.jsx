import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import { BLEND_UNITS, BLEND_UOM, SAUCE_CONTAINERS, SAUCE_UNITS, SAUCE_UOM, SPICE_GRAMS_PER_TSP, calculateBlend, normalizeUnit, parseAmount } from '@kitchen/shared';
import { api, notifyDataChanged } from '../api.js';
import { PHONE, useApi, useLeaveGuard, useMedia, useRowReorder } from '../hooks.js';
import { Decimal, date, money, pack, perUnit, qty, toDecimal, unitMoney } from '../format.js';
import { OTHER, SERIES } from '../palette.js';
import IngredientCombobox from '../components/IngredientCombobox.jsx';
import { Field, Icon, LeaveModal, Modal, Notice, SaveButton, Spinner, TestBadge, useToast } from '../components/ui.jsx';
import { IngredientDrawer } from '../components/IngredientDrawer.jsx';

/** A spice keeps the color of its position in the blend; past the palette it's "Other". */
const colorAt = (i) => SERIES[i] ?? OTHER;

/**
 * Donut of a blend by weight. items: calculateBlend items, in blend order. Spices beyond the
 * palette are folded into one "Other" slice rather than given made-up colors.
 */
function BlendPie({ items, totalGrams, size = 220, interactive = true }) {
  const slices = [];
  let other = 0;
  items.forEach((it, i) => {
    const grams = toDecimal(it.grams);
    if (!grams || grams.isZero()) return;
    if (i < SERIES.length) slices.push({ name: it.name || 'Unnamed spice', value: grams.toNumber(), share: it.share, label: `${it.amount} ${it.unit}`, color: colorAt(i) });
    else other += grams.toNumber();
  });
  if (other) {
    const share = toDecimal(totalGrams)?.isZero() ? null : ((other / Number(totalGrams)) * 100).toFixed(1);
    slices.push({ name: 'Other spices', value: other, share, label: `${qty(other)} g`, color: OTHER });
  }
  if (!slices.length) {
    return <div className="blend-pie-empty" style={{ width: size, height: size }}>Add spices to see the breakdown</div>;
  }
  return (
    <div className="blend-pie" style={{ width: size, height: size }}>
      <PieChart width={size} height={size}>
        <Pie data={slices} dataKey="value" nameKey="name" innerRadius="56%" outerRadius="100%" startAngle={90} endAngle={-270}
          stroke="var(--paper)" strokeWidth={2} isAnimationActive={false}>
          {slices.map((s) => <Cell key={s.name + s.color} fill={s.color} />)}
        </Pie>
        {interactive && <Tooltip content={<SliceTip />} />}
      </PieChart>
      {interactive && (
        <div className="blend-pie-center" aria-hidden="true">
          <b>{qty(totalGrams)}</b>
          <span>g</span>
        </div>
      )}
    </div>
  );
}

function SliceTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const s = payload[0].payload;
  return (
    <div className="chart-tip">
      <b><span style={{ color: s.color }}>●</span> {s.name}</b>
      <div>{s.label}, {s.share}% of the blend</div>
    </div>
  );
}

export default function SpiceLabPage() {
  const { data, error, loading } = useApi('/blends');
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Spice Lab</h1>
          <p>Build spice blends by the pinch, teaspoon or bunch, and sauces by the container. Each can be added to a recipe like a single ingredient.</p>
        </div>
        <div className="form-actions">
          <Link className="btn orange" to="/spice-lab/new-sauce"><Icon.plus /> New sauce</Link>
          <Link className="btn primary" to="/spice-lab/new"><Icon.plus /> New blend</Link>
        </div>
      </div>
      {error && <Notice kind="error">{error.message}</Notice>}
      {loading && !data && <Spinner />}
      {data && !data.length && (
        <div className="panel empty">
          <h2>No blends or sauces yet</h2>
          <p>Start with a few spices and adjust the amounts until the balance looks right.</p>
          <Link className="btn primary" to="/spice-lab/new">Create a blend</Link>
        </div>
      )}
      <div className="gallery">
        {(data ?? []).map((b) => (
          <article key={b.id} className="panel recipe-card blend-card">
            <BlendPie items={b.items} totalGrams={b.totalGrams} size={84} interactive={false} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <h3><Link to={`/spice-lab/${b.id}`}>{b.name}</Link> <TestBadge item={b} /></h3>
              <span className="muted">
                {b.kind === 'sauce'
                  ? `Sauce: ${b.items.length} ingredient${b.items.length === 1 ? '' : 's'}, ${b.container} (${qty(b.batchSize)} oz)${b.servingOz ? `, ${qty(b.servingOz)} oz servings` : ''}`
                  : `${b.items.length} spice${b.items.length === 1 ? '' : 's'}, ${qty(b.totalGrams)} g per batch`}
              </span>
              <div className="blend-swatches">
                {b.items.slice(0, SERIES.length).map((it, i) => <span key={i}><i style={{ background: colorAt(i) }} />{it.name}</span>)}
                {b.items.length > SERIES.length && <span><i style={{ background: OTHER }} />+{b.items.length - SERIES.length} more</span>}
              </div>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}

let nextKey = 1;
const blankFor = (kind) => ({ name: '', kind, container: kind === 'sauce' ? '1 qt' : null, notes: '', servings: '1', servingOz: kind === 'sauce' ? '2' : '', items: [] });

const fromServer = (b) => ({
  name: b.name,
  kind: b.kind,
  container: b.container,
  notes: b.notes ?? '',
  servings: String(b.servings),
  servingOz: b.servingOz ? toDecimal(b.servingOz).toString() : '',
  isTest: b.isTest,
  items: b.items.map((it) => ({
    key: nextKey++,
    ingredientId: it.ingredientId,
    name: it.name,
    amount: toDecimal(it.amount).toString(),
    unit: it.unit,
    packPrice: it.packPrice,
    packSize: it.packSize,
    uom: it.uom,
    unitGrams: it.unitGrams,
    vendor: it.vendor,
    priceDate: it.priceDate,
  })),
});

const apiItems = (items) => items.map(({ ingredientId, name, amount, unit }) => (ingredientId ? { ingredientId, amount, unit } : { name, amount, unit }));
const apiBody = (f) => ({
  name: f.name, kind: f.kind, container: f.container, notes: f.notes, items: apiItems(f.items),
  // A sauce's servings follow from its serving size; a blend's are typed.
  ...(f.kind === 'sauce' ? { servingOz: f.servingOz } : { servings: f.servings }),
});
const savedShape = (f) => JSON.stringify(apiBody(f));
const wholeNumber = (v) => /^\d+$/.test(String(v).trim()) && Number(v) > 0;
const amountProblem = (it) => { const a = parseAmount(it.amount); return !a || a.lte(0); };
/** A sauce's serving size in oz: above 0 and no more than its container. */
const servingProblem = (f) => { const s = toDecimal(f.servingOz); return !s || s.lte(0) || s.gt(SAUCE_CONTAINERS[f.container] ?? 0); };

/** Edits a spice blend, or a sauce (`kind="sauce"` for a new one; a saved one keeps its kind). */
export function BlendEditor({ kind: newKind = 'spice' }) {
  const { id } = useParams();
  const blank = useMemo(() => blankFor(newKind), [newKind]);
  const [form, setForm] = useState(id ? null : blank);
  const [saved, setSaved] = useState(id ? null : savedShape(blank));
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [viewing, setViewing] = useState(null); // ingredient id whose detail panel is open over the blend
  const { rowProps, handleProps } = useRowReorder((from, to) => setForm((f) => {
    if (to < 0 || to >= f.items.length || from === to) return f;
    const items = f.items.slice();
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item);
    return { ...f, items };
  }));
  const [needed, setNeeded] = useState('1'); // servings to scale to; never saved
  const navigate = useNavigate();
  const toast = useToast();

  useEffect(() => {
    if (!id) {
      setForm(blank);
      setSaved(savedShape(blank));
      setNeeded(blank.servings);
      return;
    }
    let stale = false;
    api(`/blends/${id}`)
      .then((b) => {
        if (stale) return;
        const f = fromServer(b);
        setForm(f);
        setSaved(savedShape(f));
        setNeeded(f.servings);
      })
      .catch((err) => !stale && setLoadError(err.message));
    return () => { stale = true; };
  }, [id, blank]);

  const dirty = !!form && saved !== savedShape(form);
  const { blocker, allowLeave } = useLeaveGuard(dirty, id);
  const phone = useMedia(PHONE);

  // Same breakdown the server computes, live as amounts change. Unparseable amounts count as 0.
  const breakdown = useMemo(() => form && calculateBlend(form.items.map((it) => ({
    ...it,
    amount: parseAmount(it.amount)?.toString() ?? '0',
  })), form), [form]);

  if (loadError) return <main className="page"><Notice kind="error">{loadError}</Notice><Link to="/spice-lab">Back to the Spice Lab</Link></main>;
  if (!form) return <main className="page"><Spinner /></main>;

  // After the ingredient panel closes, its items pick up any rename or new price; amounts stay.
  const closeIngredient = async (ingredientId) => {
    setViewing(null);
    try {
      const ing = await api(`/ingredients/${ingredientId}`);
      setForm((f) => ({
        ...f,
        items: f.items.map((it) => (it.ingredientId === ingredientId ? {
          ...it, name: ing.name, uom: ing.uom, unitGrams: ing.unitGrams, packPrice: ing.latestPackPrice, packSize: ing.latestPackSize,
          vendor: ing.latestVendor, priceDate: ing.latestPurchaseDate,
        } : it)),
      }));
    } catch {
      // Deleted from the panel: the item stays, and saving reports it.
    }
  };

  // A sauce is written for one container: picking another scales every amount to fill it.
  const setContainer = (container) => setForm((f) => {
    const ratio = new Decimal(SAUCE_CONTAINERS[container]).div(SAUCE_CONTAINERS[f.container]);
    const items = f.items.map((it) => {
      const a = parseAmount(it.amount);
      return a ? { ...it, amount: a.times(ratio).toDecimalPlaces(4).toString() } : it;
    });
    return { ...f, container, items };
  });

  const setItem = (key, patch) => setForm((f) => ({ ...f, items: f.items.map((it) => (it.key === key ? { ...it, ...patch } : it)) }));
  const removeItem = (key) => setForm((f) => ({ ...f, items: f.items.filter((it) => it.key !== key) }));
  const addItem = (item) => {
    setForm((f) => ({ ...f, items: [...f.items, { key: nextKey++, amount: '1', unit: form.kind === 'sauce' ? 'fl oz' : BLEND_UOM, ...item }] }));
    setSearch('');
  };
  const sauce = form.kind === 'sauce';
  const noun = sauce ? 'ingredient' : 'spice';
  const thing = sauce ? 'sauce' : 'blend';
  const addIngredient = (ing) => addItem({
    // A sauce's ingredients start in their own unit (a bunch of cilantro); spices in grams.
    ...(sauce && ing.uom ? { unit: normalizeUnit(ing.uom) ?? ing.uom.trim().toLowerCase() } : {}),
    ingredientId: ing.id, name: ing.name, packPrice: ing.latestPackPrice, packSize: ing.latestPackSize, uom: ing.uom, unitGrams: ing.unitGrams,
    vendor: ing.latestVendor, priceDate: ing.latestPurchaseDate,
  });

  const problems = form.items.some(amountProblem) || !form.name.trim() || (sauce ? servingProblem(form) : !wholeNumber(form.servings));

  // A blend scales to the servings needed (only the view changes); a sauce is made by the container.
  const base = wholeNumber(form.servings) ? Number(form.servings) : 1;
  const scale = !sauce && wholeNumber(needed) ? new Decimal(needed).div(base) : new Decimal(1);
  const scaled = !scale.eq(1);
  const sliderMax = Math.max(50, base * 10, wholeNumber(needed) ? Number(needed) : 0);
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const b = await api(id ? `/blends/${id}` : '/blends', { method: id ? 'PUT' : 'POST', body: apiBody(form) });
      const f = fromServer(b);
      setForm(f);
      setSaved(savedShape(f));
      notifyDataChanged();
      toast(id ? `${sauce ? 'Sauce' : 'Blend'} saved` : `${sauce ? 'Sauce' : 'Blend'} created`);
      if (!id) {
        allowLeave();
        navigate(`/spice-lab/${b.id}`, { replace: true });
      }
      return true;
    } catch (err) {
      setSaveError(err.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await api(`/blends/${id}`, { method: 'DELETE' });
      notifyDataChanged();
      toast(`Deleted ${form.name}`);
      allowLeave();
      navigate('/spice-lab');
    } catch (err) {
      setDeleting(false);
      setSaveError(err.message);
    }
  };

  const costed = breakdown.items.filter((it) => it.cost).length;
  const grams = toDecimal(breakdown.totalGrams);
  const tsp = grams.div(SPICE_GRAMS_PER_TSP);
  const batch = toDecimal(breakdown.batchSize);
  const servingOz = sauce && !servingProblem(form) ? toDecimal(form.servingOz) : null;
  const perContainer = servingOz ? batch.div(servingOz) : null;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <Link to="/spice-lab" className="muted">Spice Lab</Link>
          <h1>{form.name || `New ${thing}`}<TestBadge item={form} /></h1>
        </div>
        <div className="form-actions">
          {id && <button className="btn ghost" onClick={() => setDeleting(true)}><Icon.trash /> Delete</button>}
          <SaveButton dirty={dirty} saving={saving} disabled={!dirty || saving || problems} onClick={save} isNew={!id} createLabel={`Create ${thing}`} />
        </div>
      </div>
      {saveError && <Notice kind="error">{saveError}</Notice>}

      <section className="panel panel-pad">
        <div className="form-grid">
          <Field label={sauce ? 'Sauce name' : 'Blend name'} className="span-2"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={sauce ? 'e.g. Cilantro sauce' : 'e.g. House rub'} /></Field>
          <Field label="Notes" className="span-2"><textarea className="input" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder={sauce ? 'Blend, strain, how long it keeps…' : 'Grind, toast, what it goes with…'} /></Field>
          {sauce ? (
            <>
              <Field label="Container" hint="The amounts below make one; changing it scales them">
                <select className="select" value={form.container} onChange={(e) => setContainer(e.target.value)}>
                  {Object.entries(SAUCE_CONTAINERS).map(([c, oz]) => <option key={c} value={c}>{c} ({oz} oz)</option>)}
                </select>
              </Field>
              <Field label="Serving size" hint={perContainer ? `${qty(perContainer, 1)} servings per container` : `Oz per serving, up to ${SAUCE_CONTAINERS[form.container]}`}>
                <span className="unit-input">
                  <input className="input num" inputMode="decimal" value={form.servingOz} aria-label="Serving size, in oz" aria-invalid={servingProblem(form)}
                    onChange={(e) => setForm({ ...form, servingOz: e.target.value })} />
                  <span aria-hidden="true">{SAUCE_UOM}</span>
                </span>
              </Field>
            </>
          ) : (
            <Field label="One batch makes" hint="Servings, saved with the blend">
              <input className="input num" inputMode="numeric" value={form.servings} aria-invalid={!wholeNumber(form.servings)} onChange={(e) => setForm({ ...form, servings: e.target.value })} />
            </Field>
          )}
        </div>
        {!sauce && (
          <div className="margin-slider blend-scale">
            <div className="margin-slider-head">
              <label htmlFor="servings-needed">Servings needed</label>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span className={scaled ? 'scaled' : 'muted'}>×{scale.toDecimalPlaces(2).toString()}</span>
                <input className="input num" style={{ width: 80 }} inputMode="numeric" value={needed} aria-label="Servings needed (number)"
                  aria-invalid={!wholeNumber(needed)} onChange={(e) => setNeeded(e.target.value)} />
              </span>
            </div>
            <input id="servings-needed" type="range" min="1" max={sliderMax} step="1" value={wholeNumber(needed) ? Number(needed) : base}
              onChange={(e) => setNeeded(e.target.value)}
              style={{ '--fill': `${(((wholeNumber(needed) ? Number(needed) : base) - 1) / (sliderMax - 1)) * 100}%` }} />
            <small>Scales the amounts below; the saved blend doesn’t change.</small>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="table-wrap">
          <table className="grid builder-lines blend-grid">
            <thead>
              <tr>
                <th style={{ width: 28 }}><span className="visually-hidden">Reorder</span></th>
                <th style={{ minWidth: 200 }}>{sauce ? 'Ingredient' : 'Spice'}</th>
                <th className="num">Unit price</th>
                <th className="num">Pack size</th>
                <th className="num">Store price</th>
                <th className="num" title="Fractions work: 1/2, 1 1/2, ½">Amount used</th>
                <th className="num">In g</th>
                <th className="num">Share</th>
                <th className="num" title={`Unit price × amount used, from the ${noun}'s latest purchase`}>Total cost</th>
                {scaled && <th className="num" title="Amount × servings needed ÷ servings one batch makes">Scaled amount</th>}
                {scaled && <th className="num">Scaled cost</th>}
                <th><span className="visually-hidden">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {form.items.map((it, i) => {
                const b = breakdown.items[i];
                // Offer the linked ingredient's own unit too, so a "box" of garlic can be costed.
                const own = it.uom ? normalizeUnit(it.uom) ?? it.uom.trim().toLowerCase() : null;
                const units = [...new Set([...(sauce ? SAUCE_UNITS : BLEND_UNITS), own, it.unit].filter(Boolean))];
                const priced = it.ingredientId && toDecimal(it.packPrice) !== null;
                return (
                  <tr key={it.key} {...rowProps(i)}>
                    <td>
                      <button className="icon-btn drag-handle" aria-label={`Move ${it.name || `${noun} ${i + 1}`} (drag, or use arrow keys)`} {...handleProps(i)}><Icon.grip /></button>
                    </td>
                    <td>
                      <span className="spice-name">
                        <i style={{ background: colorAt(i) }} aria-hidden="true" />
                        {it.ingredientId
                          ? (
                            <span>
                              <button type="button" className="line-name" data-tip="View/edit" aria-label={`${it.name}: view/edit`} onClick={() => setViewing(it.ingredientId)}>{it.name}</button>
                              <br />
                              {priced
                                ? <small className="muted">{it.vendor ? `${it.vendor}, ` : ''}bought {date(it.priceDate)}</small>
                                : <span className="badge warn">No purchase price</span>}
                            </span>
                          )
                          : <input className="input" value={it.name} aria-label={`${sauce ? 'Ingredient' : 'Spice'} ${i + 1} name`} title="Not in the ingredient database, so it has no price" onChange={(e) => setItem(it.key, { name: e.target.value })} />}
                      </span>
                    </td>
                    <td className="num nowrap">{priced ? perUnit(toDecimal(it.packPrice).div(toDecimal(it.packSize) || 1), it.uom) : '—'}</td>
                    <td className="num nowrap">{priced ? pack(it.packSize, it.uom) : '—'}</td>
                    <td className="num">{priced ? unitMoney(it.packPrice) : '—'}</td>
                    <td className="num">
                      <span className="nowrap" style={{ display: 'inline-flex', gap: 6 }}>
                        <input className="input num" style={{ width: 78 }} value={it.amount} aria-label={`${it.name} amount`} aria-invalid={amountProblem(it)}
                          title="Fractions work: 1/2, 1 1/2, ½" onChange={(e) => setItem(it.key, { amount: e.target.value })} />
                        <select className="select blend-unit" value={it.unit} aria-label={`${it.name} unit`} onChange={(e) => setItem(it.key, { unit: normalizeUnit(e.target.value) ?? e.target.value })}>
                          {units.map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </span>
                    </td>
                    <td className="num muted">{b?.grams ? qty(b.grams) : '—'}</td>
                    <td className="num">{b?.share ? `${b.share}%` : '—'}</td>
                    <td className="num" style={{ fontWeight: 650 }}>{b?.cost ? money(b.cost) : priced ? <span title={`${it.unit} can’t be converted to ${it.uom}: set what 1 ${it.uom} weighs in the ingredient’s details`}>—</span> : '—'}</td>
                    {scaled && <td className="num nowrap scaled">{amountProblem(it) ? '—' : `${qty(parseAmount(it.amount).times(scale))} ${it.unit}`}</td>}
                    {scaled && <td className="num scaled">{b?.cost ? money(toDecimal(b.cost).times(scale)) : '—'}</td>}
                    <td><button className="icon-btn" aria-label={`Remove ${it.name || `${noun} ${i + 1}`}`} onClick={() => removeItem(it.key)}><Icon.trash /></button></td>
                  </tr>
                );
              })}
              {!form.items.length && <tr><td colSpan={12} className="muted" style={{ padding: 18 }}>Add {noun}s from the ingredient database, or type any {noun} name below.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="panel-pad">
          <IngredientCombobox
            ariaLabel={`Add ${sauce ? 'an ingredient' : 'a spice'}`}
            value={search}
            onInput={setSearch}
            onPick={addIngredient}
            exclude={form.items.map((it) => it.ingredientId).filter(Boolean)}
            placeholder={`Add ${sauce ? 'an ingredient' : 'a spice'}…`}
            footer={(q, close) => q.trim() && (
              <div className="option" role="option" aria-selected="false"
                onMouseDown={(e) => { e.preventDefault(); addItem({ ingredientId: null, name: q.trim() }); close(); }}>
                <span>Add “{q.trim()}” as {sauce ? 'an ingredient' : 'a spice'} without a price</span>
              </div>
            )}
          />
        </div>
        <div className="blend-summary">
          <BlendPie items={breakdown.items} totalGrams={breakdown.totalGrams} size={phone ? 150 : 220} />
          <div className="blend-facts">
            {sauce ? (
              <>
                <div><span>One container</span><b>{qty(batch)} {SAUCE_UOM}</b><small>{form.container}</small></div>
                <div>
                  <span>Servings</span>
                  <b>{perContainer ? qty(perContainer, 1) : '—'}</b>
                  <small>{servingOz ? `${qty(servingOz)} ${SAUCE_UOM} each` : 'Set a serving size'}</small>
                </div>
              </>
            ) : (
              <>
                <div><span>One batch ({base} serving{base === 1 ? '' : 's'})</span><b>{qty(grams)} g</b><small>about {qty(tsp, 1)} tsp</small></div>
                <div>
                  <span>For {wholeNumber(needed) ? needed : base} serving{(wholeNumber(needed) ? Number(needed) : base) === 1 ? '' : 's'}</span>
                  <b className={scaled ? 'scaled' : ''}>{qty(grams.times(scale))} g</b>
                  <small>about {qty(tsp.times(scale), 1)} tsp</small>
                </div>
              </>
            )}
            <div><span>{sauce ? 'Ingredients' : 'Spices'}</span><b>{form.items.length}</b></div>
            <div>
              <span>Cost</span>
              <b>{breakdown.cost ? money(breakdown.cost) : '—'}</b>
              <small>
                {sauce
                  ? (breakdown.cost && batch ? `${servingOz ? `${money(toDecimal(breakdown.cost).times(servingOz).div(batch))} / serving, ` : ''}${unitMoney(toDecimal(breakdown.cost).div(batch))} / ${SAUCE_UOM}. ` : '')
                  : (breakdown.cost && breakdown.costPerGram ? `${unitMoney(breakdown.costPerGram)} / g. ` : '')}
                {form.items.length ? `${costed} of ${form.items.length} ${noun}s priced` : ''}
              </small>
            </div>
          </div>
        </div>

      </section>

      {viewing && <IngredientDrawer id={viewing} onClose={() => closeIngredient(viewing)} />}
      <LeaveModal blocker={blocker} error={saveError} onSave={id && !problems ? save : undefined} saving={saving}>
        Your changes to {form.name || `this ${thing}`} haven’t been saved. If you leave now, they’re lost.
      </LeaveModal>
      {deleting && (
        <Modal title={`Delete ${form.name}?`} onClose={() => setDeleting(false)}>
          <p>The {thing} will be deleted. A {thing} used in a recipe can’t be deleted until it’s removed from it.</p>
          <div className="form-actions">
            <button className="btn ghost" onClick={() => setDeleting(false)}>Keep it</button>
            <button className="btn danger" onClick={remove}>Delete {thing}</button>
          </div>
        </Modal>
      )}
    </main>
  );
}
