import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api, imageForm, notifyDataChanged } from '../api.js';
import { takeDraftPhotos } from '../receiptDraft.js';
import { useLocalImages } from '../components/ImageGallery.jsx';
import { money, toDecimal, todayIso, Decimal } from '../format.js';
import ReviewLinesTable, { toRow, toPurchaseItem, savedMessage } from '../components/ReviewLines.jsx';
import { ReceiptImportForm } from '../components/forms.jsx';
import { Field, Notice, Spinner, useToast } from '../components/ui.jsx';

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
  const navigate = useNavigate();
  const toast = useToast();

  const confirmed = rows.filter((r) => r.confirmed);
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
      toast(savedMessage(res));
      const remaining = rows.filter((r) => !r.confirmed);
      if (remaining.length) setRows(remaining);
      else navigate(`/purchases/${id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Review receipt</h1>
          <p>Check each line against the receipt, fix anything that was misread, then tick it. Only ticked lines are saved; the rest stay on the receipt to add later.</p>
        </div>
        <div className="form-actions">
          {receiptId
            ? <button className="btn ghost" onClick={() => navigate(`/purchases/${receiptId}`)}>Finish later</button>
            : <button className="btn ghost" onClick={() => navigate('/ingredients')}>Discard</button>}
          <button className="btn primary" disabled={!confirmed.length || busy} onClick={commit}>
            {busy && <Spinner />} Save {confirmed.length || ''} confirmed {confirmed.length === 1 ? 'line' : 'lines'}
          </button>
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

          <ReviewLinesTable rows={rows} setRows={setRows} />
          {error && <div className="panel-pad" style={{ paddingTop: 0 }}><Notice kind="error">{error}</Notice></div>}
        </section>
      </div>
    </main>
  );
}
