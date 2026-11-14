// Events as a calendar you read down: what's coming, nearest first, then what's been, month by month.
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useApi } from '../../hooks.js';
import { money, todayIso } from '../../format.js';
import { Icon, Notice, Spinner, TestBadge } from '../../components/ui.jsx';
import { DuplicateEventModal, NewEventForm } from '../../pages/EventsPage.jsx';
import { DayDot, KIND_LABEL, Tape, count, daysAway, monthName } from './parts.jsx';

function EventLine({ e, today, onCopy }) {
  const past = e.date < today;
  const menu = e.recipeCount + e.sauceCount;
  return (
    <li className={`event-line ${past ? 'past' : ''}`}>
      <Link to={`/events/${e.id}`}>
        <DayDot iso={e.date} size={past ? '' : 'big'} />
        <span className="what">
          <b>{e.name}</b> <TestBadge item={e} />
          <small>
            {!past && <em>{daysAway(e.date, today)}</em>}
            {!past && ', '}{KIND_LABEL[e.kind]}
            {e.guestCount != null && ` for ${e.guestCount}`}
          </small>
        </span>
        <span className="plan">
          {menu ? <>{count(menu, 'menu item')}<small>{e.totalServings} servings</small></> : <small>No menu yet</small>}
        </span>
        <span className="took">
          {/* What the event says it made; with nothing entered, what the order screen recorded. */}
          {e.actualRevenue != null ? <>{money(e.actualRevenue)}<small>revenue</small></>
            : e.recordedRevenue != null ? <>{money(e.recordedRevenue)}<small>recorded sales</small></>
            : null}
          {e.openOrders > 0 && <span className="badge new">{count(e.openOrders, 'open order')}</span>}
        </span>
      </Link>
      <button className="icon-btn" onClick={() => onCopy(e)} aria-label={`Duplicate ${e.name}`} title="Duplicate"><Icon.copy /></button>
    </li>
  );
}

export default function EventsPage() {
  const { data, error, loading } = useApi('/events');
  // Today's "Plan an event" opens the form. Clear the request, so coming back here doesn't open it again.
  const { state } = useLocation();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(!!state?.creating);
  useEffect(() => {
    if (state?.creating) navigate('/events', { replace: true, state: null });
  }, [state, navigate]);
  const [copying, setCopying] = useState(null);
  const today = todayIso();
  const upcoming = (data ?? []).filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past = (data ?? []).filter((e) => e.date < today).sort((a, b) => b.date.localeCompare(a.date));
  // Past events under their month, newest month first.
  const months = [];
  for (const e of past) {
    const name = monthName(e.date);
    if (months.at(-1)?.name !== name) months.push({ name, events: [] });
    months.at(-1).events.push(e);
  }

  return (
    <main className="page alt-page events">
      <header className="alt-head">
        <h1>Events</h1>
        {!creating && <button className="btn primary" onClick={() => setCreating(true)}><Icon.plus /> Plan an event</button>}
      </header>

      {creating && <NewEventForm onCancel={() => setCreating(false)} />}
      {error && <Notice kind="error">{error.message}</Notice>}
      {loading && !data && <Spinner />}

      {data && !data.length && !creating && (
        <div className="alt-empty">
          <p>No events yet. Plan one, pick its dishes and servings, and it works out the cost, the profit and one shopping list.</p>
          <button className="btn primary" onClick={() => setCreating(true)}><Icon.plus /> Plan an event</button>
        </div>
      )}

      {data?.length > 0 && (
        <section>
          <Tape>Coming up</Tape>
          {upcoming.length
            ? <ul className="event-lines">{upcoming.map((e) => <EventLine key={e.id} e={e} today={today} onCopy={setCopying} />)}</ul>
            : <p className="muted">Nothing on the calendar. Duplicate a past event to run it again.</p>}
        </section>
      )}

      {months.map((m) => (
        <section key={m.name}>
          <Tape>{m.name}</Tape>
          <ul className="event-lines">{m.events.map((e) => <EventLine key={e.id} e={e} today={today} onCopy={setCopying} />)}</ul>
        </section>
      ))}
      {copying && <DuplicateEventModal event={copying} onClose={() => setCopying(null)} />}
    </main>
  );
}
