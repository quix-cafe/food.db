import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, imageForm, notifyDataChanged } from '../api.js';
import { useApi } from '../hooks.js';
import { date, dateTime, money, qty, unitMoney } from '../format.js';
import ImageGallery from '../components/ImageGallery.jsx';
import ReviewLinesTable, { toRow, toPurchaseItem, savedMessage } from '../components/ReviewLines.jsx';
import { Modal, Notice, Spinner, useToast } from '../components/ui.jsx';

export default function ReceiptsPage() {
  const { data, error, loading } = useApi('/receipts');
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Receipts</h1>
          <p>Every receipt saved from the review screen, with its photos and the purchases it recorded.</p>
        </div>
      </div>
      {error && <Notice kind="error">{error.message}</Notice>}
      {loading && !data && <Spinner />}
      {data && !data.length && (
        <div className="panel empty">
          <h2>No receipts yet</h2>
          <p>Use Quick add to import a receipt. When you save its lines, the receipt and its photos are kept here.</p>
        </div>
      )}
      {data?.length > 0 && (
        <section className="panel table-wrap">
          <table className="grid">
            <thead>
              <tr><th>Photos</th><th>Vendor</th><th>Date</th><th className="num">Lines saved</th><th className="num">Saved total</th><th>Imported</th></tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="receipt-thumbs">
                      {r.images.slice(0, 3).map((img) => <img key={img.id} src={img.url} alt="" loading="lazy" />)}
                      {!r.images.length && <span className="muted">None</span>}
                      {r.images.length > 3 && <span className="muted">+{r.images.length - 3}</span>}
                    </div>
                  </td>
                  <td><Link to={`/receipts/${r.id}`} style={{ fontWeight: 650, color: 'inherit' }}>{r.vendor ?? 'Unknown vendor'}</Link></td>
                  <td className="nowrap">{date(r.date)}</td>
                  <td className="num">{r.lineCount}{r.pendingCount > 0 && <> <span className="badge new">{r.pendingCount} not saved</span></>}</td>
                  <td className="num">{money(r.savedTotal)}</td>
                  <td className="nowrap muted">{dateTime(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

export function ReceiptDetailPage() {
  const { id } = useParams();
  const { data: r, error, setData } = useApi(`/receipts/${id}`);
  const [busy, setBusy] = useState(false);
  const [photoError, setPhotoError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  if (error) return <main className="page"><Notice kind="error">{error.message}</Notice><Link to="/receipts">Back to receipts</Link></main>;
  if (!r) return <main className="page"><Spinner /></main>;

  const photoAction = async (fn) => {
    setBusy(true);
    setPhotoError(null);
    try {
      setData({ ...r, images: await fn() });
      notifyDataChanged();
    } catch (err) {
      setPhotoError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await api(`/receipts/${id}`, { method: 'DELETE' });
    notifyDataChanged();
    toast('Receipt deleted');
    navigate('/receipts');
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <Link to="/receipts" className="muted">Receipts</Link>
          <h1>{r.vendor ?? 'Unknown vendor'}</h1>
          <p>
            {date(r.date)}. {r.lineCount} {r.lineCount === 1 ? 'line' : 'lines'} saved for {money(r.savedTotal)}
            {r.pendingLines.length > 0 ? `, ${r.pendingLines.length} not saved yet` : ''}.
          </p>
        </div>
        <div className="form-actions">
          {r.source && <button className="btn" onClick={() => setShowSource(true)}>View JSON</button>}
          <button className="btn danger" onClick={() => setDeleting(true)}>Delete receipt</button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Photos</h2></div>
        <div className="panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ImageGallery
            images={r.images}
            label="photo"
            busy={busy}
            onAdd={(files) => photoAction(async () => [...r.images, ...(await api(`/receipts/${id}/images`, { method: 'POST', body: imageForm(files) }))])}
            onRemove={(img) => photoAction(async () => { await api(`/images/${img.id}`, { method: 'DELETE' }); return r.images.filter((i) => i.id !== img.id); })}
          />
          {photoError && <Notice kind="error">{photoError}</Notice>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Saved purchases</h2></div>
        <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr><th>Ingredient</th><th>Category</th><th className="num">Qty</th><th className="num">Unit cost</th><th className="num">Total</th></tr>
          </thead>
          <tbody>
            {r.purchases.map((p) => (
              <tr key={p.id}>
                <td><Link to={`/ingredients?open=${p.ingredientId}`} style={{ color: 'inherit', fontWeight: 600 }}>{p.ingredientName}</Link></td>
                <td>{p.category ?? '—'}</td>
                <td className="num">{qty(p.quantity)} {p.unit}</td>
                <td className="num">{unitMoney(p.unitCost)}</td>
                <td className="num">{money(p.totalCost)}</td>
              </tr>
            ))}
            {!r.purchases.length && <tr><td colSpan={5} className="muted">Nothing from this receipt has been saved yet.</td></tr>}
          </tbody>
          {r.purchases.length > 0 && <tfoot><tr><td colSpan={4}>Total</td><td className="num">{money(r.savedTotal)}</td></tr></tfoot>}
        </table>
        </div>
      </section>

      {r.pendingLines.length > 0 && <PendingLines receipt={r} />}

      {showSource && (
        <Modal title="Receipt JSON" onClose={() => setShowSource(false)}>
          <pre style={{ margin: 0, fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(r.source, null, 2)}</pre>
        </Modal>
      )}
      {deleting && (
        <Modal title="Delete this receipt?" onClose={() => setDeleting(false)}>
          <p>The receipt and its {r.images.length} photo{r.images.length === 1 ? '' : 's'} will be deleted. The {r.lineCount} purchases stay in each ingredient’s price history.</p>
          <div className="form-actions">
            <button className="btn ghost" onClick={() => setDeleting(false)}>Keep it</button>
            <button className="btn danger" onClick={remove}>Delete receipt</button>
          </div>
        </Modal>
      )}
    </main>
  );
}

/** Lines from the receipt's JSON that were skipped during review, shown grayed out until ticked. */
function PendingLines({ receipt }) {
  const [rows, setRows] = useState(() => receipt.pendingLines.map((l) => toRow(l)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const toast = useToast();

  // After a save (or any refresh), drop lines that are no longer pending but keep edits to the rest.
  useEffect(() => {
    setRows((prev) => {
      const byLine = new Map(prev.map((r) => [r.line, r]));
      return receipt.pendingLines.map((l) => byLine.get(l.line) ?? toRow(l));
    });
  }, [receipt.pendingLines]);

  const ticked = rows.filter((r) => r.confirmed);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api('/ingredients/purchase', {
        method: 'POST',
        body: { receiptId: receipt.id, vendor: receipt.vendor, date: receipt.date, items: ticked.map(toPurchaseItem) },
      });
      toast(savedMessage(res));
      notifyDataChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-label="Lines not saved yet">
      <div className="panel-head">
        <div>
          <h2>Not saved yet</h2>
          <p className="muted">Lines from the receipt that were skipped during review. Rename or adjust them, tick the ones to add, and save.</p>
        </div>
        <button className="btn primary" disabled={!ticked.length || busy} onClick={save}>
          {busy && <Spinner />} Save {ticked.length || ''} {ticked.length === 1 ? 'line' : 'lines'}
        </button>
      </div>
      <ReviewLinesTable rows={rows} setRows={setRows} pending allowAdd={false} />
      {error && <div className="panel-pad" style={{ paddingTop: 0 }}><Notice kind="error">{error}</Notice></div>}
    </section>
  );
}
