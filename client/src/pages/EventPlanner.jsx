import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, notifyDataChanged } from '../api.js';
import { useApi } from '../hooks.js';
import { SAUCE_CONTAINERS, sauceContainer } from '@kitchen/shared';
import { money, qty } from '../format.js';
import { Field, Icon, Modal, Notice, Spinner, Tabs, TestBadge, useToast } from '../components/ui.jsx';
import SalesModal, { SalesTable } from '../components/SalesModal.jsx';
import { DealInput, MarginCell, SalePriceInput, blankOrCount, blankOrPrice, isInt, priceText, pricingFor } from '../components/EventPricing.jsx';
import { Financials, Results, ShoppingList } from '../components/EventTabs.jsx';
import { DuplicateEventModal } from './EventsPage.jsx';

const optional = (v) => (v == null ? '' : String(v));
const blankOrInt = (v) => v.trim() === '' || isInt(v);
const isCount = (v) => isInt(v) && Number(v) > 0;
/** A sauce's container cost and default price, or null while it can't be worked out. */
const containerOf = (b, container) => { try { return sauceContainer(b, container); } catch { return null; } };
const noPricing = () => ({ salePrice: '', discountAmount: '', discountQty: '' });

/** Servings in `count` containers of a sauce: whole servings, at least 1. */
function sauceServings(b, count, container) {
  const per = Number(containerOf(b, container)?.servingsPerContainer ?? 1);
  return String(Math.max(1, Math.floor(Number(count) * per)));
}

/** How many containers a sauce's saved servings take. */
function containersOf(b, x) {
  const per = Number(containerOf(b, x.container)?.servingsPerContainer ?? 1);
  return Math.max(1, Math.ceil(Number(x.servings) / per));
}

/** Scroll the window to `to` in about a quarter-second, easing out (at once when motion is reduced). */
function quickScroll(to) {
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

export default function EventPlanner() {
  const { id } = useParams();
  const [form, setForm] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [status, setStatus] = useState('saved'); // saved | pending | saving | invalid | error
  const [saveError, setSaveError] = useState(null);
  const [tab, setTab] = useState('financials');
  const tabsRef = useRef(null);
  // The phone's jump menu under the event's details: open a tab and scroll down to it, quickly. (`always: false`: only
  // when the tab bar is above the screen, as when picking a tab from far down a long one.)
  const jumpTo = (t, { always = true } = {}) => {
    setTab(t);
    const el = tabsRef.current;
    if (!el) return;
    const from = window.scrollY;
    // Land just below the bar that stays stuck to the top: the menu bar on a phone, the search bar on a wider screen.
    const bar = document.querySelector(window.innerWidth <= 800 ? '.sidebar' : '.topbar')?.offsetHeight ?? 0;
    const to = from + el.getBoundingClientRect().top - bar - 8;
    if (!always && to >= from) return;
    quickScroll(to);
  };
  const [deleting, setDeleting] = useState(false);
  const [copying, setCopying] = useState(false);
  const { data: recipes } = useApi('/recipes');
  const { data: blends } = useApi('/blends');
  const sauces = (blends ?? []).filter((b) => b.kind === 'sauce');
  // The recipes not chosen for the event: hidden when it opens with some chosen, but never
  // while choosing the first ones on a new event.
  const [showAll, setShowAll] = useState(false);
  const summary = useApi(`/events/${id}/summary`);
  // ?sales=1 opens the sales counter, so a phone can bookmark it.
  const [params, setParams] = useSearchParams();
  const selling = params.has('sales');
  const setSelling = (on) => setParams(on ? { sales: '1' } : {}, { replace: !on });
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
          isTest: ev.isTest,
          date: ev.date,
          guestCount: ev.guestCount == null ? '' : String(ev.guestCount),
          servings: Object.fromEntries(ev.recipes.map((r) => [r.recipeId, String(r.expectedServings)])),
          prices: Object.fromEntries(ev.recipes.map((r) => [r.recipeId, {
            salePrice: optional(r.salePrice),
            discountAmount: optional(r.discountAmount),
            discountQty: r.discountQty == null ? '' : String(r.discountQty),
          }])),
          actualGuests: optional(ev.actualGuests),
          actualRevenue: optional(ev.actualRevenue),
          actualCost: optional(ev.actualCost),
          notes: ev.notes ?? '',
          vendorFee: optional(ev.vendorFee),
          sauces: Object.fromEntries(ev.sauces.map((b) => [b.blendId, {
            servings: String(b.servings),
            container: b.container,
            salePrice: optional(b.salePrice),
          }])),
        };
        setShowAll(!ev.recipes.length && !ev.sauces.length);
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
    const allPrices = [...Object.values(form.prices), ...Object.values(form.sauces).map((x) => ({ ...noPricing(), salePrice: x.salePrice }))];
    const problem = !form.name.trim() ? 'Give the event a name' :
      !form.date ? 'Pick a date' :
      form.guestCount !== '' && !isInt(form.guestCount) ? 'Guests must be a whole number' :
      !blankOrPrice(form.vendorFee) ? 'Vendor fee must be an amount' :
      Object.values(form.servings).some((s) => !isInt(s)) ? 'Servings must be whole numbers' :
      Object.values(form.sauces).some((x) => x.count !== undefined && !isCount(x.count)) ? 'Sauce containers must be whole numbers, 1 or more' :
      Object.values(form.sauces).some((x) => !isCount(x.servings)) ? 'Sauce servings must be whole numbers, 1 or more' :
      allPrices.some((p) => !blankOrPrice(p.salePrice)) ? 'Sale prices must be amounts' :
      allPrices.some((p) => !blankOrPrice(p.discountAmount)) ? 'Discounts must be amounts' :
      allPrices.some((p) => !blankOrCount(p.discountQty)) ? 'A discount applies per 1 or more servings' :
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
      try {
        await api(`/events/${id}`, {
          method: 'PUT',
          body: {
            name: form.name,
            date: form.date,
            guestCount: form.guestCount,
            vendorFee: priceText(form.vendorFee),
            recipes: Object.entries(form.servings).map(([recipeId, expectedServings]) => {
              const p = form.prices[recipeId] ?? noPricing();
              return { recipeId, expectedServings, salePrice: priceText(p.salePrice), discountAmount: priceText(p.discountAmount), discountQty: p.discountQty.trim() };
            }),
            sauces: Object.entries(form.sauces).map(([blendId, x]) => ({
              blendId, servings: x.servings.trim(), container: x.container, salePrice: priceText(x.salePrice),
            })),
            actualGuests: form.actualGuests,
            actualRevenue: priceText(form.actualRevenue),
            actualCost: priceText(form.actualCost),
            notes: form.notes,
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
    const prices = { ...f.prices };
    if (r.id in servings) {
      delete servings[r.id];
      delete prices[r.id];
    } else {
      servings[r.id] = isInt(f.guestCount) ? f.guestCount : String(r.baseServings);
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

  const remove = async () => {
    await api(`/events/${id}`, { method: 'DELETE' });
    notifyDataChanged();
    toast(`Deleted ${form.name}`);
    navigate('/events');
  };

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
  // What Record sales offers: the recipes, then the sauces sold by the container.
  const menu = s ? [
    ...s.recipes.map((r) => ({ ...r, key: r.recipeId })),
    ...s.sauces.map((b) => ({ ...b, key: `blend:${b.blendId}` })),
  ] : [];
  const statusText = { saved: 'All changes saved', pending: 'Unsaved changes', saving: 'Saving…', invalid: saveError, error: saveError }[status];

  return (
    <main className="page">
      <div className="page-head event-head">
        <div>
          <Link to="/events" className="muted">Events</Link>
          <h1>{form.name || 'Untitled event'}<TestBadge item={form} /></h1>
          <span className="save-state" role="status" style={status === 'invalid' || status === 'error' ? { color: 'var(--tomato)' } : undefined}>
            {status === 'saving' && <Spinner />}{statusText}
          </span>
        </div>
        <button className="btn primary" onClick={() => setSelling(true)} disabled={!anyChosen} title={anyChosen ? 'Count servings sold and given away during the event' : 'Add recipes first'}>
          <Icon.cart /> Record sales
        </button>
      </div>
      {selling && (
        s ? <SalesModal eventId={id} eventName={form.name || 'Untitled event'} items={menu} onClose={() => setSelling(false)} /> : <Spinner />
      )}

      <section className="panel panel-pad">
        <div className="form-grid">
          <Field label="Event name" className="span-2"><input className="input" value={form.name} onChange={set('name')} /></Field>
          <Field label="Date"><input className="input" type="date" value={form.date} onChange={set('date')} /></Field>
          <Field label="Guests"><input className="input num" inputMode="numeric" value={form.guestCount} onChange={set('guestCount')} /></Field>
          <Field label="Vendor fee">
            <span className="money-input vendor-fee">
              <span aria-hidden="true">$</span>
              <input className="input num" inputMode="decimal" value={form.vendorFee} onChange={set('vendorFee')} placeholder="0.00" aria-invalid={!blankOrPrice(form.vendorFee)} />
            </span>
          </Field>
        </div>
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
            Set all servings to {isInt(form.guestCount) ? form.guestCount : 'guest count'}
          </button>
        </div>
        {recipes && !recipes.length ? (
          <div className="empty"><p>There are no recipes yet.</p><Link className="btn" to="/recipes/new">Create a recipe</Link></div>
        ) : (
          <div className="table-wrap">
            <table className="grid recipe-pick cards-sm">
              <thead>
                <tr>
                  <th style={{ width: 40 }}><span className="visually-hidden">Include</span></th>
                  <th>Recipe</th>
                  <th className="num">Makes</th>
                  <th className="num">Cost / serving</th>
                  <th className="num" title="Per serving at this event. Starts at the recipe’s target price; change it here for this event only.">Sale price</th>
                  <th title="Optional deal, e.g. buy 2, get $1 off: $1.00 off per 2 servings">Discount</th>
                  <th className="num" title="Sale price minus any discount, minus the cost per serving">Margin / serving</th>
                  <th className="num">Servings for this event</th>
                </tr>
              </thead>
              <tbody>
                {shownRecipes.map((r) => {
                  const on = r.id in form.servings;
                  const p = form.prices[r.id] ?? noPricing();
                  return (
                    <tr key={r.id} className={on ? '' : 'off'}>
                      <td className="c-check"><input type="checkbox" checked={on} onChange={() => toggle(r)} aria-label={`Include ${r.name}`} style={{ width: 18, height: 18, accentColor: 'var(--basil)' }} /></td>
                      <td className="c-name"><Link to={`/recipes/${r.id}`} style={{ color: 'inherit', fontWeight: 600 }}>{r.name}</Link></td>
                      <td className="num c-makes" data-label="Makes">{r.baseServings}</td>
                      <td className="num c-cost" data-label="Cost">{money(r.costPerServing)}</td>
                      <td className="num c-price" data-label="Price">
                        {on
                          ? <SalePriceInput value={p.salePrice} recipePrice={r.recommendedPrice} label={`Sale price per serving of ${r.name}`} onChange={(v) => setPrice(r.id, { salePrice: v })} />
                          : money(r.recommendedPrice)}
                      </td>
                      <td className="c-deal" data-label="Deal">
                        {on
                          ? <DealInput amount={p.discountAmount} qty={p.discountQty} label={r.name} onChange={(patch) => setPrice(r.id, patch)} />
                          : '—'}
                      </td>
                      <td className="num nowrap c-margin" data-label="Margin"><MarginCell pricing={pricingFor(r, on ? p : undefined)} /></td>
                      <td className="num c-serv" data-label="Servings">
                        {on ? (
                          <input className="input num" style={{ width: 96, marginLeft: 'auto' }} inputMode="numeric" value={form.servings[r.id]}
                            aria-label={`Servings of ${r.name}`} aria-invalid={!isInt(form.servings[r.id])} onChange={(e) => setServings(r.id, e.target.value)} />
                        ) : '—'}
                      </td>
                    </tr>
                  );
                })}
                {shownSauces.length > 0 && (
                  <tr className="group-row"><td colSpan={8}>Sauces <span className="muted">· sold by the serving, made in whole containers</span></td></tr>
                )}
                {shownSauces.map((b) => {
                  const on = b.id in form.sauces;
                  const x = form.sauces[b.id] ?? { container: b.container, servings: '', salePrice: '' };
                  const c = containerOf(b, x.container);
                  const costed = c && { costPerServing: c.costPerServing ?? '0', recommendedPrice: c.recommendedPrice };
                  const count = x.count ?? (on ? String(containersOf(b, x)) : '');
                  return (
                    <tr key={b.id} className={`sauce-row ${on ? '' : 'off'}`}>
                      <td className="c-check"><input type="checkbox" checked={on} onChange={() => toggleSauce(b)} aria-label={`Include ${b.name}`} style={{ width: 18, height: 18, accentColor: 'var(--basil)' }} /></td>
                      <td className="c-name"><Link to={`/spice-lab/${b.id}`} style={{ color: 'inherit', fontWeight: 600 }}>{b.name}</Link> <span className="badge">Sauce</span></td>
                      <td className="num c-makes" data-label="Containers">
                        {on ? (
                          <span className="sauce-make">
                            <input className="input num" inputMode="numeric" value={count} aria-label={`Containers of ${b.name}`} aria-invalid={!isCount(count)}
                              onChange={(e) => setSauceMake(b, { count: e.target.value })} />
                            <span aria-hidden="true">×</span>
                            <select className="select" value={x.container} aria-label={`Container for ${b.name}`} onChange={(e) => setSauceMake(b, { container: e.target.value, count })}>
                              {Object.keys(SAUCE_CONTAINERS).map((k) => <option key={k} value={k}>{k}</option>)}
                            </select>
                          </span>
                        ) : b.container}
                        {c && <div><small className="muted">{c.containerOz} oz, {qty(c.servingsPerContainer, 1)} servings each</small></div>}
                      </td>
                      <td className="num c-cost" data-label="Cost">{c?.costPerServing ? money(c.costPerServing) : '—'}</td>
                      <td className="num c-price" data-label="Price">
                        {on
                          ? <SalePriceInput value={x.salePrice} recipePrice={c?.recommendedPrice} label={`Sale price per serving of ${b.name}`} onChange={(v) => setSauce(b.id, { salePrice: v })} />
                          : c?.recommendedPrice ? money(c.recommendedPrice) : '—'}
                      </td>
                      <td className="muted c-deal c-none">—</td>
                      <td className="num nowrap c-margin" data-label="Margin"><MarginCell pricing={costed ? pricingFor(costed, on ? { salePrice: x.salePrice } : undefined) : null} /></td>
                      <td className="num c-serv" data-label="Servings">
                        {on ? (
                          <>
                            <b className="sauce-servings" title="Containers × the servings one holds">{x.servings}</b>
                            <div><small className="muted nowrap">from {count || '?'} × {x.container}</small></div>
                          </>
                        ) : '—'}
                      </td>
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

      <section ref={tabsRef} className="event-tabs-area">
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
          : tab === 'sales' ? <SalesTable eventId={id} onRecord={() => setSelling(true)} />
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
