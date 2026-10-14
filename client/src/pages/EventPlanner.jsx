import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, notifyDataChanged } from '../api.js';
import { useApi } from '../hooks.js';
import { money, qty, toDecimal } from '../format.js';
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
        ) : tab === 'financials' ? <Financials s={s} /> : <ShoppingList s={s} />}
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
          </tbody>
          <tfoot>
            <tr><td>Total</td><td className="num">{s.recipes.reduce((a, r) => a + Number(r.expectedServings), 0)}</td><td /><td /><td className="num">{money(s.totalCost)}</td><td className="num">{money(s.revenue)}</td><td className="num">{money(s.profit)}</td></tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

function ShoppingList({ s }) {
  return (
    <div className="panel table-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th>Ingredient</th>
            <th className="num" title="Fraction of purchase units actually used, after Use %">Needed</th>
            <th className="num">Buy</th>
            <th>Unit</th>
            <th className="num">Est. cost</th>
            <th>Used in</th>
          </tr>
        </thead>
        <tbody>
          {s.shoppingList.map((l) => (
            <tr key={`${l.ingredientId}|${l.unit}`}>
              <td style={{ fontWeight: 600 }}>{l.name}{l.missingPrice && <> <span className="badge warn">No price</span></>}</td>
              <td className="num">{qty(l.usage)}</td>
              <td className="num" style={{ fontWeight: 700 }}>{l.unitsToBuy}</td>
              <td>{l.unit ?? '—'}</td>
              <td className="num">{money(l.estimatedCost)}</td>
              <td className="muted">{l.recipes.join(', ')}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td>{s.shoppingList.length} items</td><td /><td /><td /><td className="num">{money(s.totalCost)}</td><td /></tr>
        </tfoot>
      </table>
    </div>
  );
}
