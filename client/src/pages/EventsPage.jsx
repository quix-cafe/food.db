import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, notifyDataChanged } from '../api.js';
import { useApi } from '../hooks.js';
import { todayIso } from '../format.js';
import { Field, Icon, Modal, Notice, Spinner, TestBadge, useToast } from '../components/ui.jsx';

function DateBlock({ iso }) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return (
    <div className="date-block" aria-hidden="true">
      <small>{dt.toLocaleDateString('en-US', { month: 'short' })}</small>
      <b>{d}</b>
    </div>
  );
}

export default function EventsPage() {
  const { data, error, loading } = useApi('/events');
  const [creating, setCreating] = useState(false);
  const [copying, setCopying] = useState(null);
  const today = todayIso();
  const upcoming = (data ?? []).filter((e) => e.date >= today).reverse();
  const past = (data ?? []).filter((e) => e.date < today);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Events</h1>
          <p>Plan a service or catering day: pick recipes and servings to project cost and profit, and get one combined shopping list.</p>
        </div>
        {!creating && <button className="btn primary" onClick={() => setCreating(true)}><Icon.plus /> New event</button>}
      </div>

      {creating && <NewEventForm onCancel={() => setCreating(false)} />}
      {error && <Notice kind="error">{error.message}</Notice>}
      {loading && !data && <Spinner />}

      {data && !data.length && !creating && (
        <div className="panel empty">
          <h2>No events planned</h2>
          <p>Create an event, then add recipes with the number of servings you expect.</p>
          <button className="btn primary" onClick={() => setCreating(true)}>Plan an event</button>
        </div>
      )}

      {[['Upcoming', upcoming], ['Past', past]].map(([label, list]) => list.length > 0 && (
        <section key={label} className="panel">
          <div className="panel-head"><h2>{label}</h2></div>
          <div className="event-list">
            {list.map((e) => (
              <div key={e.id} className={`event-item ${e.date < today ? 'past' : ''}`}>
                <Link to={`/events/${e.id}`} className="event-row">
                  <DateBlock iso={e.date} />
                  <div>
                    <h3>{e.name} <TestBadge item={e} /></h3>
                    <span className="muted">{new Date(e.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</span>
                  </div>
                  <span className="muted">
                    {e.recipeCount} {e.recipeCount === 1 ? 'recipe' : 'recipes'}, {e.totalServings} servings
                    {e.guestCount != null && `, ${e.guestCount} guests`}
                  </span>
                </Link>
                <button className="icon-btn" onClick={() => setCopying(e)} aria-label={`Duplicate ${e.name}`} title="Duplicate"><Icon.copy /></button>
              </div>
            ))}
          </div>
        </section>
      ))}
      {copying && <DuplicateEventModal event={copying} onClose={() => setCopying(null)} />}
    </main>
  );
}

/** Copy an event's plan (recipes, sauces, pricing, guests, fee) under a new name and date, then open the copy. */
export function DuplicateEventModal({ event, onClose }) {
  const [name, setName] = useState(`${event.name} (copy)`);
  const [date, setDate] = useState(event.date >= todayIso() ? event.date : todayIso());
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const copy = await api(`/events/${event.id}/duplicate`, { method: 'POST', body: { name, date } });
      notifyDataChanged();
      toast(`Duplicated as ${copy.name}`);
      onClose();
      navigate(`/events/${copy.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={`Duplicate ${event.name}`} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p className="muted">The copy gets the same recipes, sauces, prices, guests and vendor fee. Sales, results and notes stay with this one.</p>
        <div className="form-grid">
          <Field label="Event name" className="span-2"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy && <Spinner />} Duplicate</button>
        </div>
      </form>
    </Modal>
  );
}

/** A new event's name, date and guests; creating it opens the planner. `bare` drops the panel (in Quick add). */
export function NewEventForm({ onCancel, bare = false }) {
  const [name, setName] = useState('');
  const [date, setDate] = useState(todayIso());
  const [guests, setGuests] = useState('');
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    try {
      const ev = await api('/events', { method: 'POST', body: { name, date, guestCount: guests } });
      notifyDataChanged();
      onCancel?.();
      navigate(`/events/${ev.id}`);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <form className={bare ? '' : 'panel panel-pad'} onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="form-grid">
        <Field label="Event name" className="span-2"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></Field>
        <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
        <Field label="Guests"><input className="input num" inputMode="numeric" value={guests} onChange={(e) => setGuests(e.target.value)} placeholder="Optional" /></Field>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button className="btn primary">Create event</button>
      </div>
    </form>
  );
}
