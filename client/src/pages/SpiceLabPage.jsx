import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import { BLEND_UNITS, SPICE_GRAMS_PER_TSP, calculateBlend, normalizeUnit, parseAmount } from '@kitchen/shared';
import { api, notifyDataChanged } from '../api.js';
import { useApi, useLeaveGuard, useRowReorder } from '../hooks.js';
import { Decimal, money, qty, toDecimal, unitMoney } from '../format.js';
import { OTHER, SERIES } from '../palette.js';
import IngredientCombobox from '../components/IngredientCombobox.jsx';
import { Field, Icon, LeaveModal, Modal, Notice, Spinner, TestBadge, useToast } from '../components/ui.jsx';

/** A spice keeps the color of its position in the blend; past the palette it's "Other". */
const colorAt = (i) => SERIES[i] ?? OTHER;

/**
 * Donut of a blend by volume. items: calculateBlend items, in blend order. Spices beyond the
 * palette are folded into one "Other" slice rather than given made-up colors.
 */
function BlendPie({ items, totalTsp, size = 220, interactive = true }) {
  const slices = [];
  let other = 0;
  items.forEach((it, i) => {
    const tsp = toDecimal(it.tsp);
    if (!tsp || tsp.isZero()) return;
    if (i < SERIES.length) slices.push({ name: it.name || 'Unnamed spice', value: tsp.toNumber(), share: it.share, label: `${it.amount} ${it.unit}`, color: colorAt(i) });
    else other += tsp.toNumber();
  });
  if (other) {
    const share = toDecimal(totalTsp)?.isZero() ? null : ((other / Number(totalTsp)) * 100).toFixed(1);
    slices.push({ name: 'Other spices', value: other, share, label: `${qty(other)} tsp`, color: OTHER });
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
          <b>{qty(totalTsp)}</b>
          <span>tsp</span>
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
          <p>Build spice blends by the pinch, teaspoon or ounce. Each blend can be added to a recipe like a single ingredient.</p>
        </div>
        <Link className="btn primary" to="/spice-lab/new"><Icon.plus /> New blend</Link>
      </div>
      {error && <Notice kind="error">{error.message}</Notice>}
      {loading && !data && <Spinner />}
      {data && !data.length && (
        <div className="panel empty">
          <h2>No blends yet</h2>
          <p>Start with a few spices and adjust the amounts until the balance looks right.</p>
          <Link className="btn primary" to="/spice-lab/new">Create a blend</Link>
        </div>
      )}
      <div className="gallery">
        {(data ?? []).map((b) => (
          <article key={b.id} className="panel recipe-card blend-card">
            <BlendPie items={b.items} totalTsp={b.totalTsp} size={84} interactive={false} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <h3><Link to={`/spice-lab/${b.id}`}>{b.name}</Link> <TestBadge item={b} /></h3>
              <span className="muted">{b.items.length} spice{b.items.length === 1 ? '' : 's'}, {qty(b.totalTsp)} tsp per batch</span>
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
const blank = { name: '', notes: '', servings: '1', items: [] };

const fromServer = (b) => ({
  name: b.name,
  notes: b.notes ?? '',
  servings: String(b.servings),
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
  })),
});

const apiItems = (items) => items.map(({ ingredientId, name, amount, unit }) => (ingredientId ? { ingredientId, amount, unit } : { name, amount, unit }));
const savedShape = (f) => JSON.stringify({ name: f.name, notes: f.notes, servings: f.servings, items: apiItems(f.items) });
const wholeNumber = (v) => /^\d+$/.test(String(v).trim()) && Number(v) > 0;
const amountProblem = (it) => { const a = parseAmount(it.amount); return !a || a.lte(0); };

export function BlendEditor() {
  const { id } = useParams();
  const [form, setForm] = useState(id ? null : blank);
  const [saved, setSaved] = useState(id ? null : savedShape(blank));
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState(false);
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
  }, [id]);

  const dirty = !!form && saved !== savedShape(form);
  const { blocker, allowLeave } = useLeaveGuard(dirty, id);

  // Same breakdown the server computes, live as amounts change. Unparseable amounts count as 0.
  const breakdown = useMemo(() => form && calculateBlend(form.items.map((it) => ({
    ...it,
    amount: parseAmount(it.amount)?.toString() ?? '0',
  }))), [form]);

  if (loadError) return <main className="page"><Notice kind="error">{loadError}</Notice><Link to="/spice-lab">Back to the Spice Lab</Link></main>;
  if (!form) return <main className="page"><Spinner /></main>;

  const setItem = (key, patch) => setForm((f) => ({ ...f, items: f.items.map((it) => (it.key === key ? { ...it, ...patch } : it)) }));
  const removeItem = (key) => setForm((f) => ({ ...f, items: f.items.filter((it) => it.key !== key) }));
  const addItem = (item) => {
    setForm((f) => ({ ...f, items: [...f.items, { key: nextKey++, amount: '1', unit: 'tsp', ...item }] }));
    setSearch('');
  };
  const addIngredient = (ing) => addItem({
    ingredientId: ing.id, name: ing.name, packPrice: ing.latestPackPrice, packSize: ing.latestPackSize, uom: ing.uom,
  });

  const problems = form.items.some(amountProblem) || !form.name.trim() || !wholeNumber(form.servings);

  // Scale = servings needed / servings one batch makes. Only the view changes.
  const base = wholeNumber(form.servings) ? Number(form.servings) : 1;
  const scale = wholeNumber(needed) ? new Decimal(needed).div(base) : new Decimal(1);
  const scaled = !scale.eq(1);
  const sliderMax = Math.max(50, base * 10, wholeNumber(needed) ? Number(needed) : 0);
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const b = await api(id ? `/blends/${id}` : '/blends', { method: id ? 'PUT' : 'POST', body: { name: form.name, notes: form.notes, servings: form.servings, items: apiItems(form.items) } });
      const f = fromServer(b);
      setForm(f);
      setSaved(savedShape(f));
      notifyDataChanged();
      toast(id ? 'Blend saved' : 'Blend created');
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
  const grams = toDecimal(breakdown.totalTsp).times(SPICE_GRAMS_PER_TSP);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <Link to="/spice-lab" className="muted">Spice Lab</Link>
          <h1>{form.name || 'New blend'}<TestBadge item={form} /></h1>
        </div>
        <div className="form-actions">
          {id && <button className="btn ghost" onClick={() => setDeleting(true)}><Icon.trash /> Delete</button>}
          <button className="btn primary" disabled={!dirty || saving || problems} onClick={save}>
            {saving && <Spinner />} {id ? (dirty ? 'Save changes' : 'Saved') : 'Create blend'}
          </button>
        </div>
      </div>
      {saveError && <Notice kind="error">{saveError}</Notice>}

      <section className="panel panel-pad">
        <div className="form-grid">
          <Field label="Blend name" className="span-2"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. House rub" /></Field>
          <Field label="Notes" className="span-2"><textarea className="input" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Grind, toast, what it goes with…" /></Field>
          <Field label="One batch makes" hint="Servings, saved with the blend">
            <input className="input num" inputMode="numeric" value={form.servings} aria-invalid={!wholeNumber(form.servings)} onChange={(e) => setForm({ ...form, servings: e.target.value })} />
          </Field>
        </div>
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
      </section>

      <section className="panel">
        <div className="blend-summary">
          <BlendPie items={breakdown.items} totalTsp={breakdown.totalTsp} />
          <div className="blend-facts">
            <div><span>One batch ({base} serving{base === 1 ? '' : 's'})</span><b>{qty(breakdown.totalTsp)} tsp</b><small>about {grams.toDecimalPlaces(0).toString()} g</small></div>
            <div>
              <span>For {wholeNumber(needed) ? needed : base} serving{(wholeNumber(needed) ? Number(needed) : base) === 1 ? '' : 's'}</span>
              <b className={scaled ? 'scaled' : ''}>{qty(toDecimal(breakdown.totalTsp).times(scale))} tsp</b>
              <small>about {grams.times(scale).toDecimalPlaces(0).toString()} g</small>
            </div>
            <div><span>Spices</span><b>{form.items.length}</b></div>
            <div>
              <span>Cost</span>
              <b>{breakdown.cost ? money(breakdown.cost) : '—'}</b>
              <small>
                {breakdown.cost && breakdown.costPerTsp ? `${unitMoney(breakdown.costPerTsp)} / tsp. ` : ''}
                {form.items.length ? `${costed} of ${form.items.length} spices priced` : ''}
              </small>
            </div>
            <p className="muted">Slices are by volume. Weights (g, oz) count as about {SPICE_GRAMS_PER_TSP} g per tsp, typical for ground spices.</p>
          </div>
        </div>

        <div className="table-wrap">
          <table className="grid blend-grid">
            <thead>
              <tr>
                <th style={{ width: 28 }}><span className="visually-hidden">Reorder</span></th>
                <th style={{ minWidth: 200 }}>Spice</th>
                <th className="num">Amount</th>
                <th>Unit</th>
                <th className="num">In tsp</th>
                <th className="num" title="Amount × servings needed ÷ servings one batch makes">Scaled volume</th>
                <th className="num">Share</th>
                <th className="num" title="From the spice's latest purchase, when it's in the ingredient database">Cost</th>
                <th><span className="visually-hidden">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {form.items.map((it, i) => {
                const b = breakdown.items[i];
                const units = BLEND_UNITS.includes(it.unit) ? BLEND_UNITS : [...BLEND_UNITS, it.unit];
                return (
                  <tr key={it.key} {...rowProps(i)}>
                    <td>
                      <button className="icon-btn drag-handle" aria-label={`Move ${it.name || `spice ${i + 1}`} (drag, or use arrow keys)`} {...handleProps(i)}><Icon.grip /></button>
                    </td>
                    <td>
                      <span className="spice-name">
                        <i style={{ background: colorAt(i) }} aria-hidden="true" />
                        {it.ingredientId
                          ? <span style={{ fontWeight: 600 }}>{it.name}</span>
                          : <input className="input" value={it.name} aria-label={`Spice ${i + 1} name`} onChange={(e) => setItem(it.key, { name: e.target.value })} />}
                      </span>
                    </td>
                    <td className="num">
                      <input className="input num" style={{ width: 78 }} value={it.amount} aria-label={`${it.name} amount`} aria-invalid={amountProblem(it)}
                        title="Fractions work: 1/2, 1 1/2, ½" onChange={(e) => setItem(it.key, { amount: e.target.value })} />
                    </td>
                    <td>
                      <select className="select blend-unit" value={it.unit} aria-label={`${it.name} unit`} onChange={(e) => setItem(it.key, { unit: normalizeUnit(e.target.value) ?? e.target.value })}>
                        {units.map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </td>
                    <td className="num muted">{b?.tsp ? qty(b.tsp) : '—'}</td>
                    <td className={`num nowrap ${scaled ? 'scaled' : ''}`}>{amountProblem(it) ? '—' : `${qty(parseAmount(it.amount).times(scale))} ${it.unit}`}</td>
                    <td className="num" style={{ fontWeight: 650 }}>{b?.share ? `${b.share}%` : '—'}</td>
                    <td className="num muted">{b?.cost ? money(b.cost) : it.ingredientId ? <span title="No price, or its unit can't be converted from kitchen measures">—</span> : ''}</td>
                    <td><button className="icon-btn" aria-label={`Remove ${it.name || `spice ${i + 1}`}`} onClick={() => removeItem(it.key)}><Icon.trash /></button></td>
                  </tr>
                );
              })}
              {!form.items.length && <tr><td colSpan={9} className="muted" style={{ padding: 18 }}>Add spices from the ingredient database, or type any spice name below.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="panel-pad">
          <IngredientCombobox
            ariaLabel="Add a spice"
            value={search}
            onInput={setSearch}
            onPick={addIngredient}
            exclude={form.items.map((it) => it.ingredientId).filter(Boolean)}
            placeholder="Add a spice…"
            footer={(q, close) => q.trim() && (
              <div className="option" role="option" aria-selected="false"
                onMouseDown={(e) => { e.preventDefault(); addItem({ ingredientId: null, name: q.trim() }); close(); }}>
                <span>Add “{q.trim()}” as a spice without a price</span>
              </div>
            )}
          />
        </div>
      </section>

      <LeaveModal blocker={blocker} error={saveError} onSave={id && !problems ? save : undefined} saving={saving}>
        Your changes to {form.name || 'this blend'} haven’t been saved. If you leave now, they’re lost.
      </LeaveModal>
      {deleting && (
        <Modal title={`Delete ${form.name}?`} onClose={() => setDeleting(false)}>
          <p>The blend will be deleted. Blends used in a recipe can’t be deleted until they’re removed from it.</p>
          <div className="form-actions">
            <button className="btn ghost" onClick={() => setDeleting(false)}>Keep it</button>
            <button className="btn danger" onClick={remove}>Delete blend</button>
          </div>
        </Modal>
      )}
    </main>
  );
}
