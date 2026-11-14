// Today: what's next and what to do about it, then how the last month went.
import { Link } from 'react-router';
import { useApi, useOpenPos, useTestMode } from '../../hooks.js';
import { date, money, todayIso, toDecimal } from '../../format.js';
import { Icon, Notice, Spinner, TestBadge } from '../../components/ui.jsx';
import DashboardChart from '../../components/DashboardChart.jsx';
import { recipeColors } from '../../palette.js';
import { AltIcon, DayDot, KIND_LABEL, Tape, count, daysAway, longDay } from './parts.jsx';

/** The next event as the ticket on the rail: its numbers, its menu, and the three things you'd do with it. */
function NextUp({ event, today }) {
  const { data: s } = useApi(`/events/${event.id}/summary`);
  const openPos = useOpenPos();
  const isToday = event.date === today;
  const items = s ? [
    ...s.recipes.map((r) => ({ key: r.recipeId, name: r.name, servings: r.expectedServings })),
    ...s.sauces.map((b) => ({ key: `blend:${b.blendId}`, name: b.name, servings: b.expectedServings })),
  ] : [];
  const colors = recipeColors(items.map((i) => i.key));
  const most = Math.max(1, ...items.map((i) => Number(i.servings)));
  const loss = s && toDecimal(s.profit).lt(0);
  const kind = s?.kind ?? 'market';
  const who = event.guestCount != null ? `${event.guestCount} ${kind === 'supper_club' ? 'tickets' : 'guests'}` : null;
  return (
    <article className="next-ticket">
      <header>
        <DayDot iso={event.date} size="big" />
        <div>
          <h2><Link to={`/events/${event.id}`}>{event.name}</Link> <TestBadge item={event} /></h2>
          <p>
            <b className={isToday ? 'now' : ''}>{daysAway(event.date, today)}</b>, {longDay(event.date).replace(/, \d{4}$/, '')}
            <small>{KIND_LABEL[kind]}{who ? ` for ${who}` : ''}</small>
          </p>
        </div>
        {event.openOrders > 0 && <span className="badge new">{count(event.openOrders, 'open order')}</span>}
      </header>

      {!s ? <Spinner /> : !items.length ? (
        <p className="muted">Nothing on the menu yet. <Link to={`/events/${event.id}`}>Pick the dishes</Link> to see what it costs and what to buy.</p>
      ) : (
        <>
          <dl className="ticket-figures">
            <div><dt>Revenue</dt><dd>{money(s.revenue)}</dd></div>
            <div><dt>Cost</dt><dd>{money(s.totalCost)}</dd></div>
            <div className={loss ? 'loss' : 'profit'}><dt>Profit</dt><dd>{money(s.profit)}</dd></div>
            <div><dt>Net margin</dt><dd>{s.marginPercent == null ? '—' : `${s.marginPercent}%`}</dd></div>
          </dl>
          <ul className="ticket-menu" aria-label="Menu">
            {items.map((i) => (
              <li key={i.key} style={{ '--tile': colors.get(i.key) }}>
                <span className="name">{i.name}</span>
                <span className="bar" aria-hidden="true"><i style={{ width: `${(Number(i.servings) / most) * 100}%` }} /></span>
                <b>{i.servings}</b>
              </li>
            ))}
          </ul>
        </>
      )}

      <footer>
        {isToday
          ? <a className="btn primary big" href={`/pos?event=${event.id}`} onClick={openPos(`/pos?event=${event.id}`)}><AltIcon.orders /> Take orders</a>
          : <Link className="btn primary" to={`/events/${event.id}`}>Open the plan</Link>}
        {s && items.length > 0 && (
          <Link className="btn" to={`/events/${event.id}?tab=shopping`}>
            <Icon.cart /> Shopping list <span className="muted">{money(s.purchaseCost)}</span>
          </Link>
        )}
        {isToday
          ? <Link className="btn" to={`/events/${event.id}`}>Open the plan</Link>
          : <a className="btn" href={`/pos?event=${event.id}`} onClick={openPos(`/pos?event=${event.id}`)}><AltIcon.orders /> Take orders</a>}
      </footer>
    </article>
  );
}

function Later({ events, today }) {
  return (
    <ul className="later-list">
      {events.map((e) => (
        <li key={e.id}>
          <Link to={`/events/${e.id}`}>
            <DayDot iso={e.date} />
            <span>
              <b>{e.name}</b> <TestBadge item={e} />
              <small className="muted">{daysAway(e.date, today)}, {count(e.recipeCount + e.sauceCount, 'menu item')}, {e.totalServings} servings</small>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** What sells most, by the recipe's own servings, as bars against the best seller. */
function BestSellers({ items }) {
  if (!items.length) return <p className="muted">Nothing sold yet. Orders taken on the order screen are counted here.</p>;
  const top = Math.max(...items.map((r) => r.sold));
  return (
    <ol className="sellers">
      {items.map((r) => {
        const to = r.recipeId ? `/recipes/${r.recipeId}` : r.blendId ? `/spice-lab/${r.blendId}` : null;
        return (
          <li key={r.recipeId ?? r.blendId ?? r.name}>
            {to ? <Link to={to}>{r.name}</Link> : <span>{r.name}</span>}
            <span className="bar" aria-hidden="true"><i style={{ width: `${(r.sold / top) * 100}%` }} /></span>
            <b>{r.sold}</b>
          </li>
        );
      })}
    </ol>
  );
}

export default function TodayPage() {
  const today = todayIso();
  const test = useTestMode(); // test data only counts in test mode, so turning it off asks again
  const { data: d, error } = useApi(`/dashboard?today=${today}${test ? '&test=1' : ''}`);
  const [next, ...later] = d?.upcomingEvents ?? [];
  const net = d && toDecimal(d.sales.revenue).minus(d.spend.spent);
  return (
    <main className="page alt-page today">
      <h1 className="visually-hidden">Today</h1>
      {error && <Notice kind="error">{error.message}</Notice>}
      {!d && !error && <Spinner />}
      {d && (
        <>
          <section>
            <Tape>{next?.date === today ? 'On today' : 'Next up'}</Tape>
            {next ? <NextUp event={next} today={today} /> : (
              <div className="alt-empty">
                <p>Nothing on the calendar.</p>
                <Link className="btn primary" to="/events" state={{ creating: true }}><Icon.plus /> Plan an event</Link>
              </div>
            )}
          </section>

          {later.length > 0 && (
            <section>
              <Tape>After that</Tape>
              <Later events={later} today={today} />
              {d.upcoming > d.upcomingEvents.length && <Link to="/events">All {d.upcoming} upcoming events</Link>}
            </section>
          )}

          <div className="today-cols">
            <section>
              <Tape>The last 30 days</Tape>
              <dl className="month-figures">
                <div><dt>Revenue</dt><dd><Link to="/events">{money(d.sales.revenue)}</Link></dd><small>{count(d.sales.orders, 'order')}</small></div>
                <div><dt>Purchases</dt><dd><Link to="/purchases">{money(d.spend.spent)}</Link></dd><small>{count(d.spend.trips, 'shopping trip')}</small></div>
                <div className={net.lt(0) ? 'loss' : 'profit'}><dt>Difference</dt><dd>{money(net)}</dd><small>revenue less purchases</small></div>
              </dl>
              <DashboardChart days={d.days} />
              {d.lastEvent && (
                <p className="last-event">
                  Last event: <Link to={`/events/${d.lastEvent.id}`}>{d.lastEvent.name}</Link>, {date(d.lastEvent.date)}.{' '}
                  {d.lastEvent.orders > 0 ? `${count(d.lastEvent.orders, 'order')} for ${money(d.lastEvent.revenue)}.` : 'No orders were recorded.'}
                </p>
              )}
            </section>
            <section>
              <Tape>Best sellers</Tape>
              <BestSellers items={d.topItems} />
              <p className="muted cookbook-line">
                <Link to="/recipes">{count(d.recipes, 'recipe')}</Link> in all{d.averageMargin != null && `, ${d.averageMargin}% average margin`}.
              </p>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
