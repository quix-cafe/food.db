import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, notifyDataChanged, onDataChanged } from '../api.js';
import { useApi, useOpenPos, useWhileVisible } from '../hooks.js';
import { DEFAULT_MARGIN, HOAMSY_FEE_PERCENT, SAUCE_CONTAINERS, amountLabel, eventServing, parseAmount, sauceContainer } from '@kitchen/shared';
import { dateTime, money, qty, toDecimal } from '../format.js';
import { Field, Icon, Modal, Notice, Spinner, Tabs, TestBadge, useToast } from '../components/ui.jsx';
import { SalesTable } from '../components/Sales.jsx';
import { DealToggle, MarginCell, SalePriceInput, blankOrPrice, dealNote, dealProblem, isInt, priceText, pricingFor } from '../components/EventPricing.jsx';
import { Financials, Results, ShoppingList } from '../components/EventTabs.jsx';
import { recipeColors } from '../palette.js';
import { DuplicateEventModal } from './EventsPage.jsx';

const optional = (v) => (v == null ? '' : String(v));
export const blankOrInt = (v) => v.trim() === '' || isInt(v);
export const isCount = (v) => isInt(v) && Number(v) > 0;
/** A sauce's container cost and default price, or null while it can't be worked out. */
export const containerOf = (b, container) => { try { return sauceContainer(b, container); } catch { return null; } };
export const noPricing = () => ({ salePrice: '', dealPrice: '', dealQty: '', servingSize: '' });
/** How an event makes its money (EVENT_KINDS): each recipe sold by the serving, or one rate for the lot. */
export const EVENT_TYPES = [
  ['market', 'Market', 'Each recipe sold by the serving at its own price'],
  ['personal_chef', 'Personal Cheffing', 'A flat rate, plus the groceries at cost'],
  ['supper_club', 'Supper Club', 'Tickets for a plate of everything; with a Hoamsy fee, Hoamsy takes it first'],
];
export const blankOrPercent = (v) => v.trim() === '' || ((toDecimal(v.replace('%', ''))?.gte(0) && toDecimal(v.replace('%', '')).lt(100)) ?? false);
/** Blank (the recipe's own size), or an amount above 0; fractions are fine. */
export const blankOrSize = (v) => v.trim() === '' || (parseAmount(v)?.gt(0) ?? false);

/** Servings in `count` containers of a sauce: whole servings, at least 1. */
function sauceServings(b, count, container) {
  const per = Number(containerOf(b, container)?.servingsPerContainer ?? 1);
  return String(Math.max(1, Math.floor(Number(count) * per)));
}

/** How many containers a sauce's saved servings take. */
export function containersOf(b, x) {
  const per = Number(containerOf(b, x.container)?.servingsPerContainer ?? 1);
  return Math.max(1, Math.ceil(Number(x.servings) / per));
}

/** Scroll the window to `to` in about a quarter-second, easing out (at once when motion is reduced). */
export function quickScroll(to) {
  const from = window.scrollY;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { window.scrollTo(0, to); return; }
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / 260);
    window.scrollTo(0, from + (to - from) * (1 - (1 - k) ** 3));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** An event's saved plan, as the form holds it. */
function formOf(ev) {
  return {
    name: ev.name,
    isTest: ev.isTest,
    date: ev.date,
    guestCount: ev.guestCount == null ? '' : String(ev.guestCount),
    servings: Object.fromEntries(ev.recipes.map((r) => [r.recipeId, String(r.expectedServings)])),
    prices: Object.fromEntries(ev.recipes.map((r) => [r.recipeId, {
      salePrice: optional(r.salePrice),
      dealPrice: optional(r.dealPrice),
      dealQty: r.dealQty == null ? '' : String(r.dealQty),
      servingSize: r.servingSize == null ? '' : toDecimal(r.servingSize).toString(),
    }])),
    actualGuests: optional(ev.actualGuests),
    actualRevenue: optional(ev.actualRevenue),
    actualCost: optional(ev.actualCost),
    notes: ev.notes ?? '',
    vendorFee: optional(ev.vendorFee),
    kind: ev.kind,
    flatPrice: optional(ev.flatPrice),
    hoamsy: ev.hoamsyPercent != null, // the Hoamsy fee box ticked (unticked: no fee)
    hoamsyPercent: ev.hoamsyPercent == null ? '' : toDecimal(ev.hoamsyPercent).toString(),
    sauces: Object.fromEntries(ev.sauces.map((b) => [b.blendId, {
      servings: String(b.servings),
      container: b.container,
      salePrice: optional(b.salePrice),
    }])),
  };
}

/** The plate price or flat rate that sells the food at DEFAULT_MARGIN gross and covers labor and fees at cost, offered under its box. */
export function TargetHint({ s, form, setForm, saved }) {
  const target = saved && s?.kind === form.kind ? s.flat?.suggestedPrice : null;
  if (!target) return null;
  const supper = form.kind === 'supper_club';
  const typed = toDecimal(priceText(form.flatPrice));
  if (typed?.eq(target)) return <>{DEFAULT_MARGIN}% on food</>;
  return (
    <span className="nowrap" title={`The ${supper ? 'plate price' : 'rate'} that sells the food at a ${DEFAULT_MARGIN}% gross margin, as recipe prices are set, and covers labor and the vendor fee at cost${supper && form.hoamsy ? ', after Hoamsy’s cut' : ''}`}>
      {DEFAULT_MARGIN}% on food: {money(target)}{' '}
      <button type="button" className="link-btn" onClick={() => setForm((f) => ({ ...f, flatPrice: target }))}>Use</button>
    </span>
  );
}

/** The plan's bottom line, under the fields that move it; dimmed while a change is still saving. */
function BarFigures({ s, pending }) {
  const loss = toDecimal(s.profit).lt(0);
  const hoamsy = s.flat?.hoamsyPercent != null;
  const ticketsNote = s.kind === 'supper_club' ? `${s.flat.tickets} × ${money(s.flat.flatPrice)}` : null;
  const figures = [
    // Tickets apart from revenue only when Hoamsy's fee comes between them; otherwise they're the revenue.
    hoamsy && ['Tickets', money(s.flat.gross), ticketsNote],
    hoamsy && ['Hoamsy fee', `−${money(s.hoamsyFee)}`, `${s.flat.hoamsyPercent}% off the top`],
    ['Revenue', money(s.revenue), s.kind === 'personal_chef' ? `${money(s.flat.groceries)} groceries` : s.kind === 'supper_club' && !hoamsy ? ticketsNote : null],
    ['Cost', money(s.totalCost), toDecimal(s.labor.cost).gt(0) ? `${money(toDecimal(s.totalCost).minus(s.labor.cost))} food / ${money(s.labor.cost)} labor` : null],
    !toDecimal(s.vendorFee).isZero() && ['Vendor fee', money(s.vendorFee), null],
    ['Profit', money(s.profit), null, loss ? 'loss' : 'profit'],
    ['Gross margin', s.grossMarginPercent == null ? '—' : `${s.grossMarginPercent}%`, 'on food'],
    ['Net margin', s.marginPercent == null ? '—' : `${s.marginPercent}%`, 'after everything', loss ? 'loss' : ''],
  ].filter(Boolean);
  return (
    <dl className={`bar-figures ${pending ? 'pending' : ''}`} aria-live="polite" title={pending ? 'Updating once the change saves' : undefined}>
      {figures.map(([label, value, note, tone]) => (
        <div key={label} className={tone ?? ''}>
          <dt>{label}</dt>
          <dd>{value}</dd>
          {note && <small>{note}</small>}
        </div>
      ))}
    </dl>
  );
}

// Each event gets its own page state, so edits waiting to save can't go out under the next event's id.
export default function EventPlannerPage() {
  const { id } = useParams();
  return <EventPlanner key={id} id={id} />;
}

/**
 * An event's plan as the page edits it: the form, its autosave (one save at a time, each naming the version
 * the last returned), the summary, and the changes a page can make. Shared by every skin's event page.
 */
export function useEventPlan(id) {
  const [form, setForm] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [status, setStatus] = useState('saved'); // saved | pending | saving | invalid | error | conflict
  const [saveError, setSaveError] = useState(null);
  const { data: recipes } = useApi('/recipes');
  const { data: blends } = useApi('/blends');
  const sauces = (blends ?? []).filter((b) => b.kind === 'sauce');
  // The recipes not chosen for the event: hidden when it opens with some chosen, but never
  // while choosing the first ones on a new event.
  const [showAll, setShowAll] = useState(false);
  const summary = useApi(`/events/${id}/summary`);
  const navigate = useNavigate();
  const toast = useToast();
  const lastSaved = useRef(null);

  // The event version this form was edited from; a save names it, and the server refuses one that's out of date.
  const version = useRef(null);
  const saves = useRef({ last: Promise.resolve(), running: 0 });
  const [lastEdit, setLastEdit] = useState(null);
  const [lastOrder, setLastOrder] = useState(null);
  const [changedBy, setChangedBy] = useState(null); // who the save that was refused lost out to
  const latestForm = useRef(form);
  latestForm.current = form;
  const adopt = (ev) => {
    const f = formOf(ev);
    version.current = ev.version;
    lastSaved.current = JSON.stringify(f);
    setForm(f);
    setLastEdit(ev.lastEditedBy);
    setLastOrder(ev.lastOrderBy);
    setChangedBy(null);
    setStatus('saved');
    setSaveError(null);
  };

  useEffect(() => {
    let stale = false;
    api(`/events/${id}`)
      .then((ev) => {
        if (stale) return;
        setShowAll(!ev.recipes.length && !ev.sauces.length);
        adopt(ev);
      })
      .catch((err) => !stale && setLoadError(err.message));
    return () => { stale = true; };
  }, [id]);

  // An order placed on the POS over this page says so as soon as it's in.
  useEffect(() => onDataChanged(() => {
    api(`/events/${id}`).then((ev) => setLastOrder(ev.lastOrderBy), () => {});
  }), [id]);

  // Saved somewhere else: with nothing unsaved here, take the new plan, so this window's copy doesn't go old.
  // With edits on the way, leave it to their save, which the server refuses and the conflict notice explains.
  useWhileVisible(async () => {
    if (!latestForm.current) return;
    const ev = await api(`/events/${id}`).catch(() => null);
    if (ev) setLastOrder(ev.lastOrderBy); // orders come in without the plan changing
    if (!ev || ev.version <= version.current || saves.current.running) return;
    if (JSON.stringify(latestForm.current) !== lastSaved.current) return;
    adopt(ev);
    notifyDataChanged();
    toast('Updated with changes made in another window');
  }, 15000);

  // Autosave shortly after edits stop, then refresh the summary.
  useEffect(() => {
    if (!form) return;
    const snapshot = JSON.stringify(form);
    if (snapshot === lastSaved.current) return;
    const allPrices = [...Object.values(form.prices), ...Object.values(form.sauces).map((x) => ({ ...noPricing(), salePrice: x.salePrice }))];
    const dealIssue = allPrices.map(dealProblem).find(Boolean);
    const problem = !form.name.trim() ? 'Give the event a name' :
      !form.date ? 'Pick a date' :
      form.guestCount !== '' && !isInt(form.guestCount) ? 'Guests must be a whole number' :
      !blankOrPrice(form.vendorFee) ? 'Vendor fee must be an amount' :
      !blankOrPrice(form.flatPrice) ? `${form.kind === 'supper_club' ? 'Plate price' : 'Flat rate'} must be an amount` :
      form.hoamsy && !blankOrPercent(form.hoamsyPercent) ? 'The Hoamsy fee must be a percent from 0 to under 100' :
      Object.values(form.servings).some((s) => !isInt(s)) ? 'Servings must be whole numbers' :
      Object.values(form.sauces).some((x) => x.count !== undefined && !isCount(x.count)) ? 'Sauce containers must be whole numbers, 1 or more' :
      Object.values(form.sauces).some((x) => !isCount(x.servings)) ? 'Sauce servings must be whole numbers, 1 or more' :
      allPrices.some((p) => !blankOrSize(p.servingSize)) ? 'Size per serving must be an amount above 0' :
      allPrices.some((p) => !blankOrPrice(p.salePrice)) ? 'Sale prices must be amounts' :
      dealIssue ? dealIssue :
      !blankOrInt(form.actualGuests) ? 'Actual guests must be a whole number' :
      !blankOrPrice(form.actualRevenue) ? 'Actual revenue must be an amount' :
      !blankOrPrice(form.actualCost) ? 'Actual spend must be an amount' : null;
    if (problem) {
      setStatus('invalid');
      setSaveError(problem);
      return;
    }
    setStatus('pending');
    setSaveError(null);
    const t = setTimeout(async () => {
      setStatus('saving');
      saves.current.running += 1;
      // One at a time: each save names the version the one before it returned.
      const save = saves.current.last.catch(() => {}).then(() => api(`/events/${id}`, {
          method: 'PUT',
          body: {
            version: version.current,
            name: form.name,
            date: form.date,
            guestCount: form.guestCount,
            vendorFee: priceText(form.vendorFee),
            kind: form.kind,
            flatPrice: priceText(form.flatPrice),
            // Ticked with the box left blank: the usual fee. Unticked: none.
            hoamsyPercent: form.hoamsy ? form.hoamsyPercent.replace('%', '').trim() || String(HOAMSY_FEE_PERCENT) : '',
            recipes: Object.entries(form.servings).map(([recipeId, expectedServings]) => {
              const p = form.prices[recipeId] ?? noPricing();
              return { recipeId, expectedServings, salePrice: priceText(p.salePrice), dealPrice: priceText(p.dealPrice), dealQty: p.dealQty.trim(), servingSize: p.servingSize.trim() && parseAmount(p.servingSize).toString() };
            }),
            sauces: Object.entries(form.sauces).map(([blendId, x]) => ({
              blendId, servings: x.servings.trim(), container: x.container, salePrice: priceText(x.salePrice),
            })),
            actualGuests: form.actualGuests,
            actualRevenue: priceText(form.actualRevenue),
            actualCost: priceText(form.actualCost),
            notes: form.notes,
          },
      }));
      saves.current.last = save;
      try {
        const saved = await save;
        version.current = saved.version;
        setLastEdit(saved.lastEditedBy);
        setLastOrder(saved.lastOrderBy);
        lastSaved.current = snapshot;
        setStatus('saved');
        notifyDataChanged();
      } catch (err) {
        setStatus(err.status === 409 ? 'conflict' : 'error');
        setSaveError(err.message);
        if (err.status === 409) api(`/events/${id}`).then((ev) => setChangedBy(ev.lastEditedBy), () => {}); // the notice reads fine without it
      } finally {
        saves.current.running -= 1;
      }
    }, 600);
    return () => clearTimeout(t);
  }, [form, id]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (r) => setForm((f) => {
    const servings = { ...f.servings };
    const prices = { ...f.prices };
    if (r.id in servings) {
      delete servings[r.id];
      delete prices[r.id];
    } else {
      servings[r.id] = String(r.baseServings);
      prices[r.id] = noPricing();
    }
    return { ...f, servings, prices };
  });
  const toggleSauce = (b) => setForm((f) => {
    const sauces = { ...f.sauces };
    if (b.id in sauces) delete sauces[b.id];
    else sauces[b.id] = { count: '1', container: b.container, servings: sauceServings(b, '1', b.container), salePrice: '' };
    return { ...f, sauces };
  });
  // A sauce's servings follow from what's made: containers × the servings one container holds.
  const setSauceMake = (b, patch) => setForm((f) => {
    const x = { ...f.sauces[b.id], ...patch };
    const count = x.count ?? containersOf(b, f.sauces[b.id]);
    return { ...f, sauces: { ...f.sauces, [b.id]: { ...x, count, servings: isCount(count) ? sauceServings(b, count, x.container) : x.servings } } };
  });
  const setSauce = (bid, patch) => setForm((f) => ({ ...f, sauces: { ...f.sauces, [bid]: { ...f.sauces[bid], ...patch } } }));
  const setServings = (rid, v) => setForm((f) => ({ ...f, servings: { ...f.servings, [rid]: v } }));
  const setPrice = (rid, patch) => setForm((f) => ({ ...f, prices: { ...f.prices, [rid]: { ...(f.prices[rid] ?? noPricing()), ...patch } } }));
  const applyGuests = () => setForm((f) => ({ ...f, servings: Object.fromEntries(Object.keys(f.servings).map((k) => [k, f.guestCount])) }));

  // Make an event's price the recipe's or sauce's own, for every event that doesn't set one.
  const saveOwnPrice = async (path, body, name, price) => {
    await api(path, { method: 'PUT', body });
    notifyDataChanged();
    toast(`${name} now sells for ${money(price)}`);
  };

  const loadLatest = async () => {
    try {
      adopt(await api(`/events/${id}`));
      notifyDataChanged();
    } catch (err) {
      setSaveError(err.message);
    }
  };
  // Save this window's plan over the newer one, by asking for the version it now has.
  const keepMine = async () => {
    try {
      version.current = (await api(`/events/${id}`)).version;
      setForm((f) => ({ ...f }));
    } catch (err) {
      setSaveError(err.message);
    }
  };

  const remove = async () => {
    await api(`/events/${id}`, { method: 'DELETE' });
    notifyDataChanged();
    toast(`Deleted ${form.name}`);
    navigate('/events');
  };

  return {
    form, setForm, loadError, status, saveError, recipes, sauces, summary, showAll, setShowAll, lastEdit, lastOrder, changedBy,
    set, toggle, toggleSauce, setSauceMake, setSauce, setServings, setPrice, applyGuests, saveOwnPrice, loadLatest, keepMine, remove,
  };
}

function EventPlanner({ id }) {
  const {
    form, setForm, loadError, status, saveError, recipes, sauces, summary, showAll, setShowAll, lastEdit, lastOrder, changedBy,
    set, toggle, toggleSauce, setSauceMake, setSauce, setServings, setPrice, applyGuests, saveOwnPrice, loadLatest, keepMine, remove,
  } = useEventPlan(id);
  const [tab, setTab] = useState('financials');
  const tabsRef = useRef(null);
  // The phone's jump menu under the event's details: open a tab and scroll down to it, quickly. (`always: false`: only
  // when the tab bar is above the screen, as when picking a tab from far down a long one.)
  const jumpTo = (t, { always = true } = {}) => {
    const el = tabsRef.current;
    if (el && t !== tab) setHold(el.offsetHeight);
    setTab(t);
    if (!el) return;
    const from = window.scrollY;
    // Land just below the bar that stays stuck to the top: the menu bar on a phone, the search bar on a wider screen.
    const bar = document.querySelector(window.innerWidth <= 800 ? '.sidebar' : '.topbar')?.offsetHeight ?? 0;
    const to = from + el.getBoundingClientRect().top - bar - 8;
    if (!always && to >= from) return;
    quickScroll(to);
  };
  // A tab switch keeps the tab area as tall as it was, so a short or still-loading tab can't shrink the page and
  // pull the scroll position away from the tab bar. The hold shrinks as scrolling up stops needing it, then goes.
  const [hold, setHold] = useState(null);
  useEffect(() => {
    if (hold == null) return;
    const fit = () => {
      const el = tabsRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const below = document.documentElement.scrollHeight - (el.getBoundingClientRect().bottom + window.scrollY);
      const need = Math.ceil(window.innerHeight - top - below);
      const content = (el.lastElementChild?.getBoundingClientRect().bottom ?? top) - top;
      if (need <= content) setHold(null);
      else if (need < hold) setHold(need);
    };
    fit();
    window.addEventListener('scroll', fit, { passive: true });
    window.addEventListener('resize', fit);
    return () => {
      window.removeEventListener('scroll', fit);
      window.removeEventListener('resize', fit);
    };
  }, [hold]);
  const [deleting, setDeleting] = useState(false);
  const [copying, setCopying] = useState(false);
  // ?sales=1 goes straight to the POS screen, so a phone can bookmark it.
  const [params] = useSearchParams();
  const openPos = useOpenPos();
  const posUrl = `/pos?event=${id}`;

  if (params.has('sales')) return <Navigate to={posUrl} replace />;
  if (loadError) return <main className="page"><Notice kind="error">{loadError}</Notice><Link to="/events">Back to events</Link></main>;
  if (!form) return <main className="page"><Spinner /></main>;

  const s = summary.data;
  const selectedCount = Object.keys(form.servings).length;
  // Chosen recipes first; the rest fold away once something is chosen.
  const chosen = (recipes ?? []).filter((r) => r.id in form.servings);
  const unchosen = (recipes ?? []).filter((r) => !(r.id in form.servings));
  const sauceCount = Object.keys(form.sauces).length;
  const chosenSauces = sauces.filter((b) => b.id in form.sauces);
  const unchosenSauces = sauces.filter((b) => !(b.id in form.sauces));
  const anyChosen = selectedCount + sauceCount > 0;
  const folded = anyChosen && !showAll;
  const shownRecipes = folded ? chosen : [...chosen, ...unchosen];
  const shownSauces = folded ? chosenSauces : [...chosenSauces, ...unchosenSauces];
  const hiddenCount = unchosen.length + unchosenSauces.length;
  // What's chosen, whether saved yet or not; the same colors as the POS screen.
  const colors = recipeColors([...Object.keys(form.servings), ...Object.keys(form.sauces).map((bid) => `blend:${bid}`)]);
  // A personal chef job or supper club has no prices per recipe: each takes a share of the rate, from the summary.
  const flat = form.kind !== 'market';
  const supper = form.kind === 'supper_club';
  const tickets = form.hoamsy ? 'ticket money after Hoamsy’s cut' : 'ticket money';
  const summed = new Map([...(s?.recipes ?? []).map((r) => [r.recipeId, r]), ...(s?.sauces ?? []).map((b) => [`blend:${b.blendId}`, b])]);
  const revenueCell = (key, on) => {
    const row = on && summed.get(key);
    return row?.netPrice != null ? <span title={`${row.share}% of the food cost, so ${row.share}% of the ${supper ? tickets : 'rate and groceries'}: ${money(row.revenue)}`}>{money(row.netPrice)}</span> : <span className="muted">—</span>;
  };
  const flatMargin = (key, on) => {
    const row = on && summed.get(key);
    return row?.marginPerServing != null ? <MarginCell pricing={row} /> : <span className="muted">—</span>;
  };
  const columns = flat ? 7 : 8;
  // On a phone, a flat-rate event's chosen row ends with one line of what it comes to (it has no price
  // or discount boxes): cost, revenue and margin per serving. Hidden on wider screens, which have columns.
  const figs = (cost, revenue, margin) => (
    <td className="c-figs">
      <span><i>Cost</i> {cost}</span>
      <span><i>Revenue</i> {revenue}</span>
      <span><i>Margin</i> {margin}</span>
    </td>
  );
  const statusText = { saved: 'All changes saved', pending: 'Unsaved changes', saving: 'Saving…', invalid: saveError, error: saveError, conflict: 'Not saved' }[status];

  return (
    <main className="page">
      <div className="page-head event-head">
        <div>
          <Link to="/events" className="muted">Events</Link>
          <h1>{form.name || 'Untitled event'}<TestBadge item={form} /></h1>
          <span className="save-state" role="status" style={status === 'invalid' || status === 'error' || status === 'conflict' ? { color: 'var(--tomato)' } : undefined}>
            {status === 'saving' && <Spinner />}{statusText}
          </span>
        </div>
        <div className="form-actions">
          <button className="btn primary" onClick={openPos(posUrl)} disabled={!anyChosen} title={anyChosen ? 'Take orders on the POS screen' : 'Add recipes first'}>
            <Icon.cart /> Record sales
          </button>
        </div>
      </div>

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

      <section className="panel event-bar">
        <div className="event-bar-fields">
          <div className="event-bar-rows">
          <div className="event-bar-row">
          <Field label="Event name" className="f-name"><input className="input" value={form.name} onChange={set('name')} /></Field>
          <Field label="Date" className="f-date"><input className="input" type="date" value={form.date} onChange={set('date')} /></Field>
          <Field label="Event type" className="f-type">
            <select className="select" value={form.kind} onChange={set('kind')} title={EVENT_TYPES.find(([k]) => k === form.kind)?.[2]}>
              {EVENT_TYPES.map(([k, label, hint]) => <option key={k} value={k} title={hint}>{label}</option>)}
            </select>
          </Field>
          </div>
          <div className="event-bar-row">
          <Field label={supper ? 'Tickets' : 'Guests'} className="f-num">
            <input className="input num" inputMode="numeric" value={form.guestCount} onChange={set('guestCount')} aria-invalid={form.guestCount !== '' && !isInt(form.guestCount)} />
          </Field>
          {flat && (
            <Field label={supper ? 'Plate price' : 'Flat rate'} className="f-money" hint={<TargetHint s={s} form={form} setForm={setForm} saved={status === 'saved'} />}>
              <span className="money-input vendor-fee">
                <span aria-hidden="true">$</span>
                <input className="input num" inputMode="decimal" value={form.flatPrice} onChange={set('flatPrice')} placeholder="0.00" aria-invalid={!blankOrPrice(form.flatPrice)}
                  title={supper ? 'One ticket: a plate of everything on the menu' : 'For the whole job; the groceries are billed on top, at cost'} />
              </span>
            </Field>
          )}
          <Field label="Vendor fee" className="f-money">
            <span className="money-input vendor-fee">
              <span aria-hidden="true">$</span>
              <input className="input num" inputMode="decimal" value={form.vendorFee} onChange={set('vendorFee')} placeholder="0.00" aria-invalid={!blankOrPrice(form.vendorFee)} />
            </span>
          </Field>
          {supper && (
            // Optional: ticked, Hoamsy takes this percent off every ticket before anything else.
            <div className={`field f-hoamsy ${form.hoamsy ? '' : 'off'}`}>
              <label className="hoamsy-check">
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
          </div>
        </div>
        {s && (s.recipes.length > 0 || s.sauces.length > 0) && <BarFigures s={s} pending={status !== 'saved'} />}
      </section>

      <nav className="jump-menu show-sm" aria-label="Jump to">
        {[['financials', 'Financials'], ['shopping', 'Shopping'], ['sales', 'Sales'], ['results', 'Results']].map(([t, label]) => (
          <button key={t} type="button" className="btn small" onClick={() => jumpTo(t)}>{label}</button>
        ))}
      </nav>

      <section className="panel">
        <div className="panel-head">
          <h2>Recipes <span className="muted" style={{ fontWeight: 500 }}>({selectedCount} selected{sauceCount ? `, ${sauceCount} sauce${sauceCount === 1 ? '' : 's'}` : ''})</span></h2>
          <button className="btn small hide-sm" disabled={!isInt(form.guestCount) || !selectedCount} onClick={applyGuests}>
            Set all servings to {isInt(form.guestCount) ? form.guestCount : supper ? 'tickets' : 'guest count'}
          </button>
        </div>
        {recipes && !recipes.length ? (
          <div className="empty"><p>There are no recipes yet.</p><Link className="btn" to="/recipes/new">Create a recipe</Link></div>
        ) : (
          <div className="table-wrap">
            <table className={`grid recipe-pick cards-sm ${flat ? 'flat' : ''}`}>
              <thead>
                <tr>
                  <th style={{ width: 40 }}><span className="visually-hidden">Include</span></th>
                  <th>Recipe</th>
                  <th title="What one serving is at this event, like 3 tacos. Blank: the recipe’s own size. Cost and price follow it.">Size / serving</th>
                  <th className="num">Cost / serving</th>
                  {flat ? (
                    <th className="num" title={`Each item’s revenue per serving: its share of the ${supper ? tickets : 'rate and groceries'}, by its share of the food cost. Updates once the plan saves.`}>Revenue / serving</th>
                  ) : (
                    <>
                      <th className="num" title="Per serving at this event. Starts at the recipe’s target price; change it here for this event only.">Sale price</th>
                      <th title="Optional deal, like 3 for $15. Ticking it fills in the last one entered for the recipe">Discount</th>
                    </>
                  )}
                  <th className="num" title={flat ? `Its revenue less its food, per serving: labor and the vendor fee are paid back at cost first, so this is a margin on food` : 'Sale price minus any discount, minus the cost per serving'}>Margin / serving</th>
                  <th className="num">Servings for this event</th>
                </tr>
              </thead>
              <tbody>
                {shownRecipes.map((r) => {
                  const on = r.id in form.servings;
                  const p = form.prices[r.id] ?? noPricing();
                  const served = eventServing(r, on ? parseAmount(p.servingSize) : null);
                  const showTotal = on && served.servingLabel && isInt(form.servings[r.id]);
                  return (
                    <tr key={r.id} className={on ? '' : 'off'} style={on ? { '--tile': colors.get(r.id) } : undefined}>
                      <td className="c-check"><input type="checkbox" checked={on} onChange={() => toggle(r)} aria-label={`Include ${r.name}`} style={{ width: 18, height: 18, accentColor: 'var(--basil)' }} /></td>
                      <td className="c-name"><Link to={`/recipes/${r.id}`} style={{ color: 'inherit', fontWeight: 600 }}>{r.name}</Link></td>
                      <td className="c-size" data-label="Size / serving">
                        {on ? (
                          <span className="serving-size">
                            <input className="input num" inputMode="decimal" value={p.servingSize} placeholder={qty(served.recipeSize, 2)} aria-label={`Size per serving of ${r.name}, in ${served.unit}`}
                              aria-invalid={!blankOrSize(p.servingSize)} onChange={(e) => setPrice(r.id, { servingSize: e.target.value })} />
                            <span className="muted">{served.unit}</span>
                          </span>
                        ) : amountLabel(served.recipeSize, served.unit)}
                      </td>
                      <td className="num c-cost" data-label="Cost">{money(served.costPerServing)}</td>
                      {flat ? <td className="num c-price" data-label="Revenue / serving">{revenueCell(r.id, on)}</td> : (
                        <>
                          <td className="num c-price" data-label="Price">
                            {on
                              ? <SalePriceInput value={p.salePrice} recipePrice={served.recommendedPrice} label={`Sale price per serving of ${r.name}`} onChange={(v) => setPrice(r.id, { salePrice: v })}
                                  onSetRecipePrice={toDecimal(served.ratio).eq(1) ? (price) => saveOwnPrice(`/recipes/${r.id}/price`, { targetPrice: price }, r.name, price) : undefined} />
                              : money(served.recommendedPrice)}
                          </td>
                          <td className="c-deal" data-label="Discount">
                            {on
                              ? <DealToggle qty={p.dealQty} price={p.dealPrice} saved={r} label={r.name} note={dealNote(p, pricingFor(served, p))} onChange={(patch) => setPrice(r.id, patch)} />
                              : '—'}
                          </td>
                        </>
                      )}
                      <td className="num nowrap c-margin" data-label="Margin">{flat ? flatMargin(r.id, on) : <MarginCell pricing={pricingFor(served, on ? p : undefined)} />}</td>
                      <td className="num c-serv" data-label="Servings">
                        {on ? (
                          <input className="input num" style={{ width: 76 }} inputMode="numeric" value={form.servings[r.id]}
                            aria-label={`Servings of ${r.name}`} aria-invalid={!isInt(form.servings[r.id])} onChange={(e) => setServings(r.id, e.target.value)} />
                        ) : '—'}
                        {showTotal && <div><b className="serving-total">{amountLabel(toDecimal(form.servings[r.id]).times(parseAmount(p.servingSize)), served.unit)} in all</b></div>}
                      </td>
                      {on && flat && figs(money(served.costPerServing), revenueCell(r.id, on), flatMargin(r.id, on))}
                    </tr>
                  );
                })}
                {shownSauces.length > 0 && (
                  <tr className="group-row"><td colSpan={columns}>Sauces <span className="muted">· {flat ? 'made in whole containers' : 'sold by the serving, made in whole containers'}</span></td></tr>
                )}
                {shownSauces.map((b) => {
                  const on = b.id in form.sauces;
                  const x = form.sauces[b.id] ?? { container: b.container, servings: '', salePrice: '' };
                  const c = containerOf(b, x.container);
                  const costed = c && { costPerServing: c.costPerServing ?? '0', recommendedPrice: c.recommendedPrice };
                  const count = x.count ?? (on ? String(containersOf(b, x)) : '');
                  return (
                    <tr key={b.id} className={`sauce-row ${on ? '' : 'off'}`} style={on ? { '--tile': colors.get(`blend:${b.id}`) } : undefined}>
                      <td className="c-check"><input type="checkbox" checked={on} onChange={() => toggleSauce(b)} aria-label={`Include ${b.name}`} style={{ width: 18, height: 18, accentColor: 'var(--basil)' }} /></td>
                      <td className="c-name"><Link to={`/spice-lab/${b.id}`} style={{ color: 'inherit', fontWeight: 600 }}>{b.name}</Link> <span className="badge">Sauce</span></td>
                      <td className="muted c-size c-none">{c ? `${qty(c.servingOz, 2)} oz` : '—'}</td>
                      <td className="num c-cost" data-label="Cost">{c?.costPerServing ? money(c.costPerServing) : '—'}</td>
                      {flat ? <td className="num c-price" data-label="Revenue / serving">{revenueCell(`blend:${b.id}`, on)}</td> : (
                        <>
                          <td className="num c-price" data-label="Price">
                            {on
                              ? <SalePriceInput value={x.salePrice} recipePrice={c?.recommendedPrice} label={`Sale price per serving of ${b.name}`} onChange={(v) => setSauce(b.id, { salePrice: v })}
                                  onSetRecipePrice={(price) => saveOwnPrice(`/blends/${b.id}/price`, { salePrice: price }, b.name, price)} />
                              : c?.recommendedPrice ? money(c.recommendedPrice) : '—'}
                          </td>
                          <td className="muted c-deal c-none">—</td>
                        </>
                      )}
                      <td className="num nowrap c-margin" data-label="Margin">{flat ? flatMargin(`blend:${b.id}`, on) : <MarginCell pricing={costed ? pricingFor(costed, on ? { salePrice: x.salePrice } : undefined) : null} />}</td>
                      <td className="num c-serv" data-label="Containers">
                        {on ? (
                          <>
                            <span className="sauce-make">
                              <input className="input num" inputMode="numeric" value={count} aria-label={`Containers of ${b.name}`} aria-invalid={!isCount(count)}
                                onChange={(e) => setSauceMake(b, { count: e.target.value })} />
                              <span aria-hidden="true">×</span>
                              <select className="select" value={x.container} aria-label={`Container for ${b.name}`} onChange={(e) => setSauceMake(b, { container: e.target.value, count })}>
                                {Object.keys(SAUCE_CONTAINERS).map((k) => <option key={k} value={k}>{k}</option>)}
                              </select>
                            </span>
                            <div><b className="sauce-servings" title="Containers × the servings one holds">{x.servings} servings</b></div>
                          </>
                        ) : b.container}
                        {c && <div className="sauce-holds"><small className="muted"><span>{c.containerOz} oz,</span> <span>{qty(c.servingsPerContainer, 1)} servings each</span></small></div>}
                      </td>
                      {on && flat && figs(c?.costPerServing ? money(c.costPerServing) : '—', revenueCell(`blend:${b.id}`, on), flatMargin(`blend:${b.id}`, on))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {anyChosen && hiddenCount > 0 && (
              <button type="button" className="fold-bar" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                {showAll ? <Icon.up /> : <Icon.down />}
                {showAll ? `Hide the ${hiddenCount} not in this event` : `Show ${hiddenCount} more not in this event`}
              </button>
            )}
          </div>
        )}
      </section>

      <section ref={tabsRef} className="event-tabs-area" style={hold == null ? undefined : { minHeight: hold }}>
        <Tabs className="segmented-sm" value={tab} onChange={(t) => jumpTo(t, { always: false })} tabs={[
          { value: 'financials', label: 'Financials' },
          { value: 'shopping', label: 'Shopping list', short: 'Shopping' },
          { value: 'sales', label: 'Sales' },
          { value: 'results', label: 'After the event', short: 'Results' },
        ]} />
        {summary.error && <Notice kind="error">{summary.error.message}</Notice>}
        {!s ? <Spinner /> : !s.recipes.length && !s.sauces.length ? (
          <div className="panel empty"><p>Select recipes or sauces above to project costs and build the shopping list.</p></div>
        ) : tab === 'financials' ? <Financials s={s} eventId={id} />
          : tab === 'sales' ? <SalesTable eventId={id} onRecord={openPos(posUrl)} />
          : tab === 'results' ? <Results s={s} form={form} set={set} setForm={setForm} eventId={id} />
          : <ShoppingList s={s} eventId={id} title={form.name || 'Untitled event'} date={form.date} guests={form.guestCount} />}
        {s?.warnings.length > 0 && <Notice>{s.warnings.map((w) => <div key={w}>{w}</div>)}</Notice>}
      </section>

      <div className="page-foot">
        <button className="btn small" onClick={() => quickScroll(0)}><Icon.up /> Back to top</button>
        <span className="form-actions">
          <button className="btn small" onClick={() => setCopying(true)} disabled={status === 'pending' || status === 'saving'}
            title={status === 'saved' ? 'A copy of this plan under a new name and date' : 'Wait for the changes to save'}><Icon.copy /> Duplicate</button>
          <button className="btn small danger" onClick={() => setDeleting(true)}><Icon.trash /> Delete event</button>
        </span>
      </div>
      {((status === 'saved' && lastEdit) || lastOrder) && (
        <p className="last-edits">
          {status === 'saved' && lastEdit && <span>Last edited by {lastEdit.actor}, {dateTime(lastEdit.at)}</span>}
          {lastOrder && <span>Last order entered by {lastOrder.actor}, {dateTime(lastOrder.at)}</span>}
        </p>
      )}
      {copying && <DuplicateEventModal event={{ id, name: form.name || 'Untitled event', date: form.date }} onClose={() => setCopying(false)} />}

      {deleting && (
        <Modal title={`Delete ${form.name}?`} onClose={() => setDeleting(false)}>
          <p>The event, its recipe selections and any sales recorded for it will be removed. The recipes themselves are kept.</p>
          <div className="form-actions">
            <button className="btn ghost" onClick={() => setDeleting(false)}>Keep it</button>
            <button className="btn danger" onClick={remove}>Delete event</button>
          </div>
        </Modal>
      )}
    </main>
  );
}
