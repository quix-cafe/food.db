import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { OPEN_ORDER_STATUSES, anticipateEvent, orderTimingSummary, paymentFee } from '@kitchen/shared';
import { api, notifyDataChanged } from '../api.js';
import { useApi, useLeaveGuard, useTick, useWhileVisible } from '../hooks.js';
import { date, duration, money, toDecimal, todayIso } from '../format.js';
import { OrderTiming } from '../components/OrderTiming.jsx';
import { CustomerNameField, ORDER_STATUS_LABEL, PAYMENT_METHODS, OrderStatus, dealLabel, orderItemTile, paymentLabel, saleMenu, tile, time, useSaleDraft } from '../components/Sales.jsx';
import { Icon, LeaveModal, Modal, Notice, Spinner, useToast } from '../components/ui.jsx';

// An event picked by hand holds for the day, so leaving the page doesn't switch it back, but one
// on another date gives way to an event today: see useOrderEvent.
const PICK_KEY = 'orders-event';
function readPick(today) {
  try {
    const pick = JSON.parse(localStorage.getItem(PICK_KEY));
    return pick?.day === today ? pick.id : null;
  } catch {
    return null;
  }
}
function savePick(id, day) {
  try { localStorage.setItem(PICK_KEY, JSON.stringify({ id, day })); } catch { /* holds until the page closes */ }
}

/**
 * Something on an order that can be changed at any time (its name, its note): tap to add or change
 * it. Enter or leaving the field saves, Escape cancels.
 */
function OrderField({ value, field, label, placeholder, className, max, onSave }) {
  const [editing, setEditing] = useState(null);
  const skip = useRef(false);
  if (editing === null) {
    return (
      <button type="button" className={`${className} ${value ? '' : 'none'}`} aria-label={value ? `Change the ${label} ${value}` : `Add a ${label}`}
        onClick={() => { skip.current = false; setEditing(value ?? ''); }}>
        {value ?? placeholder}
      </button>
    );
  }
  const commit = () => {
    if (skip.current) return;
    skip.current = true;
    setEditing(null);
    if (editing.trim() !== (value ?? '')) onSave({ [field]: editing });
  };
  return (
    <input className="input customer-name" autoFocus value={editing} maxLength={max} autoComplete="off" aria-label={`${label} for the order`}
      onChange={(e) => setEditing(e.target.value)} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') { skip.current = true; setEditing(null); }
      }} />
  );
}

const OrderName = ({ order, onSave }) => (
  <OrderField value={order.customerName} field="customerName" label="name" placeholder="Add name" className="order-name" max={120} onSave={onSave} />
);
const OrderNote = ({ order, onSave }) => (
  <OrderField value={order.note} field="note" label="note" placeholder="Add note" className="order-note-btn" max={500} onSave={onSave} />
);

/**
 * A note for the kitchen ("no onions"), typed in a dialog near the top of the screen so a phone's
 * keyboard doesn't cover it. Done keeps it; Remove clears it.
 */
function NoteDialog({ title, value, max, onSave, onClose }) {
  const [text, setText] = useState(value);
  const done = () => { onSave(text.trim()); onClose(); };
  return (
    <Modal title={title} onClose={onClose} className="note-dialog">
      <textarea className="input" rows={3} value={text} maxLength={max} autoFocus placeholder="For the kitchen, e.g. no onions"
        aria-label={title} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(); } }} />
      <div className="form-actions">
        {value && <button type="button" className="btn ghost" onClick={() => { onSave(''); onClose(); }}>Remove note</button>}
        <button type="button" className="btn primary" onClick={done}>Done</button>
      </div>
    </Modal>
  );
}

/** The note icon at the end of a row: filled in once there's a note. */
function NoteButton({ label, has, disabled, onClick }) {
  return (
    <button type="button" className={`icon-btn note-btn ${has ? 'has-note' : ''}`} disabled={disabled} onClick={onClick}
      aria-label={has ? `Change the ${label}` : `Add a ${label}`} title={has ? `Change the ${label}` : `Add a ${label}`}>
      <Icon.note />
    </button>
  );
}

/** Save a change to an order from any view of the queue. */
function useOrderChange(eventId, report) {
  const [error, setError] = useState(null);
  const toast = useToast();
  const change = async (order, body) => {
    setError(null);
    try {
      report.setData(await api(`/events/${eventId}/sales/${order.id}`, { method: 'PATCH', body }));
      notifyDataChanged();
      if (body.status) toast(`${order.customerName ?? 'Order'}: ${ORDER_STATUS_LABEL[body.status].toLowerCase()}`);
    } catch (err) {
      setError(err.message);
    }
  };
  return { change, error };
}

/** Which event orders are for. */
function useOrderEvent() {
  const { data: events, error } = useApi('/events');
  const [params, setParams] = useSearchParams();
  const { state } = useLocation();
  const today = todayIso();
  const [stored, setStored] = useState(() => readPick(today));
  const linked = params.get('event'); // from an event's Record sales button

  useEffect(() => {
    if (!linked) return;
    savePick(linked, today);
    setStored(linked);
  }, [linked, today]);

  // A link names its event (the dropdown sets one too). A remembered pick only holds if it's for
  // today or nothing is, so an old pick can't hide today's event.
  const suggested = events && anticipateEvent(events, today);
  const remembered = events?.find((e) => e.id === stored);
  const holds = remembered && (remembered.date === today || suggested?.date !== today);
  const event = events && (events.find((e) => e.id === linked) ?? (holds ? remembered : suggested));
  const choose = (id) => {
    savePick(id, today);
    setStored(id);
    setParams({ event: id }, { replace: true, state }); // keeps the page underneath the modal
  };
  return { events, event, error, choose, isToday: event?.date === today };
}

function Clock() {
  useTick(true, 5000);
  return <span className="pos-clock">{new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>;
}

/** Back to the app: to the page the modal opened over, or (from a bookmark) to the event. */
function CloseButton({ event }) {
  const navigate = useNavigate();
  const { state } = useLocation();
  if (state?.background) return <button type="button" className="btn pos-close" onClick={() => navigate(-1)}><Icon.close /> Close</button>;
  return <Link className="btn pos-close" to={event ? `/events/${event.id}` : '/events'}><Icon.close /> Exit</Link>;
}

/**
 * The menu as a list, which is also the order being built: − and + (first, before the name) set how many of each, and the
 * note icon at the end of a row adds a note for that item once it's on the order. An item with a
 * deal has a button adding a deal's worth. Each keeps its color on every screen, so hands learn it.
 */
function MenuList({ menu, draft, prepaid }) {
  const [noting, setNoting] = useState(null); // the menu row whose note is open
  return (
    <>
      <ul className="pos-items">
        {menu.map((r) => {
          const l = draft.line[r.key];
          const qty = l?.qty ?? 0;
          const t = draft.tally.get(r.key);
          const done = t ? (prepaid ? `${t.sold + t.givenAway} ordered` : `${t.sold} sold`) : null;
          return (
            <li key={r.key} className={`pos-item tiled ${qty ? 'in-line' : ''}`} style={tile(r)}>
              <div className="stepper">
                <button type="button" className="btn" disabled={draft.busy || !qty} onClick={() => draft.change(r, -1)} aria-label={`One fewer ${r.name}`}>−</button>
                <output aria-label={`${r.name} on the order`}>{qty}</output>
                <button type="button" className="btn" disabled={draft.busy} onClick={() => draft.change(r, 1)} aria-label={`One more ${r.name}`}>+</button>
              </div>
              <button type="button" className="pos-item-name" disabled={draft.busy} onClick={() => draft.change(r, 1)}
                aria-label={`Add ${r.name}${prepaid ? '' : `, ${money(r.salePrice)}`}`}>
                <b>{r.name}</b>
                {(done || l?.note) && (
                  <small>{done}{done && l?.note ? ' · ' : ''}{l?.note && <span className="pos-item-note">“{l.note}”</span>}</small>
                )}
              </button>
              {r.dealQty && !prepaid && (
                <button type="button" className="btn small pos-add-deal" disabled={draft.busy} onClick={() => draft.change(r, r.dealQty)}
                  aria-label={`Add ${r.dealQty} ${r.name}, ${dealLabel(r)}`}>+{r.dealQty} <small>{money(r.dealPrice)}</small></button>
              )}
              {!prepaid && (
                <button type="button" className="pos-item-price" disabled={draft.busy} onClick={() => draft.change(r, 1)} tabIndex={-1} aria-hidden="true">{money(r.salePrice)}</button>
              )}
              <NoteButton label={`note for ${r.name}`} has={!!l?.note} disabled={draft.busy || !qty} onClick={() => setNoting(r)} />
            </li>
          );
        })}
      </ul>
      {noting && (
        <NoteDialog title={`Note for ${noting.name}`} value={draft.line[noting.key]?.note ?? ''} max={300}
          onSave={(text) => draft.setLineNote(noting.key, text)} onClose={() => setNoting(null)} />
      )}
    </>
  );
}

function Ticket({ draft, prepaid }) {
  const { count, total, discount, busy } = draft;
  const [noting, setNoting] = useState(false);
  return (
    <section className="pos-ticket" aria-label="Current order">
      {!prepaid && (
        <div className="pos-total">
          <span>{count ? `${count} item${count === 1 ? '' : 's'}` : ''}{discount.gt(0) ? `${count ? ', ' : ''}deal −${money(discount)}` : ''}</span>
          <b>{money(total)}</b>
        </div>
      )}
      <CustomerNameField draft={draft}
        after={<NoteButton label="note for the order" has={!!draft.note.trim()} disabled={busy} onClick={() => setNoting(true)} />} />
      {draft.note.trim() && <p className="pos-order-note">“{draft.note.trim()}”</p>}
      {noting && <NoteDialog title="Note for the order" value={draft.note} max={500} onSave={draft.setNote} onClose={() => setNoting(false)} />}
      {draft.error && <Notice kind="error">{draft.error}</Notice>}
      {prepaid ? (
        // Paid for up front: one button sends it to the kitchen, free.
        <div className="pos-pay">
          <button type="button" className="btn primary pay-button pos-order" disabled={!count || busy} onClick={() => draft.record('free')}>Order</button>
          <button type="button" className="btn ghost" disabled={!count || busy} onClick={draft.clear}>Clear</button>
        </div>
      ) : (
        <div className="pos-pay">
          {PAYMENT_METHODS.map((m) => {
            const fee = paymentFee(m.value, total);
            return (
              <button key={m.value} type="button" className="btn primary pay-button" disabled={!count || busy} onClick={() => draft.record(m.value)}>
                {m.label}
                {count > 0 && toDecimal(fee).gt(0) && <small>Charge {money(total.plus(fee))}</small>}
              </button>
            );
          })}
          <button type="button" className="btn" disabled={!count || busy} onClick={() => draft.record('free')}>Given away</button>
          <button type="button" className="btn ghost" disabled={!count || busy} onClick={draft.clear}>Clear</button>
        </div>
      )}
    </section>
  );
}

/** A kitchen ticket on the board: its next step is the big button. */
function BoardCard({ order, onChange, menu, prepaid }) {
  const [busy, setBusy] = useState(false);
  const save = async (body) => {
    setBusy(true);
    await onChange(order, body);
    setBusy(false);
  };
  const act = (status, label, cls = '') => (
    <button type="button" className={`btn ${cls}`} disabled={busy} onClick={() => save({ status })}
      aria-label={`${label} ${order.customerName ?? `the ${time(order.createdAt)} order`}`}>{label}</button>
  );
  const done = order.status !== 'in_progress';
  return (
    <li className={`pos-card ${order.status}`}>
      <div className="pos-card-head">
        <OrderName order={order} onSave={save} />
        <small>{time(order.createdAt)}</small>
      </div>
      <ul className="order-items">
        {order.items.map((i, n) => (
          <li key={n} className="tiled" style={orderItemTile(menu, i)}>
            <b>{i.quantity}</b> {i.name}{i.deals > 0 && <span className="deal-tag">deal</span>}
            {i.note && <div className="order-note">{i.note}</div>}
          </li>
        ))}
      </ul>
      <OrderNote order={order} onSave={save} />
      {!(prepaid && order.paymentMethod === 'free') && <small className="muted">{paymentLabel(order.paymentMethod)}{order.paymentMethod !== 'free' && ` ${money(toDecimal(order.total).plus(order.fee))}`}</small>}
      {done && order.status === 'cancelled' && <OrderStatus status="cancelled" />}
      <OrderTiming order={order} />
      <div className="pos-card-actions">
        {!done && <>{act('completed', 'Complete', 'primary big')}{act('cancelled', 'Cancel', 'ghost')}</>}
        {done && act('in_progress', 'Reopen')}
      </div>
    </li>
  );
}

function BoardColumn({ title, orders, onChange, empty, menu, prepaid }) {
  return (
    <section className="pos-column" aria-label={title}>
      <h2>{title} <span>{orders.length}</span></h2>
      {orders.length
        ? <ul>{orders.map((o) => <BoardCard key={o.id} order={o} onChange={onChange} menu={menu} prepaid={prepaid} />)}</ul>
        : <p className="muted">{empty}</p>}
    </section>
  );
}

/** How many orders are at a stage; with any, a pill that opens the Orders tab where the screen has tabs. */
function StagePill({ stage, label, count, onOpen }) {
  if (!count) return <span><b>{count}</b> {label}</span>;
  return <button type="button" className={`pos-stage ${stage}`} onClick={onOpen}><b>{count}</b> {label}</button>;
}

function PosDesk({ event }) {
  const report = useApi(`/events/${event.id}/sales`);
  const summary = useApi(`/events/${event.id}/summary`);
  const menu = saleMenu(summary.data);
  const draft = useSaleDraft({ eventId: event.id, items: menu, totals: report.data?.totals, onRecorded: report.setData });
  const { change, error } = useOrderChange(event.id, report);
  const [pane, setPane] = useState('sell');
  const { blocker } = useLeaveGuard(draft.count > 0);
  useWhileVisible(report.reload, 10000); // keeps several screens in step

  if (report.error && !report.data) return <div className="pos-pad"><Notice kind="error">{report.error.message}</Notice></div>;
  if (summary.error && !summary.data) return <div className="pos-pad"><Notice kind="error">{summary.error.message}</Notice></div>;
  if (!report.data || !summary.data) return <div className="pos-pad"><Spinner /></div>;

  const { sales, totals } = report.data;
  // The queue is first come, first served; finished orders show the latest first.
  const isOpen = (s) => OPEN_ORDER_STATUSES.includes(s.status);
  const open = sales.filter(isOpen).reverse();
  const done = sales.filter((s) => !isOpen(s)).sort((a, b) => new Date(b.statusChangedAt) - new Date(a.statusChangedAt));
  const averages = orderTimingSummary(sales);
  // A personal chef job or supper club is paid for up front: orders only, no prices or payment.
  const prepaid = summary.data.kind !== 'market';

  return (
    <>
      <LeaveModal blocker={blocker}>This order hasn't been placed yet. Closing the POS discards it.</LeaveModal>
      <div className="pos-stats">
        <StagePill stage="in_progress" label="in progress" count={totals.byStatus.in_progress} onOpen={() => setPane('board')} />
        <span><b>{totals.sales}</b> order{totals.sales === 1 ? '' : 's'}</span>
        {!prepaid && <span><b>{money(totals.revenue)}</b> taken</span>}
        {averages.count > 0 && <span>Average total <b>{duration(averages.total)}</b></span>}
      </div>
      <div className="tabs pos-panes" role="tablist" aria-label="Order screen">
        <button role="tab" className="tab" aria-selected={pane === 'sell'} onClick={() => setPane('sell')}>New order{draft.count ? ` (${draft.count})` : ''}</button>
        <button role="tab" className="tab" aria-selected={pane === 'board'} onClick={() => setPane('board')}>
          <span className={open.length ? 'pos-open-orders' : undefined}>Orders ({open.length})</span>
        </button>
      </div>
      <div className="pos-desk">
        <div className="pos-sell" data-shown={pane === 'sell'}>
          <div className="pos-menu">
            {menu.length
              ? <MenuList menu={menu} draft={draft} prepaid={prepaid} />
              : <p className="muted">Nothing on the menu yet. <Link to={`/events/${event.id}`}>Add recipes to this event</Link> first.</p>}
          </div>
          <Ticket draft={draft} prepaid={prepaid} />
        </div>
        <div className="pos-board" data-shown={pane === 'board'}>
          {error && <Notice kind="error">{error}</Notice>}
          <div className="pos-columns">
            <BoardColumn title="In progress" orders={open} onChange={change} menu={menu} prepaid={prepaid} empty="Nothing being made." />
            <BoardColumn title="Done" orders={done} onChange={change} menu={menu} prepaid={prepaid} empty="Nothing finished yet." />
          </div>
        </div>
      </div>
    </>
  );
}

/** Taking orders and working the queue for an event, without the app around them, filling the page. */
export default function PosPage() {
  const { event, events, isToday, choose, error } = useOrderEvent();
  return (
    <div className="pos">
      <header className="pos-bar">
        {event ? (
          <div className="pos-event">
            <div className="ticket-pick">
              <h1>{event.name}</h1>
              <Icon.down />
              <select value={event.id} aria-label="Switch event" onChange={(e) => choose(e.target.value)}>
                {events.map((e) => <option key={e.id} value={e.id}>{e.name}, {date(e.date)}</option>)}
              </select>
            </div>
            {!isToday && <span className="pos-not-today">Not today: {date(event.date)}</span>}
          </div>
        ) : <h1>POS</h1>}
        <Clock />
        <CloseButton event={event} />
      </header>
      {error && <div className="pos-pad"><Notice kind="error">{error.message}</Notice></div>}
      {!events && !error && <div className="pos-pad"><Spinner /></div>}
      {events && !event && <div className="pos-pad"><p>No events yet. <Link to="/events">Create one</Link> and put something on its menu.</p></div>}
      {event && <PosDesk key={event.id} event={event} />}
    </div>
  );
}
