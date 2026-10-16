import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, notifyDataChanged } from '../api.js';
import { useApi } from '../hooks.js';
import { isLabor } from '@kitchen/shared';
import { Decimal, date, money, pack, qty, toDecimal } from '../format.js';
import { Field, Icon, Modal, Notice, Spinner, Tabs, TestBadge, useToast } from '../components/ui.jsx';

const isInt = (v) => /^\d+$/.test(String(v).trim());
const optional = (v) => (v == null ? '' : String(v));
const blankOrInt = (v) => v.trim() === '' || isInt(v);
const blankOrAmount = (v) => v.trim() === '' || (toDecimal(v.replace(/[$,]/g, ''))?.gte(0) ?? false);
const amountOf = (v) => (v.trim() === '' ? '' : v.replace(/[$,]/g, '').trim());

export default function EventPlanner() {
  const { id } = useParams();
  const [form, setForm] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [status, setStatus] = useState('saved'); // saved | pending | saving | invalid | error
  const [saveError, setSaveError] = useState(null);
  const [tab, setTab] = useState('financials');
  const [deleting, setDeleting] = useState(false);
  const { data: recipes } = useApi('/recipes');
  const summary = useApi(`/events/${id}/summary`);
  const navigate = useNavigate();
  const toast = useToast();
  const lastSaved = useRef(null);

  useEffect(() => {
    let stale = false;
    api(`/events/${id}`)
      .then((ev) => {
        if (stale) return;
        const f = {
          name: ev.name,
          isTest: ev.isTest,
          date: ev.date,
          guestCount: ev.guestCount == null ? '' : String(ev.guestCount),
          servings: Object.fromEntries(ev.recipes.map((r) => [r.recipeId, String(r.expectedServings)])),
          actualGuests: optional(ev.actualGuests),
          actualRevenue: optional(ev.actualRevenue),
          actualCost: optional(ev.actualCost),
          notes: ev.notes ?? '',
        };
        lastSaved.current = JSON.stringify(f);
        setForm(f);
      })
      .catch((err) => !stale && setLoadError(err.message));
    return () => { stale = true; };
  }, [id]);

  // Autosave shortly after edits stop, then refresh the summary.
  useEffect(() => {
    if (!form) return;
    const snapshot = JSON.stringify(form);
    if (snapshot === lastSaved.current) return;
    const problem = !form.name.trim() ? 'Give the event a name' :
      !form.date ? 'Pick a date' :
      form.guestCount !== '' && !isInt(form.guestCount) ? 'Guests must be a whole number' :
      Object.values(form.servings).some((s) => !isInt(s)) ? 'Servings must be whole numbers' :
      !blankOrInt(form.actualGuests) ? 'Actual guests must be a whole number' :
      !blankOrAmount(form.actualRevenue) ? 'Actual revenue must be an amount' :
      !blankOrAmount(form.actualCost) ? 'Actual spend must be an amount' : null;
    if (problem) {
      setStatus('invalid');
      setSaveError(problem);
      return;
    }
    setStatus('pending');
    setSaveError(null);
    const t = setTimeout(async () => {
      setStatus('saving');
      try {
        await api(`/events/${id}`, {
          method: 'PUT',
          body: {
            name: form.name,
            date: form.date,
            guestCount: form.guestCount,
            recipes: Object.entries(form.servings).map(([recipeId, expectedServings]) => ({ recipeId, expectedServings })),
            actualGuests: form.actualGuests,
            actualRevenue: amountOf(form.actualRevenue),
            actualCost: amountOf(form.actualCost),
            notes: form.notes,
          },
        });
        lastSaved.current = snapshot;
        setStatus('saved');
        notifyDataChanged();
      } catch (err) {
        setStatus('error');
        setSaveError(err.message);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [form, id]);

  if (loadError) return <main className="page"><Notice kind="error">{loadError}</Notice><Link to="/events">Back to events</Link></main>;
  if (!form) return <main className="page"><Spinner /></main>;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (r) => setForm((f) => {
    const servings = { ...f.servings };
    if (r.id in servings) delete servings[r.id];
    else servings[r.id] = isInt(f.guestCount) ? f.guestCount : String(r.baseServings);
    return { ...f, servings };
  });
  const setServings = (rid, v) => setForm((f) => ({ ...f, servings: { ...f.servings, [rid]: v } }));
  const applyGuests = () => setForm((f) => ({ ...f, servings: Object.fromEntries(Object.keys(f.servings).map((k) => [k, f.guestCount])) }));

  const remove = async () => {
    await api(`/events/${id}`, { method: 'DELETE' });
    notifyDataChanged();
    toast(`Deleted ${form.name}`);
    navigate('/events');
  };

  const s = summary.data;
  const selectedCount = Object.keys(form.servings).length;
  const statusText = { saved: 'All changes saved', pending: 'Unsaved changes', saving: 'Saving…', invalid: saveError, error: saveError }[status];

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <Link to="/events" className="muted">Events</Link>
          <h1>{form.name || 'Untitled event'}<TestBadge item={form} /></h1>
        </div>
        <div className="form-actions" style={{ alignItems: 'center' }}>
          <span className="save-state" role="status" style={status === 'invalid' || status === 'error' ? { color: 'var(--tomato)' } : undefined}>
            {status === 'saving' && <Spinner />}{statusText}
          </span>
          <button className="btn danger" onClick={() => setDeleting(true)}><Icon.trash /> Delete</button>
        </div>
      </div>

      <section className="panel panel-pad">
        <div className="form-grid">
          <Field label="Event name" className="span-2"><input className="input" value={form.name} onChange={set('name')} /></Field>
          <Field label="Date"><input className="input" type="date" value={form.date} onChange={set('date')} /></Field>
          <Field label="Guests"><input className="input num" inputMode="numeric" value={form.guestCount} onChange={set('guestCount')} /></Field>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Recipes <span className="muted" style={{ fontWeight: 500 }}>({selectedCount} selected)</span></h2>
          <button className="btn small" disabled={!isInt(form.guestCount) || !selectedCount} onClick={applyGuests}>
            Set all servings to {isInt(form.guestCount) ? form.guestCount : 'guest count'}
          </button>
        </div>
        {recipes && !recipes.length ? (
          <div className="empty"><p>There are no recipes yet.</p><Link className="btn" to="/recipes/new">Create a recipe</Link></div>
        ) : (
          <div className="table-wrap">
            <table className="grid recipe-pick">
              <thead>
                <tr>
                  <th style={{ width: 40 }}><span className="visually-hidden">Include</span></th>
                  <th>Recipe</th>
                  <th className="num">Makes</th>
                  <th className="num">Cost / serving</th>
                  <th className="num">Servings for this event</th>
                </tr>
              </thead>
              <tbody>
                {(recipes ?? []).map((r) => {
                  const on = r.id in form.servings;
                  return (
                    <tr key={r.id} className={on ? '' : 'off'}>
                      <td><input type="checkbox" checked={on} onChange={() => toggle(r)} aria-label={`Include ${r.name}`} style={{ width: 18, height: 18, accentColor: 'var(--basil)' }} /></td>
                      <td><Link to={`/recipes/${r.id}`} style={{ color: 'inherit', fontWeight: 600 }}>{r.name}</Link></td>
                      <td className="num">{r.baseServings}</td>
                      <td className="num">{money(r.costPerServing)}</td>
                      <td className="num">
                        {on ? (
                          <input className="input num" style={{ width: 96, marginLeft: 'auto' }} inputMode="numeric" value={form.servings[r.id]}
                            aria-label={`Servings of ${r.name}`} aria-invalid={!isInt(form.servings[r.id])} onChange={(e) => setServings(r.id, e.target.value)} />
                        ) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'financials', label: 'Financials' }, { value: 'shopping', label: 'Shopping list' }, { value: 'results', label: 'After the event' }]} />
        {summary.error && <Notice kind="error">{summary.error.message}</Notice>}
        {!s ? <Spinner /> : !s.recipes.length ? (
          <div className="panel empty"><p>Select recipes above to project costs and build the shopping list.</p></div>
        ) : tab === 'financials' ? <Financials s={s} />
          : tab === 'results' ? <Results s={s} form={form} set={set} />
          : <ShoppingList s={s} eventId={id} title={form.name || 'Untitled event'} date={form.date} guests={form.guestCount} />}
        {s?.warnings.length > 0 && <Notice>{s.warnings.map((w) => <div key={w}>{w}</div>)}</Notice>}
      </section>

      {deleting && (
        <Modal title={`Delete ${form.name}?`} onClose={() => setDeleting(false)}>
          <p>The event and its recipe selections will be removed. The recipes themselves are kept.</p>
          <div className="form-actions">
            <button className="btn ghost" onClick={() => setDeleting(false)}>Keep it</button>
            <button className="btn danger" onClick={remove}>Delete event</button>
          </div>
        </Modal>
      )}
    </main>
  );
}

function Financials({ s }) {
  const loss = toDecimal(s.profit).lt(0);
  return (
    <>
      <div className="figures">
        <div className="panel figure"><span>Projected cost</span><b>{money(s.totalCost)}</b></div>
        <div className="panel figure"><span>Projected revenue</span><b>{money(s.revenue)}</b></div>
        <div className={`panel figure ${loss ? 'loss' : 'profit'}`}><span>Total profit</span><b>{money(s.profit)}</b></div>
        <div className="panel figure"><span>Overall margin</span><b>{s.marginPercent == null ? '—' : `${s.marginPercent}%`}</b></div>
      </div>
      <div className="panel table-wrap">
        <table className="grid">
          <thead>
            <tr><th>Recipe</th><th className="num">Servings</th><th className="num">Cost / serving</th><th className="num">Price / serving</th><th className="num">Cost</th><th className="num">Revenue</th><th className="num">Profit</th></tr>
          </thead>
          <tbody>
            {s.recipes.map((r) => (
              <tr key={r.recipeId}>
                <td>{r.name}</td>
                <td className="num">{r.expectedServings}</td>
                <td className="num">{money(r.costPerServing)}</td>
                <td className="num">{money(r.recommendedPrice)}</td>
                <td className="num">{money(r.scaledCost)}</td>
                <td className="num">{money(r.revenue)}</td>
                <td className="num">{money(r.profit)}</td>
              </tr>
            ))}
            {!toDecimal(s.adjustment).isZero() && (
              <tr className="labor-row">
                <td colSpan={4}>Labor set on the shopping list <span className="muted">(instead of scaling with servings)</span></td>
                <td className="num">{toDecimal(s.adjustment).gt(0) ? '+' : '−'}{money(toDecimal(s.adjustment).abs())}</td>
                <td />
                <td className="num">{toDecimal(s.adjustment).gt(0) ? '−' : '+'}{money(toDecimal(s.adjustment).abs())}</td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr><td>Total</td><td className="num">{s.recipes.reduce((a, r) => a + Number(r.expectedServings), 0)}</td><td /><td /><td className="num">{money(s.totalCost)}</td><td className="num">{money(s.revenue)}</td><td className="num">{money(s.profit)}</td></tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

/**
 * What actually happened, typed in after the event, next to the plan. Profit uses the actual
 * spend when it's given, otherwise the projected cost.
 */
function Results({ s, form, set }) {
  const dec = (v) => (v.trim() === '' ? null : toDecimal(v.replace(/[$,]/g, '')));
  const guests = isInt(form.guestCount) ? new Decimal(form.guestCount) : null;
  const actualGuests = isInt(form.actualGuests) ? new Decimal(form.actualGuests) : null;
  const revenue = dec(form.actualRevenue);
  const spend = dec(form.actualCost);
  const plannedCost = toDecimal(s.totalCost);
  const plannedRevenue = toDecimal(s.revenue);
  const plannedProfit = toDecimal(s.profit);
  const cost = spend ?? (revenue ? plannedCost : null);
  const profit = revenue && cost ? revenue.minus(cost) : null;
  const margin = (p, r) => (p && r && !r.isZero() ? p.div(r).times(100) : null);
  const perGuest = (r, g) => (r && g && !g.isZero() ? r.div(g) : null);
  const pct = (d) => (d === null ? '—' : `${d.toFixed(1)}%`);
  const count = (d) => (d === null ? '—' : d.toString());
  const signed = (d, fmt) => (d === null ? '—' : `${d.gt(0) ? '+' : d.lt(0) ? '−' : ''}${fmt(d.abs())}`);
  const diff = (a, b) => (a === null || b === null ? null : a.minus(b));
  // Higher is better for everything but cost.
  const tone = (d, lowerIsBetter = false) => (d === null || d.isZero() ? '' : d.gt(0) !== lowerIsBetter ? 'better' : 'worse');
  const rows = [
    ['Guests', guests, actualGuests, count, false, (d) => d.toString()],
    ['Revenue', plannedRevenue, revenue, money, false, money],
    [spend ? 'Spend' : 'Cost (projected; enter the actual spend to compare)', plannedCost, spend, money, true, money],
    ['Profit', plannedProfit, profit, money, false, money],
    ['Margin', margin(plannedProfit, plannedRevenue), margin(profit, revenue), pct, false, (d) => `${d.toFixed(1)} pts`],
    ['Revenue per guest', perGuest(plannedRevenue, guests), perGuest(revenue, actualGuests), (d) => (d === null ? '—' : money(d)), false, money],
  ];
  return (
    <>
      <section className="panel panel-pad">
        <div className="form-grid">
          <Field label="Actual guests"><input className="input num" inputMode="numeric" value={form.actualGuests} onChange={set('actualGuests')} placeholder={form.guestCount || ''} /></Field>
          <Field label="Actual revenue"><input className="input num" inputMode="decimal" value={form.actualRevenue} onChange={set('actualRevenue')} placeholder="0.00" /></Field>
          <Field label="Actual spend" hint={`Shopping list total: ${money(s.purchaseCost)}`}><input className="input num" inputMode="decimal" value={form.actualCost} onChange={set('actualCost')} placeholder="0.00" /></Field>
          <Field label="Notes" className="span-2"><textarea className="input" rows={3} value={form.notes} onChange={set('notes')} placeholder="What sold out, what was left over, what to change next time…" /></Field>
        </div>
      </section>
      <div className="panel table-wrap">
        <table className="grid results-grid">
          <thead><tr><th /><th className="num">Planned</th><th className="num">Actual</th><th className="num">Difference</th></tr></thead>
          <tbody>
            {rows.map(([label, planned, actual, fmt, lowerIsBetter, fmtDiff]) => {
              const d = diff(actual, planned);
              return (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num">{planned === null ? '—' : fmt(planned)}</td>
                  <td className="num" style={{ fontWeight: 650 }}>{actual === null ? '—' : fmt(actual)}</td>
                  <td className={`num ${tone(d, lowerIsBetter)}`}>{signed(d, fmtDiff)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {revenue && !spend && <p className="muted">Profit uses the projected cost until you enter the actual spend.</p>}
    </>
  );
}

/**
 * The shopping list as printed: one dense table grouped by category, with a box to tick
 * per line. Labor isn't bought, so it's left off. Shown only in print (see styles.css).
 */
function PrintedList({ s, title, day, guests }) {
  const lines = s.shoppingList.filter((l) => !isLabor(l));
  const groups = new Map();
  for (const l of lines) {
    const key = l.blendId ? 'Spice blends to make' : l.category || 'Other';
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const order = [...groups.keys()].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  const total = lines.reduce((sum, l) => sum.plus(toDecimal(l.purchaseCost) ?? 0), new Decimal(0));
  return (
    <div className="print-only printed-list">
      <h2>{title}: shopping list</h2>
      <p>
        {[day && date(day), guests && `${guests} guests`, `${lines.length} items`, `about ${money(total)}`].filter(Boolean).join(', ')}
      </p>
      <table>
        <thead>
          <tr><th aria-label="Got it" /><th>Item</th><th>Buy</th><th className="num">Needed</th><th className="num">Est.</th><th>Store</th><th>For</th></tr>
        </thead>
        {order.map((group) => (
          <tbody key={group}>
            <tr className="group"><th colSpan={7}>{group}</th></tr>
            {groups.get(group).map((l) => (
              <tr key={l.ingredientId ?? l.blendId}>
                <td><span className="tick" /></td>
                <td className="item">{l.name}</td>
                <td className="nowrap">
                  {l.blendId
                    ? `${l.packsToBuy} batch${l.packsToBuy === '1' ? '' : 'es'} (${qty(l.packSize, 2)} tsp)`
                    : l.packSize ? `${l.packsToBuy} × ${pack(l.packSize, l.uom, 2)}` : '—'}
                </td>
                <td className="num nowrap">{qty(l.amount, 2)} {l.uom}</td>
                <td className="num">{l.purchaseCost ? money(l.purchaseCost) : '—'}</td>
                <td>{l.vendor ?? ''}</td>
                <td className="for">{l.recipes.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

// Printing hides everything on the page except this list (see .printing in styles.css).
function printShoppingList() {
  document.body.classList.add('printing');
  window.addEventListener('afterprint', () => document.body.classList.remove('printing'), { once: true });
  window.print();
}

/**
 * Labor's "needed" is typed in rather than scaled from servings. Saving stores it for this
 * event; "Use recipes" clears it so the scaled total applies again.
 */
function NeededInput({ line, eventId }) {
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const value = draft ?? toDecimal(line.amount).toDecimalPlaces(2).toString();
  const save = async () => {
    if (draft === null) return;
    const d = toDecimal(draft);
    if (!d || d.lt(0)) return setError('Enter 0 or more');
    setError(null);
    try {
      await api(`/events/${eventId}/amounts/${line.ingredientId}`, { method: 'PUT', body: { amount: d.toString() } });
      notifyDataChanged();
    } catch (err) {
      setError(err.message);
    }
    setDraft(null);
  };
  const reset = async () => {
    await api(`/events/${eventId}/amounts/${line.ingredientId}`, { method: 'DELETE' });
    notifyDataChanged();
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
      <span className="nowrap">
        <input className="input num" style={{ width: 80 }} inputMode="decimal" value={value} aria-label={`${line.name} needed, in ${line.uom}`}
          aria-invalid={!!error} onChange={(e) => setDraft(e.target.value)} onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(null); setError(null); } }} />
        {' '}{line.uom}
      </span>
      {error && <small style={{ color: 'var(--tomato)' }}>{error}</small>}
      {line.amountSet && (
        <small className="muted no-print nowrap">
          Recipes: {qty(line.calculatedAmount, 2)} · <button type="button" className="link-btn" onClick={reset}>Use recipes</button>
        </small>
      )}
    </div>
  );
}

function ShoppingList({ s, eventId, title, date: day, guests }) {
  return (
    <div className="print-target" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="list-actions no-print">
        <a className="btn small" href={`/api/events/${eventId}/shopping-list.csv`} download><Icon.download /> Download CSV</a>
        <button className="btn small" onClick={printShoppingList}><Icon.print /> Print</button>
      </div>
      <PrintedList s={s} title={title} day={day} guests={guests} />
    <div className="panel table-wrap no-print">
      <table className="grid">
        <thead>
          <tr>
            <th>Ingredient</th>
            <th className="num" title="Total amount used across recipes, in the ingredient's unit of measurement">Needed</th>
            <th className="num" title="Whole store packs, at the latest purchase's pack size">Packs to buy</th>
            <th>Pack size</th>
            <th className="num" title="Packs to buy × the latest pack price: what you'll pay">Total cost</th>
            <th className="num" title="Cost of the amount the recipes use; matches the recipes' total cost">Used cost</th>
            <th className="num" title="What's left of the packs you buy after the recipes: packs × pack size − needed">Leftover</th>
            <th>Used in</th>
          </tr>
        </thead>
        <tbody>
          {s.shoppingList.map((l) => (
            <tr key={l.ingredientId ?? l.blendId} className={isLabor(l) ? 'labor-row' : ''}>
              <td style={{ fontWeight: 600 }}>
                {l.name}{l.missingPrice && <> <span className="badge warn">No price</span></>}
                {l.blendId && <div><small className="muted" style={{ fontWeight: 400 }}>Spice blend: make {l.packsToBuy} batch{l.packsToBuy === '1' ? '' : 'es'}</small></div>}
              </td>
              <td className="num nowrap">{isLabor(l) ? <NeededInput key={`${l.ingredientId}:${l.amount}`} line={l} eventId={eventId} /> : `${qty(l.amount, 2)} ${l.uom}`}</td>
              <td className="num" style={{ fontWeight: 700 }}>{l.packsToBuy}</td>
              <td className="nowrap">{l.packSize ? `${pack(l.packSize, l.uom, 2)}${l.blendId ? ' batch' : ''}` : '—'}</td>
              <td className="num" style={{ fontWeight: 650 }}>{l.purchaseCost ? money(l.purchaseCost) : '—'}</td>
              <td className="num">{money(l.usedCost)}</td>
              <td className="num nowrap muted">{qty(l.leftover, 2)} {l.uom}</td>
              <td className="muted">{l.recipes.join(', ')}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td>{s.shoppingList.length} items</td><td /><td /><td /><td className="num">{money(s.purchaseCost)}</td><td className="num">{money(s.totalCost)}</td><td /><td /></tr>
        </tfoot>
      </table>
    </div>
    </div>
  );
}
