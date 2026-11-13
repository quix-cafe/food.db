import { Link } from 'react-router';
import { useApi, useTestMode } from '../hooks.js';
import { date, money, todayIso } from '../format.js';
import { Icon, Notice, Spinner, TestBadge } from '../components/ui.jsx';
import DashboardChart from '../components/DashboardChart.jsx';
import { DateBlock } from './EventsPage.jsx';

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How far off a date is: "Today", "Tomorrow", "In 12 days". */
function daysAway(iso, today) {
  const days = Math.round((Date.parse(iso) - Date.parse(today)) / 86400000);
  return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`;
}

function Figure({ to, label, value, note }) {
  return (
    <Link to={to} className="panel figure dash-figure">
      <span>{label}</span>
      <b>{value}</b>
      {note && <small className="muted">{note}</small>}
    </Link>
  );
}

function UpcomingEvents({ events, total, today }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Upcoming events</h2>
        <Link to="/events">{total > events.length ? `All ${total} upcoming` : 'All events'}</Link>
      </div>
      {events.length ? (
        <div className="event-list">
          {events.map((e) => (
            <div key={e.id} className="event-item">
              <Link to={`/events/${e.id}`} className="event-row">
                <DateBlock iso={e.date} />
                <div>
                  <h3>{e.name} <TestBadge item={e} /></h3>
                  <span className="muted">
                    {daysAway(e.date, today)}
                    {e.openOrders > 0 && `, ${count(e.openOrders, 'open order')}`}
                  </span>
                </div>
                <span className="muted">
                  {count(e.recipeCount + e.sauceCount, 'menu item')}, {e.totalServings} servings
                  {e.guestCount != null && `, ${e.guestCount} guests`}
                </span>
              </Link>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">
          <p>Nothing on the calendar.</p>
          <Link className="btn primary" to="/events" state={{ creating: true }}><Icon.plus /> Plan an event</Link>
        </div>
      )}
    </section>
  );
}

/** What sells most, by the recipe's own servings, so "3 tacos for $14" counts 3: every event's orders, without cancelled or given-away ones. */
function MostSold({ items }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2>Most sold</h2></div>
      {items.length ? (
        <ol className="rank-list">
          {items.map((r) => {
            const to = r.recipeId ? `/recipes/${r.recipeId}` : r.blendId ? `/spice-lab/${r.blendId}` : null;
            return (
              <li key={r.recipeId ?? r.blendId ?? r.name}>
                {to ? <Link to={to}>{r.name}</Link> : <span>{r.name}</span>}
                <b>{r.sold}</b>
              </li>
            );
          })}
        </ol>
      ) : <p className="muted panel-pad">Nothing sold yet.</p>}
    </section>
  );
}

/** The main view: what's coming up, how money moves, what sells, and a few figures linking to their pages. */
export default function DashboardPage() {
  const today = todayIso();
  const test = useTestMode(); // test data only counts in test mode, so turning it off asks again
  const { data: d, error } = useApi(`/dashboard?today=${today}${test ? '&test=1' : ''}`);
  return (
    <main className="page">
      <div className="page-head"><h1>Dashboard</h1></div>
      {error && <Notice kind="error">{error.message}</Notice>}
      {!d && !error && <Spinner />}
      {d && (
        <>
          <div className="dash-row">
            <UpcomingEvents events={d.upcomingEvents} total={d.upcoming} today={today} />
            <MostSold items={d.topItems} />
          </div>
          <div className="figures">
            {d.lastEvent
              ? <Figure to={`/events/${d.lastEvent.id}`} label="Last event" value={money(d.lastEvent.revenue)} note={`${d.lastEvent.name}, ${date(d.lastEvent.date)}: ${count(d.lastEvent.orders, 'order')}`} />
              : <Figure to="/events" label="Events" value={d.events} />}
            <Figure to="/events" label="Sales, last 30 days" value={money(d.sales.revenue)} note={count(d.sales.orders, 'order')} />
            <Figure to="/purchases" label="Spent, last 30 days" value={money(d.spend.spent)} note={count(d.spend.trips, 'shopping trip')} />
            <Figure to="/recipes" label="Recipes" value={d.recipes} note={d.averageMargin != null ? `${d.averageMargin}% average margin` : null} />
          </div>
          <section className="panel panel-pad dash-trend">
            <h2>Purchases and revenue</h2>
            <DashboardChart days={d.days} />
          </section>
        </>
      )}
    </main>
  );
}
