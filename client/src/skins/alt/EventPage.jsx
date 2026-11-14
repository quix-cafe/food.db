// One event: the menu on the left as the thing you edit, the money beside it the whole time, and
// the shopping list, financials, sales and results as views of the same desk. The plan itself
// (form, autosave, versions) is the default app's useEventPlan, so both skins save the same way.
import { useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import { HOAMSY_FEE_PERCENT } from '@kitchen/shared';
import { useOpenPos } from '../../hooks.js';
import { dateTime, money, qty, toDecimal } from '../../format.js';
import { Icon, Modal, Notice, Spinner, TestBadge } from '../../components/ui.jsx';
import { SalesTable } from '../../components/Sales.jsx';
import { blankOrPrice, isInt } from '../../components/EventPricing.jsx';
import { Results, ShoppingList } from '../../components/EventTabs.jsx';
import { recipeColors } from '../../palette.js';
import { DuplicateEventModal } from '../../pages/EventsPage.jsx';
import { EVENT_TYPES, TargetHint, blankOrPercent, containerOf, useEventPlan } from '../../pages/EventPlanner.jsx';
import EventFinancials from './EventFinancials.jsx';
import EventMenu from './EventMenu.jsx';
import { AltIcon, DayDot, Segments, Tape, count } from './parts.jsx';

const VIEWS = [['menu', 'Menu'], ['shopping', 'Shopping list'], ['financials', 'Financials'], ['sales', 'Sales'], ['results', 'After the event']];

/** The bottom line, beside whatever you're editing; dimmed while a change is still saving. */
function MoneyRail({ s, pending, onShopping }) {
  if (!s || (!s.recipes.length && !s.sauces.length)) {
    return <aside className="money-rail empty"><p className="muted">Put dishes on the menu and the money shows here.</p></aside>;
  }
  const loss = toDecimal(s.profit).lt(0);
  const hoamsy = s.flat?.hoamsyPercent != null;
  const tickets = s.kind === 'supper_club' ? `${s.flat.tickets} × ${money(s.flat.flatPrice)}` : null;
  const food = toDecimal(s.totalCost).minus(s.labor.cost);
  // [label, value, note, class]; food, labor and fee carry the color of their piece of the split bar below.
  const rows = [
    hoamsy && ['Tickets', money(s.flat.gross), tickets],
    hoamsy && ['Hoamsy fee', `−${money(s.hoamsyFee)}`, `${s.flat.hoamsyPercent}% off the top`],
    ['Revenue', money(s.revenue), s.kind === 'personal_chef' ? `${money(s.flat.groceries)} of it groceries` : !hoamsy ? tickets : null, 'total'],
    ['Food', `−${money(food)}`, null, 'food'],
    toDecimal(s.labor.cost).gt(0) && ['Labor', `−${money(s.labor.cost)}`, `${qty(s.labor.hours)} hrs`, 'labor'],
    !toDecimal(s.vendorFee).isZero() && ['Vendor fee', `−${money(s.vendorFee)}`, null, 'fee'],
  ].filter(Boolean);
  // How the revenue splits: what food, labor and the fee take, and what's left.
  const revenue = toDecimal(s.revenue);
  const share = (v) => (revenue.gt(0) ? Math.max(0, Math.min(100, toDecimal(v).div(revenue).times(100).toNumber())) : 0);
  return (
    <aside className={`money-rail ${pending ? 'pending' : ''}`} aria-live="polite" title={pending ? 'Updating once the change saves' : undefined}>
      <dl className="rail-rows">
        {rows.map(([label, value, note, tone]) => (
          <div key={label} className={tone ?? ''}>
            <dt>{label}{note && <small>{note}</small>}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className={`rail-profit ${loss ? 'loss' : 'profit'}`}>
        <span>{loss ? 'Loss' : 'Profit'}</span>
        <b>{money(s.profit)}</b>
      </div>
      {revenue.gt(0) && (
        <div className="rail-split" role="img" aria-label={`Of the revenue: food ${share(food).toFixed(0)}%, labor ${share(s.labor.cost).toFixed(0)}%, vendor fee ${share(s.vendorFee).toFixed(0)}%, profit ${share(s.profit).toFixed(0)}%`}>
          <i className="food" style={{ width: `${share(food)}%` }} />
          <i className="labor" style={{ width: `${share(s.labor.cost)}%` }} />
          <i className="fee" style={{ width: `${share(s.vendorFee)}%` }} />
          <i className="left" style={{ width: `${share(s.profit)}%` }} />
        </div>
      )}
      <dl className="rail-margins">
        <div><dt>Gross margin</dt><dd>{s.grossMarginPercent == null ? '—' : `${s.grossMarginPercent}%`}</dd><small>on food</small></div>
        <div className={loss ? 'loss' : ''}><dt>Net margin</dt><dd>{s.marginPercent == null ? '—' : `${s.marginPercent}%`}</dd><small>after everything</small></div>
      </dl>
      <button type="button" className="rail-shop" onClick={onShopping}>
        <Icon.cart /> <span>To buy</span> <b>{money(s.purchaseCost)}</b>
      </button>
    </aside>
  );
}

/** What isn't on the menu yet: tap to add. */
function AddDishes({ recipes, sauces, onDish, onSauce, onClose }) {
  const [q, setQ] = useState('');
  const has = (name) => name.toLowerCase().includes(q.trim().toLowerCase());
  const dishes = recipes.filter((r) => has(r.name));
  const jars = sauces.filter((b) => has(b.name));
  return (
    <div className="add-dishes">
      <div className="add-dishes-head">
        <input className="input" type="search" placeholder="Find a dish or sauce" aria-label="Find a dish or sauce to add" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {onClose && <button type="button" className="btn small ghost" onClick={onClose}>Done</button>}
      </div>
      {!dishes.length && !jars.length && <p className="muted">{q ? `Nothing matches “${q}”.` : 'Everything is on the menu already.'}</p>}
      <ul>
        {dishes.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => onDish(r)}>
              <Icon.plus /> <span>{r.name}</span> <small>Cost {money(r.costPerServing)}, price {money(r.recommendedPrice)}</small>
            </button>
          </li>
        ))}
        {jars.map((b) => {
          const c = containerOf(b, b.container);
          return (
            <li key={b.id}>
              <button type="button" onClick={() => onSauce(b)}>
                <Icon.plus /> <span>{b.name}</span> <small>Sauce, by the {b.container}{c?.costPerServing ? `, cost ${money(c.costPerServing)} a serving` : ''}</small>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Each event gets its own page state, so edits waiting to save can't go out under the next event's id.
export default function EventPage() {
  const { id } = useParams();
  return <EventDesk key={id} id={id} />;
}

function EventDesk({ id }) {
  const plan = useEventPlan(id);
  const {
    form, setForm, loadError, status, saveError, recipes, sauces, summary, showAll, setShowAll, lastEdit, lastOrder, changedBy,
    set, toggle, toggleSauce, applyGuests, loadLatest, keepMine, remove,
  } = plan;
  const [params, setParams] = useSearchParams();
  const view = VIEWS.some(([v]) => v === params.get('tab')) ? params.get('tab') : 'menu';
  const setView = (v) => setParams(v === 'menu' ? {} : { tab: v }, { replace: true });
  const [deleting, setDeleting] = useState(false);
  const [copying, setCopying] = useState(false);
  const openPos = useOpenPos();
  const posUrl = `/pos?event=${id}`;

  // ?sales=1 goes straight to the order screen, so a phone can bookmark it.
  if (params.has('sales')) return <Navigate to={posUrl} replace />;
  if (loadError) return <main className="page alt-page"><Notice kind="error">{loadError}</Notice><Link to="/events">Back to events</Link></main>;
  if (!form) return <main className="page alt-page"><Spinner /></main>;

  const s = summary.data;
  const chosen = (recipes ?? []).filter((r) => r.id in form.servings);
  const unchosen = (recipes ?? []).filter((r) => !(r.id in form.servings));
  const chosenSauces = sauces.filter((b) => b.id in form.sauces);
  const unchosenSauces = sauces.filter((b) => !(b.id in form.sauces));
  const anyChosen = chosen.length + chosenSauces.length > 0;
  const adding = showAll || !anyChosen; // an empty menu starts with the list of what to add
  const colors = recipeColors([...Object.keys(form.servings), ...Object.keys(form.sauces).map((bid) => `blend:${bid}`)]);
  // A personal chef job or supper club has no prices per dish: each takes a share of the rate, from the summary.
  const flat = form.kind !== 'market';
  const supper = form.kind === 'supper_club';
  const summed = new Map([...(s?.recipes ?? []).map((r) => [r.recipeId, r]), ...(s?.sauces ?? []).map((b) => [`blend:${b.blendId}`, b])]);
  const pool = supper ? (form.hoamsy ? 'ticket money after Hoamsy’s cut' : 'ticket money') : 'rate and groceries';
  const bad = status === 'invalid' || status === 'error' || status === 'conflict';
  const statusText = { saved: 'Saved', pending: 'Unsaved changes', saving: 'Saving…', invalid: saveError, error: saveError, conflict: 'Not saved' }[status];

  return (
    <main className="page alt-page desk">
      <header className="desk-head">
        <div className="desk-title">
          <DayDot iso={form.date} size="big" />
          <input className="desk-name" value={form.name} onChange={set('name')} aria-label="Event name" placeholder="Untitled event" />
          <TestBadge item={form} />
          <span className={`save-state ${bad ? 'bad' : ''}`} role="status">{status === 'saving' && <Spinner />}{statusText}</span>
          <a className="btn alt-orders" href={posUrl} onClick={anyChosen ? openPos(posUrl) : (e) => e.preventDefault()} aria-disabled={!anyChosen}
            title={anyChosen ? 'Take orders on the order screen' : 'Put dishes on the menu first'}>
            <AltIcon.orders /> Take orders
          </a>
        </div>
        <div className="desk-facts">
          <label><span>Date</span><input className="input" type="date" value={form.date} onChange={set('date')} /></label>
          <label><span>Type</span>
            <select className="select" value={form.kind} onChange={set('kind')} title={EVENT_TYPES.find(([k]) => k === form.kind)?.[2]}>
              {EVENT_TYPES.map(([k, label, hint]) => <option key={k} value={k} title={hint}>{label}</option>)}
            </select>
          </label>
          <label className="narrow"><span>{supper ? 'Tickets' : 'Guests'}</span>
            <input className="input num" inputMode="numeric" value={form.guestCount} onChange={set('guestCount')} aria-invalid={form.guestCount !== '' && !isInt(form.guestCount)} />
          </label>
          {flat && (
            <label className="money"><span>{supper ? 'Plate price' : 'Flat rate'}</span>
              <span className="money-input"><span aria-hidden="true">$</span>
                <input className="input num" inputMode="decimal" value={form.flatPrice} onChange={set('flatPrice')} placeholder="0.00" aria-invalid={!blankOrPrice(form.flatPrice)}
                  title={supper ? 'One ticket: a plate of everything on the menu' : 'For the whole job; the groceries are billed on top, at cost'} />
              </span>
              <small><TargetHint s={s} form={form} setForm={setForm} saved={status === 'saved'} /></small>
            </label>
          )}
          <label className="money"><span>Vendor fee</span>
            <span className="money-input"><span aria-hidden="true">$</span>
              <input className="input num" inputMode="decimal" value={form.vendorFee} onChange={set('vendorFee')} placeholder="0.00" aria-invalid={!blankOrPrice(form.vendorFee)} />
            </span>
          </label>
          {supper && (
            // Optional: ticked, Hoamsy takes this percent off every ticket before anything else.
            <div className="hoamsy">
              <label className="check">
                <input type="checkbox" checked={form.hoamsy}
                  onChange={(e) => { const on = e.target.checked; setForm((f) => ({ ...f, hoamsy: on, hoamsyPercent: on && !f.hoamsyPercent ? String(HOAMSY_FEE_PERCENT) : f.hoamsyPercent })); }} />
                <span>Hoamsy fee</span>
              </label>
              {form.hoamsy && (
                <span className="unit-input">
                  <input className="input num" inputMode="decimal" value={form.hoamsyPercent} onChange={set('hoamsyPercent')} placeholder={String(HOAMSY_FEE_PERCENT)}
                    aria-label="Hoamsy fee, percent of each ticket" aria-invalid={!blankOrPercent(form.hoamsyPercent)} title="Taken off every ticket before anything else" />
                  <span aria-hidden="true">%</span>
                </span>
              )}
            </div>
          )}
        </div>
      </header>

      {status === 'conflict' && (
        <div className="notice error plan-conflict" role="alert">
          <Icon.alert />
          <div>
            <b>{changedBy && !changedBy.you ? `${changedBy.actor} changed this event` : changedBy?.you ? `This event was changed from your network (${changedBy.actor}), maybe in another window` : 'This event was changed somewhere else'}, so your edits here aren't saved.</b> This window was holding an older copy of the plan.
            <div className="plan-conflict-actions">
              <button className="btn small primary" onClick={loadLatest}>Load the saved plan</button>
              <button className="btn small" onClick={keepMine}>Replace it with this window's plan</button>
            </div>
          </div>
        </div>
      )}

      <div className="desk-body">
        <div className="desk-main">
          <div className="desk-views">
            <Segments label="Show" value={view} onChange={setView} options={VIEWS} />
          </div>

          {view === 'menu' && (
            <section className="menu-view">
              <div className="menu-head">
                <Tape>The menu</Tape>
                <span className="muted">{count(chosen.length, 'dish', 'dishes')}{chosenSauces.length ? `, ${count(chosenSauces.length, 'sauce')}` : ''}</span>
                <span className="menu-head-actions">
                  {anyChosen && (
                    <button className="btn small" disabled={!isInt(form.guestCount) || !chosen.length} onClick={applyGuests}>
                      Set every dish to {isInt(form.guestCount) ? form.guestCount : supper ? 'the tickets' : 'the guest count'}
                    </button>
                  )}
                  {anyChosen && !showAll && unchosen.length + unchosenSauces.length > 0 && (
                    <button className="btn small primary" onClick={() => setShowAll(true)}><Icon.plus /> Add dishes</button>
                  )}
                </span>
              </div>

              {recipes && !recipes.length && !sauces.length && (
                <div className="alt-empty"><p>There are no recipes yet.</p><Link className="btn primary" to="/recipes/new">Create a recipe</Link></div>
              )}

              {anyChosen && (
                <EventMenu plan={plan} dishes={chosen} jars={chosenSauces} colors={colors} flat={flat} pool={pool} summed={summed} pending={status !== 'saved'} />
              )}

              {adding && (recipes?.length > 0 || sauces.length > 0) && (
                <>
                  {anyChosen ? <h3 className="add-title">Add to the menu</h3> : <p className="add-title">Nothing on the menu yet. Tap a dish to add it.</p>}
                  <AddDishes recipes={unchosen} sauces={unchosenSauces} onDish={toggle} onSauce={toggleSauce} onClose={anyChosen ? () => setShowAll(false) : null} />
                </>
              )}
            </section>
          )}

          {view !== 'menu' && (
            <section className="desk-view">
              {summary.error && <Notice kind="error">{summary.error.message}</Notice>}
              {!s ? <Spinner /> : !s.recipes.length && !s.sauces.length ? (
                <div className="alt-empty"><p>Put dishes on the menu first; the costs and the shopping list come from them.</p><button className="btn primary" onClick={() => setView('menu')}>Go to the menu</button></div>
              ) : view === 'financials' ? <EventFinancials s={s} eventId={id} />
                : view === 'sales' ? <SalesTable eventId={id} onRecord={openPos(posUrl)} />
                : view === 'results' ? <Results s={s} form={form} set={set} setForm={setForm} eventId={id} />
                : <ShoppingList s={s} eventId={id} title={form.name || 'Untitled event'} date={form.date} guests={form.guestCount} />}
            </section>
          )}
          {s?.warnings.length > 0 && <Notice>{s.warnings.map((w) => <div key={w}>{w}</div>)}</Notice>}
        </div>

        <MoneyRail s={s} pending={status !== 'saved'} onShopping={() => setView('shopping')} />
      </div>

      <footer className="desk-foot">
        <span className="who">
          {status === 'saved' && lastEdit && <span>Last edited by {lastEdit.actor}, {dateTime(lastEdit.at)}</span>}
          {lastOrder && <span>Last order entered by {lastOrder.actor}, {dateTime(lastOrder.at)}</span>}
        </span>
        <span className="form-actions">
          <button className="btn small" onClick={() => setCopying(true)} disabled={status === 'pending' || status === 'saving'}
            title={status === 'saved' ? 'A copy of this plan under a new name and date' : 'Wait for the changes to save'}><Icon.copy /> Duplicate</button>
          <button className="btn small danger" onClick={() => setDeleting(true)}><Icon.trash /> Delete event</button>
        </span>
      </footer>
      {copying && <DuplicateEventModal event={{ id, name: form.name || 'Untitled event', date: form.date }} onClose={() => setCopying(false)} />}
      {deleting && (
        <Modal title={`Delete ${form.name}?`} onClose={() => setDeleting(false)}>
          <p>The event, its menu and any sales recorded for it will be removed. The recipes themselves are kept.</p>
          <div className="form-actions">
            <button className="btn ghost" onClick={() => setDeleting(false)}>Keep it</button>
            <button className="btn danger" onClick={remove}>Delete event</button>
          </div>
        </Modal>
      )}
    </main>
  );
}
