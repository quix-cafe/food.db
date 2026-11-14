// A recipe as a card you'd tape to the wall: what it makes as a sentence, the ingredients as lines
// that read amount first with each one's share of the cost as a bar, and beside them the price of
// a serving worked through from cost to what it keeps. The form, costing, saving and photos are
// the default builder's (useRecipeBuilder), so both pages save the same way.
import { Link, useParams } from 'react-router';
import { DEFAULT_MARGIN } from '@kitchen/shared';
import ImageGallery from '../../components/ImageGallery.jsx';
import { date, money, pack, percent, perUnit, qty, unitMoney, toDecimal } from '../../format.js';
import IngredientCombobox from '../../components/IngredientCombobox.jsx';
import { Icon, LeaveModal, Modal, Notice, SaveButton, Spinner, TestBadge } from '../../components/ui.jsx';
import { AddToEventModal } from '../../pages/RecipeGallery.jsx';
import { IngredientDrawer } from '../../components/IngredientDrawer.jsx';
import { AmountInput, amountProblem, lineUnit, useRecipeBuilder } from '../../pages/RecipeBuilder.jsx';
import { Stepper } from './EventMenu.jsx';
import { Tape, count } from './parts.jsx';

/** Where a line's price comes from, in a sentence. */
function Source({ l, c }) {
  if (l.blendId) {
    return (
      <small>
        <Link to={`/spice-lab/${l.blendId}`}>{l.category}</Link>, a batch of {qty(l.packSize)} {l.uom}{l.packPrice ? ` costs ${money(l.packPrice)}` : ''}
        {c?.missingPrice && <span className="badge warn">No prices</span>}
      </small>
    );
  }
  if (c?.missingPrice) return <small><span className="badge warn">No purchase price</span></small>;
  return (
    <small>
      {c?.unitPrice ? perUnit(c.unitPrice, l.uom) : ''}{l.packPrice ? `, ${pack(l.packSize, l.uom)} for ${unitMoney(l.packPrice)}` : ''}
      {l.vendor ? ` at ${l.vendor}` : ''}{l.priceDate ? `, ${date(l.priceDate)}` : ''}
    </small>
  );
}

export default function RecipePage() {
  const { id } = useParams();
  const {
    form, setForm, expected, setExpected, noteSizeStart, sizeOffer, scaleToSize, keepAmounts, loadError, removing, setRemoving, saveError, saving, viewing, setViewing, search, setSearch,
    rowProps, handleProps, addToEvent, setAddToEvent, images, pendingImages, photoBusy, photoError, priceDraft, setPriceDraft, closeIngredient,
    dirty, blocker, costing, calcError, set, setServingSize, setServings, unitLabel, priceProblem, setPrice, shownMargin, marginLoss,
    setLine, removeLine, addIngredient, save, addPhotos, removePhoto, makeCover, cropPhoto, lineById, scaled,
  } = useRecipeBuilder(id);

  if (loadError) return <main className="page alt-page"><Notice kind="error">{loadError}</Notice><Link to="/recipes">Back to recipes</Link></main>;
  if (!form) return <main className="page alt-page"><Spinner /></main>;

  const batchCost = costing ? toDecimal(costing.baseCost) : null;
  const shareOf = (c) => (c && batchCost?.gt(0) ? toDecimal(c.baseCost).div(batchCost).times(100).toNumber() : 0);
  const margin = Math.max(0, toDecimal(shownMargin)?.toNumber() ?? DEFAULT_MARGIN);
  const price = costing ? toDecimal(costing.recommendedPrice) : null;
  const food = costing && price?.gt(0) ? Math.min(100, toDecimal(costing.costPerServing).div(price).times(100).toNumber()) : null;
  const sizeBad = form.servingSize.trim() !== '' && !(toDecimal(form.servingSize)?.gt(0));

  return (
    <main className="page alt-page recipe">
      <header className="rc-head">
        <div className="rc-title">
          <input className="desk-name" value={form.name} onChange={set('name')} aria-label="Recipe name" placeholder={id ? 'Untitled recipe' : 'Name the recipe'} />
          <TestBadge item={form} />
          {id && <button className="btn" onClick={() => setAddToEvent(true)}>Add to event</button>}
          <SaveButton dirty={dirty} saving={saving} disabled={(!dirty && !!id) || saving} onClick={save} isNew={!id} createLabel="Create recipe" />
        </div>
        {/* What it makes, as the sentence you'd say: only the total yield is stored. */}
        <p className="rc-makes">
          <span>Makes</span>
          <input className="input num" inputMode="numeric" value={form.baseServings} onChange={setServings} aria-label="Expected servings: what the recipe makes as written" title="What the recipe makes as written" />
          <span>servings of</span>
          <input className="input num" inputMode="decimal" value={form.servingSize} onChange={setServingSize} placeholder="size" aria-invalid={sizeBad}
            aria-label={`Size per serving, in ${unitLabel}`} title="How much of it is one serving. The amounts stay as written." onFocus={noteSizeStart} />
          <input className="input unit" value={form.yieldUnit} onChange={set('yieldUnit')} placeholder="oz, tacos, bowls…" aria-label="Unit a serving is measured in" />
          <span>each{form.totalYield && <>, <b>{qty(form.totalYield)} {unitLabel}</b> in all</>}</span>
        </p>
        {sizeOffer && (
          <p className="rc-offer" role="status">
            A serving went from {sizeOffer.from} to {sizeOffer.to} {unitLabel}. The amounts are as you wrote them.
            <button type="button" className="btn small" onClick={scaleToSize}>Scale every amount ×{sizeOffer.factor}</button>
            <button type="button" className="btn small ghost" onClick={keepAmounts}>Keep them</button>
          </p>
        )}
      </header>
      {saveError && <Notice kind="error">{saveError}</Notice>}

      <div className="rc-body">
        <div className="rc-main">
          <section>
            <div className="rc-section-head">
              <Tape>What goes in</Tape>
              <span className="muted">{count(form.lines.length, 'line')}{costing && form.lines.length > 0 && `, ${money(costing.baseCost)} for the batch as written`}</span>
            </div>
            {form.lines.length > 0 && (
              <table className={`rc-lines ${scaled ? 'is-scaled' : ''}`}>
                <tbody>
                  {form.lines.map((l, i) => {
                    const c = lineById.get(l.key);
                    return (
                      <tr key={l.key} {...rowProps(i)}>
                        <td className="l-grip"><button className="icon-btn drag-handle" aria-label={`Move ${l.name} (drag, or use arrow keys)`} {...handleProps(i)}><Icon.grip /></button></td>
                        <td className="l-amount">
                          <AmountInput line={l} problem={amountProblem([l]) || !!c?.unitProblem} onChange={(patch) => setLine(l.key, patch)} />
                          {c && lineUnit(l) && (c.unitProblem
                            ? <small className="badge warn" title="Set what a cup of it weighs in its details">Can’t convert to {l.uom}</small>
                            : <small>about {qty(c.amountInUom)} {l.uom}</small>)}
                          {scaled && c && <small className="scaled">{qty(c.scaledLineAmount)} {lineUnit(l) ?? l.uom ?? ''} scaled</small>}
                        </td>
                        <td className="l-name">
                          {l.blendId
                            // A blend opens in the Spice Lab; the leave guard asks first when the recipe has unsaved changes.
                            ? <Link className="line-name" aria-label={`${l.name}: view or edit`} to={`/spice-lab/${l.blendId}`}>{l.name}</Link>
                            : <button type="button" className="line-name" aria-label={`${l.name}: view or edit`} onClick={() => setViewing(l.ingredientId)}>{l.name}</button>}
                          <Source l={l} c={c} />
                        </td>
                        <td className="l-share"><span className="bar" role="img" aria-label={`${shareOf(c).toFixed(0)}% of the cost`} title={`${shareOf(c).toFixed(0)}% of the cost`}><i style={{ width: `${shareOf(c)}%` }} /></span></td>
                        <td className="l-cost">
                          <b>{c ? money(c.baseCost) : '—'}</b>
                          {scaled && c && <small className="scaled">{money(c.scaledCost)}</small>}
                        </td>
                        <td className="l-off"><button className="icon-btn" aria-label={`Remove ${l.name}`} title="Remove from the recipe" onClick={() => (l.name ? setRemoving(l) : removeLine(l.key))}><Icon.close /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <IngredientCombobox
              ariaLabel="Add an ingredient"
              value={search}
              onInput={setSearch}
              onPick={addIngredient}
              exclude={form.lines.map((l) => l.ingredientId ?? l.blendId)}
              includeBlends
              placeholder={form.lines.length ? 'Add another ingredient, spice blend or sauce…' : 'Start with an ingredient, spice blend or sauce…'}
              footer={(q) => q.trim() && (
                <div className="option muted" style={{ cursor: 'default' }}>Not listed? Add “{q.trim()}” to the pantry with Quick add first.</div>
              )}
            />
            {calcError && <Notice kind="error">{calcError}</Notice>}
          </section>

          <section>
            <div className="rc-section-head">
              <Tape>Photos</Tape>
              <span className="muted">{id ? 'Saved as soon as you add them. The first is the cover.' : 'Uploaded when you create the recipe.'}</span>
            </div>
            <ImageGallery images={id ? images : pendingImages} onAdd={addPhotos} onRemove={removePhoto} onMakeCover={makeCover} onCrop={cropPhoto} busy={photoBusy} />
            {photoError && <Notice kind="error">{photoError}</Notice>}
          </section>
        </div>

        <aside className="price-tag" aria-label="Price and profit">
          <h2>A serving</h2>
          <dl className="tag-sum">
            <div><dt>Cost</dt><dd>{costing ? money(costing.costPerServing) : '—'}</dd></div>
            <div className="sells">
              <dt><label htmlFor="target-price">Price</label></dt>
              <dd>
                <span className="money-input">
                  <span aria-hidden="true">$</span>
                  <input id="target-price" className="input num" inputMode="decimal" disabled={!costing} aria-invalid={!!priceProblem} aria-describedby="target-price-note"
                    value={priceDraft ?? (costing ? toDecimal(costing.recommendedPrice).toFixed(2) : '')}
                    onChange={(e) => setPrice(e.target.value)} onBlur={() => setPriceDraft(null)} />
                </span>
              </dd>
            </div>
            <div className={`keeps ${costing && toDecimal(costing.profitPerServing).lt(0) ? 'loss' : 'profit'}`}>
              <dt>Profit</dt><dd>{costing ? money(costing.profitPerServing) : '—'}</dd>
            </div>
          </dl>
          {food != null && (
            <span className={`plate-bar ${food >= 100 ? 'over' : ''}`} role="img" aria-label={`Food is ${food.toFixed(0)}% of the price`} title={`Food is ${food.toFixed(0)}% of the price`}><i style={{ width: `${food}%` }} /></span>
          )}
          <div className="margin-slider">
            <div className="margin-slider-head">
              <label htmlFor="margin">Margin</label>
              <output htmlFor="margin" className={marginLoss ? 'loss' : ''}>{percent(shownMargin)}</output>
            </div>
            <input id="margin" type="range" min="0" max="95" step="1" value={margin} style={{ '--fill': `${(Math.min(margin, 95) / 95) * 100}%` }}
              onChange={(e) => { setPriceDraft(null); setForm((f) => ({ ...f, targetMargin: e.target.value, targetPrice: '' })); }} />
            <small id="target-price-note" className={priceProblem ? 'loss' : ''}>
              {priceProblem ?? (form.targetPrice
                ? <>Price set by hand: it stays when ingredient costs change, and the margin moves instead.{marginLoss && <> It’s now below the cost of a serving.</>}{' '}
                  <button type="button" className="link-btn" onClick={() => { setPriceDraft(null); setForm((f) => ({ ...f, targetPrice: '' })); }}>Follow the margin instead</button></>
                : 'The price follows ingredient costs at this margin. Type a price to set it by hand and keep it fixed.')}
            </small>
          </div>

          <div className="tag-batch">
            <h2>A batch {costing && scaled && <span className="scaled">×{toDecimal(costing.scale).toDecimalPlaces(2).toString()}</span>}</h2>
            <div className="tag-scale">
              <span id="scale-label">Scale to</span>
              <Stepper value={expected} onChange={setExpected} label="Servings to cost the batch for; the saved recipe doesn’t change" min={1} />
              <span>servings</span>
            </div>
            {costing && (
              <dl className="tag-rows">
                <div><dt>Cost</dt><dd className={scaled ? 'scaled' : ''}>{money(costing.scaledCost)}</dd></div>
                <div><dt>Revenue</dt><dd>{money(costing.revenue)}</dd></div>
                <div className={toDecimal(costing.profit).lt(0) ? 'loss' : 'profit'}><dt>Profit</dt><dd>{money(costing.profit)}</dd></div>
              </dl>
            )}
            {costing?.warnings.length > 0 && <Notice>{costing.warnings.map((w) => <div key={w}>{w}</div>)}</Notice>}
            {costing && (
              <p className="tag-foot">
                As written it makes {costing.baseServings} for {money(costing.baseCost)}
                {scaled && form.totalYield && costing.scaledYield ? `; scaled, ${qty(costing.scaledYield)} ${form.yieldUnit}` : ''}.
                Scaling here never changes the saved recipe.
              </p>
            )}
          </div>
        </aside>
      </div>

      {removing && (
        <Modal title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)}>
          <p>It comes out of this recipe only; the ingredient and its prices are kept. Nothing is saved until you save the recipe.</p>
          <div className="form-actions">
            <button className="btn ghost" onClick={() => setRemoving(null)}>Keep it</button>
            <button className="btn danger" onClick={() => { removeLine(removing.key); setRemoving(null); }}>Remove</button>
          </div>
        </Modal>
      )}
      {viewing && <IngredientDrawer id={viewing} onClose={() => closeIngredient(viewing)} />}
      <LeaveModal blocker={blocker} error={saveError} onSave={id ? save : undefined} saving={saving}>
        Your changes to {form.name || 'this recipe'} haven’t been saved. If you leave now, they’re lost.
      </LeaveModal>
      {addToEvent && <AddToEventModal recipe={{ id, name: form.name, baseServings: form.baseServings, costPerServing: costing?.costPerServing, recommendedPrice: costing?.recommendedPrice, dealQty: form.dealQty, dealPrice: form.dealPrice }} onClose={() => setAddToEvent(false)} />}
    </main>
  );
}
