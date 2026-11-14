// A spice blend or a sauce, laid out like a recipe: what it makes as a sentence, what goes in as
// lines that read amount first with each one's share of the weight as a bar in its pie color, and
// a label beside them with the pie, the cost and the scaling. The form, breakdown and saving are
// the default editor's (useBlendEditor), so both pages save the same way.
import { BLEND_UNITS, BLEND_UOM, SAUCE_CONTAINERS, SAUCE_UNITS, SAUCE_UOM, normalizeUnit, parseAmount, unitsForName } from '@kitchen/shared';
import { Link } from 'react-router';
import { date, money, pack, perUnit, qty, toDecimal, unitMoney } from '../../format.js';
import { blankOrPrice } from '../../components/EventPricing.jsx';
import IngredientCombobox from '../../components/IngredientCombobox.jsx';
import { Icon, LeaveModal, Modal, Notice, SaveButton, Spinner, TestBadge } from '../../components/ui.jsx';
import { IngredientDrawer } from '../../components/IngredientDrawer.jsx';
import { BlendPie, QT_STEP, amountProblem, colorAt, servingProblem, useBlendEditor, wholeNumber } from '../../pages/SpiceLabPage.jsx';
import { Stepper } from './EventMenu.jsx';
import { Tape, count } from './parts.jsx';

export default function BlendPage({ kind = 'spice' }) {
  const editor = useBlendEditor(kind);
  if (editor.loadError) return <main className="page alt-page"><Notice kind="error">{editor.loadError}</Notice><Link to="/spice-lab">Back to the Spice Lab</Link></main>;
  if (!editor.form) return <main className="page alt-page"><Spinner /></main>;
  const {
    id, form, setForm, saveError, saving, search, setSearch, deleting, setDeleting, viewing, setViewing, rowProps, handleProps,
    needed, setNeeded, setMakeQt, savedKind, asBlend, setAsBlend, dirty, blocker, breakdown, closeIngredient, setContainer,
    setItem, removeItem, addItem, sauce, noun, thing, addIngredient, problems, base, qtText, quarts, quartsOk, scale, scaled,
    qtSliderMax, qtSlider, save, remove, costed, grams, tsp, batch, servingOz, perContainer, servingCost, marginPrice, ownPrice,
  } = editor;
  const margin = ownPrice && servingCost && ownPrice.gt(0) ? ownPrice.minus(servingCost).div(ownPrice).times(100).toFixed(1) : null;
  const scaledFor = sauce ? `${qty(quarts ?? 0)} qt` : `${wholeNumber(needed) ? needed : base} serving${(wholeNumber(needed) ? Number(needed) : base) === 1 ? '' : 's'}`;

  return (
    <main className="page alt-page recipe blend">
      <header className="rc-head">
        <div className="rc-title">
          <input className="desk-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label={sauce ? 'Sauce name' : 'Blend name'}
            placeholder={id ? `Untitled ${thing}` : sauce ? 'Name the sauce' : 'Name the spice blend'} />
          <TestBadge item={form} />
          <span className="badge">{sauce ? 'Sauce' : 'Spice blend'}</span>
          {id && savedKind === 'spice' && (sauce
            ? <button className="btn" onClick={() => { setMakeQt(null); setForm((f) => ({ ...asBlend, name: f.name, notes: f.notes, items: f.items })); }}>Keep it a spice blend</button>
            : <button className="btn" title="Sell it by the container on events, as a sauce. Saving makes it one; a sauce can’t go back to a blend."
              onClick={() => { setMakeQt(null); setAsBlend(form); setForm((f) => ({ ...f, kind: 'sauce', container: '1 qt', servingOz: '1', salePrice: '' })); }}>Make it a sauce</button>)}
          <SaveButton dirty={dirty} saving={saving} disabled={!dirty || saving || problems} onClick={save} isNew={!id} createLabel={`Create ${thing}`} />
        </div>
        {sauce ? (
          <p className="rc-makes">
            <span>Fills a</span>
            <select className="select unit" value={form.container} onChange={(e) => setContainer(e.target.value)} aria-label="Container the amounts make" title="The amounts below make one; changing it scales them">
              {Object.entries(SAUCE_CONTAINERS).map(([c, oz]) => <option key={c} value={c}>{c} ({oz} oz)</option>)}
            </select>
            <span>container, served</span>
            <input className="input num" inputMode="decimal" value={form.servingOz} aria-label="Serving size, in oz" aria-invalid={servingProblem(form)} onChange={(e) => setForm({ ...form, servingOz: e.target.value })} />
            <span>{SAUCE_UOM} at a time{perContainer && <>, <b>{qty(perContainer, 1)} servings</b> in all</>}</span>
          </p>
        ) : (
          <p className="rc-makes">
            <span>One batch makes</span>
            <input className="input num" inputMode="numeric" value={form.servings} aria-label="Servings one batch makes" aria-invalid={!wholeNumber(form.servings)} onChange={(e) => setForm({ ...form, servings: e.target.value })} />
            <span>serving{form.servings === '1' ? '' : 's'}{grams.gt(0) && <>, <b>{qty(grams, 0)} g</b>, about {qty(tsp, 1)} tsp</>}</span>
          </p>
        )}
      </header>
      {saveError && <Notice kind="error">{saveError}</Notice>}
      {sauce && savedKind === 'spice' && id && (
        <Notice>Pick the container the amounts fill and the serving size, then save to make this spice blend a sauce. A sauce can’t be turned back into a blend.</Notice>
      )}

      <div className="rc-body">
        <div className="rc-main">
          <section>
            <div className="rc-section-head">
              <Tape>What goes in</Tape>
              <span className="muted">{count(form.items.length, noun)}{form.items.length > 0 && `, ${costed} priced`}</span>
            </div>
            {form.items.length > 0 && (
              <table className={`rc-lines ${scaled ? 'is-scaled' : ''}`}>
                <tbody>
                  {form.items.map((it, i) => {
                    const b = breakdown.items[i];
                    // Offer the linked ingredient's own unit too, so a "box" of garlic can be costed, and cloves of it.
                    const own = it.uom ? normalizeUnit(it.uom) ?? it.uom.trim().toLowerCase() : null;
                    const units = [...new Set([...(sauce ? SAUCE_UNITS : BLEND_UNITS), ...unitsForName(it.name), own, it.unit].filter(Boolean))];
                    const priced = it.ingredientId && toDecimal(it.packPrice) !== null;
                    const label = it.name || `${noun} ${i + 1}`;
                    return (
                      <tr key={it.key} {...rowProps(i)}>
                        <td className="l-grip"><button className="icon-btn drag-handle" aria-label={`Move ${label} (drag, or use arrow keys)`} {...handleProps(i)}><Icon.grip /></button></td>
                        <td className="l-amount">
                          <span className="unit-input unit-pick">
                            <input className="input num" value={it.amount} aria-label={`${label} amount`} aria-invalid={amountProblem(it)} title="Fractions work: 1/2, 1 1/2, ½" onChange={(e) => setItem(it.key, { amount: e.target.value })} />
                            <select className="input" value={it.unit} aria-label={`${label} unit`} onChange={(e) => setItem(it.key, { unit: normalizeUnit(e.target.value) ?? e.target.value })}>
                              {units.map((u) => <option key={u} value={u}>{u}</option>)}
                            </select>
                          </span>
                          {scaled && !amountProblem(it) && <small className="scaled">{qty(parseAmount(it.amount).times(scale), it.unit === BLEND_UOM ? 0 : 3)} {it.unit} scaled</small>}
                        </td>
                        <td className="l-name">
                          {it.ingredientId
                            ? <button type="button" className="line-name" aria-label={`${it.name}: view or edit`} onClick={() => setViewing(it.ingredientId)}>{it.name}</button>
                            : <input className="input" value={it.name} aria-label={`${sauce ? 'Ingredient' : 'Spice'} ${i + 1} name`} title="Not in the pantry, so it has no price" onChange={(e) => setItem(it.key, { name: e.target.value })} />}
                          <small>
                            {!it.ingredientId ? 'Typed in, so it has no price'
                              : priced ? `${perUnit(toDecimal(it.packPrice).div(toDecimal(it.packSize) || 1), it.uom)}, ${pack(it.packSize, it.uom)} for ${unitMoney(it.packPrice)}${it.vendor ? ` at ${it.vendor}` : ''}${it.priceDate ? `, ${date(it.priceDate)}` : ''}`
                              : <span className="badge warn">No purchase price</span>}
                          </small>
                        </td>
                        <td className="l-share">
                          <span className="bar" role="img" aria-label={b?.share ? `${b.share}% of the weight` : 'No weight'} title={b?.grams ? `${qty(b.grams, 0)} g, ${b.share}% of the weight` : undefined}><i style={{ width: `${b?.share ?? 0}%`, background: colorAt(i) }} /></span>
                          <small>{b?.grams ? `${qty(b.grams, 0)} g, ${b.share}%` : ''}{scaled && b?.grams ? <span className="scaled">, {qty(toDecimal(b.grams).times(scale), 0)} g scaled</span> : ''}</small>
                        </td>
                        <td className="l-cost">
                          <b title={!b?.cost && priced ? `${it.unit} can’t be converted to ${it.uom}: set what 1 ${it.uom} weighs in the ingredient’s details` : undefined}>{b?.cost ? money(b.cost) : '—'}</b>
                          {scaled && b?.cost && <small className="scaled">{money(toDecimal(b.cost).times(scale))}</small>}
                        </td>
                        <td className="l-off"><button className="icon-btn" aria-label={`Remove ${label}`} title="Remove" onClick={() => removeItem(it.key)}><Icon.close /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <IngredientCombobox
              ariaLabel={`Add ${sauce ? 'an ingredient' : 'a spice'}`}
              value={search}
              onInput={setSearch}
              onPick={addIngredient}
              exclude={form.items.map((it) => it.ingredientId).filter(Boolean)}
              placeholder={form.items.length ? `Add another ${noun}…` : `Start with ${sauce ? 'an ingredient' : 'a spice'} from the pantry, or type any name…`}
              footer={(q, close) => q.trim() && (
                <div className="option" role="option" aria-selected="false"
                  onMouseDown={(e) => { e.preventDefault(); addItem({ ingredientId: null, name: q.trim() }); close(); }}>
                  <span>Add “{q.trim()}” as {sauce ? 'an ingredient' : 'a spice'} without a price</span>
                </div>
              )}
            />
          </section>

          <section>
            <div className="rc-section-head"><Tape>Notes</Tape></div>
            <textarea className="input" rows={3} value={form.notes} aria-label="Notes" onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder={sauce ? 'Blend, strain, how long it keeps…' : 'Grind, toast, what it goes with…'} />
          </section>

          {id && (
            <div className="desk-foot">
              <span />
              <button className="btn small danger" onClick={() => setDeleting(true)}><Icon.trash /> Delete {thing}</button>
            </div>
          )}
        </div>

        <aside className="price-tag blend-tag" aria-label="Weight, cost and scaling">
          <div className="tag-pie"><BlendPie items={breakdown.items} totalGrams={breakdown.totalGrams} size={170} /></div>
          <h2>{sauce ? `One ${form.container} container` : `One batch`}</h2>
          <dl className="tag-sum">
            <div><dt>Cost</dt><dd>{breakdown.cost ? money(breakdown.cost) : '—'}</dd></div>
          </dl>
          <dl className="tag-rows">
            {sauce
              ? breakdown.cost && batch.gt(0) && <div><dt>Cost per {SAUCE_UOM}</dt><dd>{unitMoney(toDecimal(breakdown.cost).div(batch))}</dd></div>
              : breakdown.cost && breakdown.costPerGram && <div><dt>Cost per g</dt><dd>{unitMoney(breakdown.costPerGram)}</dd></div>}
            {sauce && servingCost && <div><dt>Cost per serving</dt><dd>{money(servingCost)}</dd></div>}
            {form.items.length > costed && <div><dt>Not priced</dt><dd>{form.items.length - costed} of {form.items.length}</dd></div>}
          </dl>
          {sauce && (
            <>
              <dl className="tag-sum">
                <div className="sells">
                  <dt><label htmlFor="sauce-price">Price a serving</label></dt>
                  <dd>
                    <span className="money-input">
                      <span aria-hidden="true">$</span>
                      <input id="sauce-price" className="input num" inputMode="decimal" value={form.salePrice} placeholder={marginPrice ?? '0.00'} aria-invalid={!blankOrPrice(form.salePrice)}
                        onChange={(e) => setForm({ ...form, salePrice: e.target.value })} />
                    </span>
                  </dd>
                </div>
              </dl>
              <small className="tag-foot">
                {margin != null ? `${margin}% margin at that price.` : marginPrice ? `Left blank, it’s ${money(marginPrice)}: the cost at the default margin.` : 'Add priced ingredients to see its cost.'}
              </small>
            </>
          )}

          <div className="tag-batch">
            <h2>Scaled {scaled && <span className="scaled">×{scale.toDecimalPlaces(2).toString()}</span>}</h2>
            {sauce ? (
              <div className="margin-slider">
                <div className="margin-slider-head">
                  <label htmlFor="quarts-to-make">Quarts to make</label>
                  <input className="input num" style={{ width: 80 }} inputMode="decimal" value={qtText} aria-label="Quarts to make (number)" title="Fractions work: 1/2, 1 1/2, ½" aria-invalid={!quartsOk} onChange={(e) => setMakeQt(e.target.value)} />
                </div>
                <input id="quarts-to-make" type="range" min={QT_STEP} max={qtSliderMax} step={QT_STEP} value={qtSlider} onChange={(e) => setMakeQt(e.target.value)}
                  style={{ '--fill': `${((qtSlider - QT_STEP) / (qtSliderMax - QT_STEP)) * 100}%` }} />
              </div>
            ) : (
              <div className="tag-scale">
                <span>Scale to</span>
                <Stepper value={needed} onChange={setNeeded} label="Servings needed; the saved blend doesn’t change" min={1} />
                <span>servings</span>
              </div>
            )}
            <dl className="tag-rows">
              <div><dt>For {scaledFor}</dt><dd className={scaled ? 'scaled' : ''}>{qty(grams.times(scale), 0)} g</dd></div>
              {sauce
                ? <div><dt>Makes</dt><dd>{qty(batch.times(scale))} {SAUCE_UOM}{perContainer ? `, ${qty(perContainer.times(scale), 1)} servings` : ''}</dd></div>
                : <div><dt>About</dt><dd>{qty(tsp.times(scale), 1)} tsp</dd></div>}
              {breakdown.cost && <div><dt>Cost</dt><dd className={scaled ? 'scaled' : ''}>{money(toDecimal(breakdown.cost).times(scale))}</dd></div>}
            </dl>
            <p className="tag-foot">Scaling here never changes the saved {thing}{sauce ? `, which stays at one ${form.container} container` : ''}.</p>
          </div>
        </aside>
      </div>

      {viewing && <IngredientDrawer id={viewing} onClose={() => closeIngredient(viewing)} />}
      <LeaveModal blocker={blocker} error={saveError} onSave={id && !problems ? save : undefined} saving={saving}>
        Your changes to {form.name || `this ${thing}`} haven’t been saved. If you leave now, they’re lost.
      </LeaveModal>
      {deleting && (
        <Modal title={`Delete ${form.name}?`} onClose={() => setDeleting(false)}>
          <p>The {thing} will be deleted. A {thing} used in a recipe can’t be deleted until it’s removed from it.</p>
          <div className="form-actions">
            <button className="btn ghost" onClick={() => setDeleting(false)}>Keep it</button>
            <button className="btn danger" onClick={remove}>Delete {thing}</button>
          </div>
        </Modal>
      )}
    </main>
  );
}
