import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, notifyDataChanged } from '../api.js';
import { useApi } from '../hooks.js';
import { isLabor } from '@kitchen/shared';
import { date, money, pack, qty, toDecimal } from '../format.js';
import { Field, Icon, Modal, Notice, Spinner, Tabs, useToast } from '../components/ui.jsx';

const isInt = (v) => /^\d+$/.test(String(v).trim());

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
          date: ev.date,
          guestCount: ev.guestCount == null ? '' : String(ev.guestCount),
          servings: Object.fromEntries(ev.recipes.map((r) => [r.recipeId, String(r.expectedServings)])),
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
      Object.values(form.servings).some((s) => !isInt(s)) ? 'Servings must be whole numbers' : null;
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
          <h1>{form.name || 'Untitled event'}</h1>
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
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'financials', label: 'Financials' }, { value: 'shopping', label: 'Shopping list' }]} />
        {summary.error && <Notice kind="error">{summary.error.message}</Notice>}
        {!s ? <Spinner /> : !s.recipes.length ? (
          <div className="panel empty"><p>Select recipes above to project costs and build the shopping list.</p></div>
        ) : tab === 'financials' ? <Financials s={s} /> : <ShoppingList s={s} eventId={id} title={form.name || 'Untitled event'} date={form.date} />}
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

function ShoppingList({ s, eventId, title, date: day }) {
  return (
    <div className="print-target" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h2 className="print-only">{title}: shopping list{day ? `, ${date(day)}` : ''}</h2>
        <button className="btn small no-print" style={{ marginLeft: 'auto' }} onClick={printShoppingList}><Icon.print /> Print</button>
      </div>
    <div className="panel table-wrap">
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
