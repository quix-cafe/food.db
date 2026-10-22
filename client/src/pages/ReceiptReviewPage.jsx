import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { combinePurchases } from '@kitchen/shared';
import { api, imageForm, notifyDataChanged } from '../api.js';
import { takeDraftPhotos } from '../receiptDraft.js';
import { useLocalImages } from '../components/ImageGallery.jsx';
import { date as formatDate, money, pack, perUnit, qty, toDecimal, todayIso, Decimal } from '../format.js';
import ReviewLinesTable, { rowsSnapshot, toRow, toPurchaseItem, savedMessage } from '../components/ReviewLines.jsx';
import { useLeaveGuard } from '../hooks.js';
import { ReceiptImportForm } from '../components/forms.jsx';
import { Field, Icon, LeaveModal, Notice, Spinner, useToast } from '../components/ui.jsx';

/** OCR "Review & Confirm": nothing is saved until each row is checked and committed. */
export default function ReceiptReviewPage() {
  const { state } = useLocation();
  if (!state?.receipt) {
    return (
      <main className="page">
        <div className="page-head">
          <div>
            <h1>Review a receipt</h1>
            <p>Paste the JSON your receipt extractor produced. Each line is checked against the database before anything is saved.</p>
          </div>
        </div>
        <section className="panel panel-pad" style={{ maxWidth: 720 }}>
          <ReceiptImportForm />
        </section>
      </main>
    );
  }
  return <ReviewGrid key={state.source} {...state} />;
}

function ReviewGrid({ receipt, source, draftId }) {
  const [vendor, setVendor] = useState(receipt.vendor ?? '');
  const [date, setDate] = useState(receipt.date ?? todayIso());
  // `line` = position in the normalised JSON; the server stores lines in the same order.
  const [rows, setRows] = useState(() => receipt.items.map((item, i) => toRow(item, i)));
  const [photos, setPhotos] = useState(() => takeDraftPhotos(draftId));
  const photoImages = useLocalImages(photos);
  const [receiptId, setReceiptId] = useState(null); // created with the photos on first save
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState(() => (takeDraftPhotos(draftId).length ? 0 : 'json')); // photo index or 'json'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null); // every save's results for this receipt, added up
  const [done, setDone] = useState(false); // all lines saved: show the summary
  const navigate = useNavigate();
  const toast = useToast();

  const confirmed = rows.filter((r) => r.confirmed);

  // Edits since the import (or since the last save) would be lost by leaving: line changes and
  // ticks, the vendor or date, and photos not stored yet.
  const [baseline, setBaseline] = useState(() => ({ rows: rowsSnapshot(rows), vendor, date, photos: photos.length }));
  const dirty = rowsSnapshot(rows) !== baseline.rows || vendor !== baseline.vendor || date !== baseline.date
    || (!receiptId && photos.length !== baseline.photos);
  const { blocker, allowLeave } = useLeaveGuard(dirty);
  const lineSum = useMemo(
    () => rows.reduce((acc, r) => acc.plus(toDecimal(r.totalCost) ?? (toDecimal(r.unitCost)?.times(toDecimal(r.quantity) ?? 0) ?? 0)), new Decimal(0)),
    [rows],
  );

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      let id = receiptId;
      if (!id) {
        const created = await api('/receipts', { method: 'POST', body: imageForm(photos, { vendor, date, source }) });
        id = created.id;
        setReceiptId(id);
      }
      const res = await api('/ingredients/purchase', {
        method: 'POST',
        body: {
          receiptId: id,
          vendor,
          date,
          items: confirmed.map(toPurchaseItem),
        },
      });
      notifyDataChanged();
      setSaved((s) => (s
        ? Object.fromEntries(Object.entries(s).map(([k, list]) => [k, [...list, ...(res[k] ?? [])]]))
        : { purchases: res.purchases, createdIngredients: res.createdIngredients, aliasesSaved: res.aliasesSaved, renamedIngredients: res.renamedIngredients ?? [] }));
      const remaining = rows.filter((r) => !r.confirmed);
      setRows(remaining);
      setBaseline({ rows: rowsSnapshot(remaining), vendor, date, photos: photos.length });
      if (remaining.length) toast(savedMessage(res));
      else setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const leave = (to) => { allowLeave(); navigate(to); };
    return (
      <ReceiptSaved saved={saved} vendor={vendor} date={date} receiptId={receiptId} photos={photos.length}
        onIngredients={() => leave('/ingredients')} onAnother={() => leave('/ingredients/review')} />
    );
  }

  const saveButton = (className) => (
    <button className={`btn primary ${className}`} disabled={!confirmed.length || busy} onClick={commit}>
      {busy && <Spinner />} Save {confirmed.length || ''} confirmed {confirmed.length === 1 ? 'line' : 'lines'}
    </button>
  );

  return (
    <main className="page">
      <LeaveModal blocker={blocker}>
        {receiptId
          ? 'Your changes to the lines that aren’t saved yet will be lost. The lines themselves stay on the receipt under Purchases.'
          : 'Nothing from this receipt has been saved yet. If you leave now, the import and your changes are lost.'}
      </LeaveModal>
      <div className="page-head">
        <div>
          <h1>Review receipt</h1>
          <p>Check each line against the receipt, fix anything that was misread, then tick it. Only ticked lines are saved; the rest stay on the receipt to add later.</p>
        </div>
        <div className="form-actions">
          {receiptId
            ? <button className="btn ghost" onClick={() => navigate(`/purchases/${receiptId}`)}>Finish later</button>
            : <button className="btn ghost" onClick={() => { allowLeave(); navigate('/ingredients'); }}>Discard</button>}
        </div>
      </div>

      <div className="split">
        <section className="panel source-pane" aria-label="Receipt">
          <div className="panel-head">
            <div className="chips" role="group" aria-label="Receipt view">
              {photoImages.map((img, i) => (
                <button key={img.id} className="chip" aria-pressed={view === i} onClick={() => setView(i)}>Photo {photoImages.length > 1 ? i + 1 : ''}</button>
              ))}
              <button className="chip" aria-pressed={view === 'json'} onClick={() => setView('json')}>JSON</button>
              {!receiptId && (
                <label className="chip" style={{ cursor: 'pointer' }}>
                  + Photo
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple className="visually-hidden"
                    onChange={(e) => { const added = [...e.target.files]; if (added.length) { setPhotos((p) => [...p, ...added]); setView(photos.length); } e.target.value = ''; }} />
                </label>
              )}
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
          <div className="source-foot">
            {receiptId
              ? <span>Receipt saved with {photos.length} photo{photos.length === 1 ? '' : 's'}.</span>
              : view !== 'json' && photoImages[view]
                ? <button className="link-btn" onClick={() => { setPhotos((p) => p.filter((_, i) => i !== view)); setView('json'); }}>Remove this photo</button>
                : <span>{photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'} will be stored with the receipt.` : 'Add photos to keep them with the receipt.'}</span>}
          </div>
        </section>

        <section className="panel" aria-label="Extracted lines">
          <div className="panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="form-grid">
              <Field label="Vendor"><input className="input" value={vendor} onChange={(e) => setVendor(e.target.value)} /></Field>
              <Field label="Purchase date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
              <Field label={`Receipt ${receipt.totalLabel ?? 'total'}`}>
                <span style={{ padding: '7px 0', fontWeight: 650 }}>
                  {receipt.printedTotal ? money(receipt.printedTotal) : '—'} <span className="muted">(lines add up to {money(lineSum)})</span>
                </span>
              </Field>
            </div>
            {receipt.warnings.length > 0 && <Notice>{receipt.warnings.map((w) => <div key={w}>{w}</div>)}</Notice>}
          </div>

          <div className="panel-pad" style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 0 }}>{saveButton('')}</div>
          <ReviewLinesTable rows={rows} setRows={setRows} saveButton={saveButton} />
          {error && <div className="panel-pad" style={{ paddingTop: 0 }}><Notice kind="error">{error}</Notice></div>}
        </section>
      </div>
    </main>
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Shown once every line of the receipt is saved: everything that was added (across all the
 * saves for this receipt), then back to Ingredients or on to the next receipt.
 */
function ReceiptSaved({ saved, vendor, date, receiptId, photos, onIngredients, onAnother }) {
  const heading = useRef(null);
  useEffect(() => {
    window.scrollTo(0, 0);
    heading.current?.focus();
  }, []);
  const { purchases, createdIngredients, aliasesSaved, renamedIngredients } = saved;
  const created = new Set(createdIngredients.map((c) => c.id));
  const total = purchases.reduce((sum, p) => sum.plus(p.totalCost), new Decimal(0));
  const byIngredient = new Map();
  for (const p of purchases) byIngredient.set(p.ingredientId, [...(byIngredient.get(p.ingredientId) ?? []), p]);
  const averaged = [...byIngredient.values()]
    .filter((lines) => lines.length > 1)
    .map((lines) => ({ name: lines[0].ingredientName, uom: lines[0].uom, lines: lines.length, unitPrice: combinePurchases(lines).unitPrice }));
  const facts = [
    createdIngredients.length > 0 && plural(createdIngredients.length, 'new ingredient'),
    aliasesSaved.length > 0 && `${plural(aliasesSaved.length, 'receipt name')} remembered`,
    renamedIngredients.length > 0 && `${plural(renamedIngredients.length, 'ingredient')} renamed`,
    photos > 0 && `${plural(photos, 'photo')} kept with the receipt`,
  ].filter(Boolean);

  return (
    <main className="page">
      <section className="panel panel-pad receipt-saved">
        <div className="saved-head">
          <span className="saved-check" aria-hidden="true"><Icon.check /></span>
          <div>
            <h1 ref={heading} tabIndex={-1}>Receipt saved</h1>
            <p className="muted">
              {plural(purchases.length, 'purchase')} from {vendor || 'an unnamed store'}{date ? ` on ${formatDate(date)}` : ''}, {money(total)} in all.
            </p>
          </div>
        </div>
        {facts.length > 0 && <ul className="saved-facts">{facts.map((f) => <li key={f} className="badge">{f}</li>)}</ul>}

        <div className="panel table-wrap">
          <table className="grid">
            <thead><tr><th>Ingredient</th><th className="num">Bought</th><th className="num">Per unit</th><th className="num">Total</th></tr></thead>
            <tbody>
              {purchases.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/ingredients?open=${p.ingredientId}`} style={{ color: 'inherit', fontWeight: 650 }}>{p.ingredientName}</Link>
                    {created.has(p.ingredientId) && <> <span className="badge new">New ingredient</span></>}
                    {p.receiptName && <div className="muted" style={{ fontSize: '0.85rem' }}>Receipt: “{p.receiptName}”</div>}
                  </td>
                  <td className="num nowrap">{qty(p.quantity)} × {pack(p.packSize, p.uom)}</td>
                  <td className="num nowrap">{perUnit(p.unitPrice, p.uom)}</td>
                  <td className="num">{money(p.totalCost)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td>{plural(purchases.length, 'purchase')}</td><td /><td /><td className="num">{money(total)}</td></tr></tfoot>
          </table>
        </div>

        {averaged.length > 0 && (
          <p className="muted" style={{ margin: 0 }}>
            Bought more than once on this receipt, so its price is the average, not a price change:{' '}
            {averaged.map((a) => `${a.name} (${a.lines} lines, ${perUnit(a.unitPrice, a.uom)})`).join(', ')}.
          </p>
        )}
        {aliasesSaved.length > 0 && (
          <p className="muted" style={{ margin: 0 }}>
            Next time, these receipt names match by themselves: {aliasesSaved.map((a) => `“${a.alias}” → ${a.ingredient}`).join(', ')}.
          </p>
        )}
        {renamedIngredients.length > 0 && (
          <p className="muted" style={{ margin: 0 }}>Renamed: {renamedIngredients.map((r) => r.name).join(', ')}.</p>
        )}

        <div className="saved-actions">
          <button className="btn primary" onClick={onIngredients}>Back to Ingredients</button>
          <button className="btn" onClick={onAnother}><Icon.plus /> Add another receipt</button>
          <Link className="link-btn" to={`/purchases/${receiptId}`}>View this receipt</Link>
        </div>
      </section>
    </main>
  );
}
