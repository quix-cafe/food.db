// Checking a receipt, line by line. Each line reads the way a receipt does: what it is, then
// packs × size at a price = total, with the box to tick once it's right. The receipt itself
// (photos or the JSON) stays beside the list to check against. Rows, matching and saving are the
// default page's (useReceiptReview, rowUpdater), so both pages save the same way.
import { Link, useLocation, useNavigate } from 'react-router';
import { date as formatDate, money, perUnit, qty, toDecimal } from '../../format.js';
import CategoryCombobox from '../../components/CategoryCombobox.jsx';
import { ReceiptImportForm, UomInput } from '../../components/forms.jsx';
import ReceiptNameCell, { rowTarget } from '../../components/ReceiptNameCell.jsx';
import { rowProblem, rowUnitPrice, rowUpdater, toRow, unitMismatch } from '../../components/ReviewLines.jsx';
import { Icon, LeaveModal, Notice, Spinner } from '../../components/ui.jsx';
import { ReceiptSaved, useReceiptReview } from '../../pages/ReceiptReviewPage.jsx';
import { DayDot, Tape, count } from './parts.jsx';

export default function ReceiptReviewPage() {
  const { state } = useLocation();
  if (!state?.receipt) {
    return (
      <main className="page alt-page receipt-import">
        <header className="alt-head"><h1>Import a receipt</h1></header>
        <p className="lede">Paste what your receipt extractor produced. Every line is checked against the pantry first; nothing is saved until you tick it.</p>
        <ReceiptImportForm />
      </main>
    );
  }
  return <Review key={state.source} {...state} />;
}

function ReviewLine({ r, i, update, onRemove }) {
  const problem = rowProblem(r);
  const target = rowTarget(r);
  const mismatch = unitMismatch(r);
  const bad = (v) => !toDecimal(v) || toDecimal(v).lte(0);
  return (
    <li className={`rv-line ${r.confirmed ? 'ticked' : ''} ${problem ? 'needs' : ''}`}>
      <label className="rv-tick" title={problem ?? 'Save this line'}>
        <input type="checkbox" checked={r.confirmed} disabled={!!problem} aria-label={`Save line ${i + 1}${problem ? ` (${problem})` : ''}`} onChange={(e) => update(r.key, { confirmed: e.target.checked })} />
      </label>
      <div className="rv-what">
        <ReceiptNameCell row={r} index={i} onChange={(patch) => update(r.key, patch)} />
        {problem && <div className="name-status rv-problem">{problem}</div>}
        {mismatch && (
          <div className="name-status unit-warning" role="note">
            Sold by the {mismatch.soldBy}, but {target.name} is counted in {mismatch.uom}. Set the pack size to how many {mismatch.uom} make 1 {mismatch.soldBy}
            {mismatch.estimate && toDecimal(r.packSize)?.eq(1) && <> (<button type="button" className="link-btn" onClick={() => update(r.key, { packSize: mismatch.estimate })}>about {qty(mismatch.estimate)}?</button>)</>}.
          </div>
        )}
      </div>
      <div className="rv-sum">
        <input className="input num" inputMode="decimal" value={r.quantity} aria-label={`Line ${i + 1} packs bought`} title="Packs bought" aria-invalid={bad(r.quantity)} onChange={(e) => update(r.key, { quantity: e.target.value })} />
        <span aria-hidden="true">×</span>
        <input className="input num" inputMode="decimal" value={r.packSize} aria-label={`Line ${i + 1} pack size`} title="How much is in one pack" aria-invalid={bad(r.packSize)} onChange={(e) => update(r.key, { packSize: e.target.value })} />
        {target.kind === 'existing'
          ? <span className="rv-uom" title="Set on the ingredient">{target.uom ?? 'each'}</span>
          : <UomInput style={{ width: 76 }} value={r.uom} placeholder="each" aria-label={`Line ${i + 1} unit of measurement`} onChange={(uom) => update(r.key, { uom })} />}
        <span>at</span>
        <span className="money-input"><span aria-hidden="true">$</span><input className="input num" inputMode="decimal" value={r.unitCost} aria-label={`Line ${i + 1} pack price`} title="Price of one pack" onChange={(e) => update(r.key, { unitCost: e.target.value })} /></span>
        <span aria-hidden="true">=</span>
        <span className="money-input total"><span aria-hidden="true">$</span><input className="input num" inputMode="decimal" value={r.totalCost} aria-label={`Line ${i + 1} total`} title="What the receipt says was paid" onChange={(e) => update(r.key, { totalCost: e.target.value })} /></span>
      </div>
      <div className="rv-meta">
        <b>{rowUnitPrice(r) ? perUnit(rowUnitPrice(r), target.uom) : ''}</b>
        <CategoryCombobox value={r.category} disabled={target.kind === 'existing'} ariaLabel={`Line ${i + 1} category`} placeholder="Category" onChange={(category) => update(r.key, { category })} />
      </div>
      <button className="icon-btn rv-off" aria-label={`Leave line ${i + 1} out`} title="Leave this line out" onClick={onRemove}><Icon.close /></button>
    </li>
  );
}

function Review({ receipt, source, draftId }) {
  const {
    vendor, setVendor, date, setDate, rows, setRows, photos, setPhotos, photoImages, receiptId, zoom, setZoom, view, setView, busy, error, saved, done,
    confirmed, blocker, allowLeave, lineSum, commit,
  } = useReceiptReview({ receipt, source, draftId });
  const navigate = useNavigate();
  const update = rowUpdater(setRows);

  if (done) {
    const leave = (to) => { allowLeave(); navigate(to); };
    return (
      <ReceiptSaved saved={saved} vendor={vendor} date={date} receiptId={receiptId} photos={photos.length}
        onIngredients={() => leave('/ingredients')} onAnother={() => leave('/ingredients/review')} />
    );
  }

  const ready = rows.filter((r) => !r.confirmed && !rowProblem(r));
  const waiting = rows.filter((r) => rowProblem(r)).length;
  const printed = toDecimal(receipt.printedTotal);
  const off = printed && !printed.minus(lineSum).abs().lt('0.005');
  const save = (extra = '') => (
    <button className={`btn primary ${extra}`} disabled={!confirmed.length || busy} onClick={commit}>
      {busy && <Spinner />} Save {confirmed.length || ''} ticked {confirmed.length === 1 ? 'line' : 'lines'}
    </button>
  );

  return (
    <main className="page alt-page review">
      <LeaveModal blocker={blocker}>
        {receiptId
          ? 'Your changes to the lines that aren’t saved yet will be lost. The lines themselves stay on the receipt under Receipts.'
          : confirmed.length
            ? 'Nothing from this receipt has been saved yet. If you leave now, the import and your changes are lost.'
            : 'You haven’t ticked any lines to save, so nothing from this receipt has been kept. If you leave now, the import is lost.'}
      </LeaveModal>
      <header className="rv-head">
        <div className="rv-title">
          <DayDot iso={date} size="big" />
          <input className="desk-name" value={vendor} onChange={(e) => setVendor(e.target.value)} aria-label="Store" placeholder="Which store?" />
          {receiptId
            ? <button className="btn" onClick={() => navigate(`/purchases/${receiptId}`)}>Finish later</button>
            : <button className="btn" onClick={() => { allowLeave(); navigate('/purchases'); }}>Discard</button>}
          {save()}
        </div>
        <p className="rc-makes">
          <span>Bought on</span>
          <input className="input rv-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Purchase date" />
          <span>
            {printed ? <>The receipt’s {receipt.totalLabel ?? 'total'} is <b>{money(printed)}</b>; the lines add up to <b className={off ? 'loss' : ''}>{money(lineSum)}</b>{off && `, ${money(printed.minus(lineSum).abs())} ${printed.gt(lineSum) ? 'short' : 'over'}`}.</>
              : <>The lines add up to <b>{money(lineSum)}</b>.</>}
          </span>
        </p>
      </header>

      {receipt.alreadyImported?.length > 0 && (
        <Notice kind="error">
          {receipt.alreadyImported.map((r) => (
            <div key={r.id}>
              This looks like a receipt already imported on {formatDate(new Date(r.createdAt).toLocaleDateString('en-CA'))} ({r.vendor || 'no store'}, {formatDate(r.date)}).{' '}
              <Link to={`/purchases/${r.id}`}>View that receipt</Link> before saving these lines again.
            </div>
          ))}
        </Notice>
      )}
      {receipt.warnings.length > 0 && <Notice>{receipt.warnings.map((w) => <div key={w}>{w}</div>)}</Notice>}

      <div className="rv-body">
        <section className="rv-lines">
          <div className="rc-section-head">
            <Tape>The lines</Tape>
            <span className="muted">
              {confirmed.length} of {count(rows.length, 'line')} ticked{waiting > 0 && `, ${waiting} ${waiting === 1 ? 'needs' : 'need'} a look first`}
            </span>
            {ready.length > 0 && (
              <button className="btn small" onClick={() => setRows((rs) => rs.map((r) => (rowProblem(r) ? r : { ...r, confirmed: true })))}>
                Tick the {ready.length === rows.length ? `${ready.length} lines` : `${ready.length} that ${ready.length === 1 ? 'is' : 'are'} ready`}
              </button>
            )}
          </div>
          <p className="muted rv-how">Check each line against the receipt and fix anything misread. Only ticked lines are saved; the rest stay on the receipt to add later. Click a name to rename it or pick another ingredient.</p>
          <ul>
            {rows.map((r, i) => <ReviewLine key={r.key} r={r} i={i} update={update} onRemove={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} />)}
          </ul>
          {error && <Notice kind="error">{error}</Notice>}
          <div className="rv-foot">
            <button className="btn small" onClick={() => setRows((rs) => [...rs, toRow({ quantity: '1' }, null)])}><Icon.plus /> Add a line</button>
            {save()}
          </div>
        </section>

        <aside className="rv-source" aria-label="The receipt">
          <div className="rv-source-bar">
            <div className="alt-segments" role="group" aria-label="Show">
              {photoImages.map((img, i) => <button key={img.id} type="button" aria-pressed={view === i} onClick={() => setView(i)}>Photo{photoImages.length > 1 ? ` ${i + 1}` : ''}</button>)}
              <button type="button" aria-pressed={view === 'json'} onClick={() => setView('json')}>Text</button>
            </div>
            {view !== 'json' && (
              <div className="zoom">
                <button className="icon-btn" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>−</button>
                <button className="btn small ghost" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
                <button className="icon-btn" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>+</button>
              </div>
            )}
          </div>
          <div className="source-view">
            {view !== 'json' && photoImages[view]
              ? <img src={photoImages[view].url} alt={`Receipt photo ${view + 1}`} style={{ width: `${zoom * 100}%` }} />
              : <pre>{source}</pre>}
          </div>
          <div className="rv-source-foot">
            {receiptId ? <span>Receipt saved with {count(photos.length, 'photo')}.</span> : (
              <>
                <label className="link-btn">
                  Add a photo
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple className="visually-hidden"
                    onChange={(e) => { const added = [...e.target.files]; if (added.length) { setPhotos((p) => [...p, ...added]); setView(photos.length); } e.target.value = ''; }} />
                </label>
                {view !== 'json' && photoImages[view]
                  ? <button className="link-btn" onClick={() => { setPhotos((p) => p.filter((_, i) => i !== view)); setView('json'); }}>Remove this photo</button>
                  : <span>{photos.length ? `${count(photos.length, 'photo')} will be kept with the receipt.` : 'Photos are kept with the receipt.'}</span>}
              </>
            )}
          </div>
        </aside>
      </div>
      {confirmed.length > 0 && <div className="floating-save">{save('floating')}</div>}
    </main>
  );
}
