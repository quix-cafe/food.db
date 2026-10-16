import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, notifyDataChanged } from '../api.js';
import { useApi } from '../hooks.js';
import { date, dateTime, money, percent, todayIso } from '../format.js';
import { Field, Icon, Menu, Modal, Notice, Spinner, TestBadge, useToast } from '../components/ui.jsx';

export default function RecipeGallery() {
  const { data, error, loading } = useApi('/recipes');
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
        <Link className="btn primary" to="/recipes/new"><Icon.plus /> New recipe</Link>
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

      <div className="gallery">
        {(data ?? []).map((r) => (
          <article key={r.id} className="panel recipe-card">
            {r.coverImage && (
              <div className="card-cover"><img src={r.coverImage.url} alt="" loading="lazy" /></div>
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
            <div className="card-figure">
              <b>{money(r.costPerServing)}</b>
              <span className="muted">per serving</span>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className="badge">{r.baseServings} servings</span>
              <span className="badge good">{percent(r.targetMargin, 0)} margin, sell at {money(r.recommendedPrice)}</span>
              {r.missingPrices > 0 && <span className="badge warn">{r.missingPrices} unpriced</span>}
            </div>
            <div className="card-meta">
              <span>{r.ingredientCount} ingredients{r.imageCount > 1 ? `, ${r.imageCount} photos` : ''}</span>
              <span title={r.lastPriceSync ?? ''}>{r.lastPriceSync ? `Prices from ${dateTime(r.lastPriceSync)}` : 'No prices yet'}</span>
            </div>
          </article>
        ))}
      </div>

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
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();
  const upcoming = (events ?? []).filter((e) => e.date >= todayIso());

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let id = eventId;
      if (id === 'new') {
        const created = await api('/events', { method: 'POST', body: { name: newName, date: newDate, guestCount: servings } });
        id = created.id;
      }
      const ev = await api(`/events/${id}/recipes`, { method: 'POST', body: { recipeId: recipe.id, expectedServings: servings } });
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
        {error && <Notice kind="error">{error}</Notice>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>Add to event</button>
        </div>
      </form>
    </Modal>
  );
}
