// Receipts: every shopping trip, read down like a receipt roll, a month at a time with what it came to.
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../../hooks.js';
import { Decimal, clock, money, toDecimal } from '../../format.js';
import { Icon, Modal, Notice, Spinner, TestBadge } from '../../components/ui.jsx';
import { ReceiptImportForm } from '../../components/forms.jsx';
import { PANTRY_NAV } from './PantryPage.jsx';
import { DayDot, SubNav, Tape, count, monthName } from './parts.jsx';

/** When the receipt was printed, as sortable text: its date and time, else the day it was imported. */
const printed = (r) => `${r.date ?? r.createdAt.slice(0, 10)}T${r.time ?? '00:00'}`;

export default function ReceiptsPage() {
  const { data, error, loading } = useApi('/receipts');
  const [importing, setImporting] = useState(false);
  const rows = (data ?? []).slice().sort((a, b) => printed(b).localeCompare(printed(a)) || b.createdAt.localeCompare(a.createdAt));
  const months = [];
  for (const r of rows) {
    const name = monthName(printed(r));
    if (months.at(-1)?.name !== name) months.push({ name, receipts: [], total: new Decimal(0) });
    months.at(-1).receipts.push(r);
    months.at(-1).total = months.at(-1).total.plus(toDecimal(r.savedTotal) ?? 0);
  }
  return (
    <main className="page alt-page receipts">
      <header className="alt-head">
        <h1>Pantry</h1>
        <SubNav label="Pantry" items={PANTRY_NAV} />
      </header>
      <div className="alt-tools">
        <span className="grow muted">Every shopping trip saved from a receipt, with its photos and the purchases it recorded.</span>
        <button className="btn primary" onClick={() => setImporting(true)}><Icon.plus /> Import a receipt</button>
      </div>
      {importing && (
        <Modal title="Import receipt" onClose={() => setImporting(false)}>
          <ReceiptImportForm onDone={() => setImporting(false)} />
        </Modal>
      )}
      {error && <Notice kind="error">{error.message}</Notice>}
      {loading && !data && <Spinner />}
      {data && !data.length && (
        <div className="alt-empty">
          <p>No receipts yet. Import one, and when you save its lines the receipt and its photos are kept here.</p>
          <button className="btn primary" onClick={() => setImporting(true)}><Icon.plus /> Import a receipt</button>
        </div>
      )}
      {months.map((m) => (
        <section key={m.name} className="roll">
          <div className="roll-head">
            <Tape>{m.name}</Tape>
            <span className="muted">{count(m.receipts.length, 'trip')}</span>
            <b>{money(m.total)}</b>
          </div>
          <ul>
            {m.receipts.map((r) => (
              <li key={r.id}>
                <Link to={`/purchases/${r.id}`}>
                  <DayDot iso={printed(r)} />
                  <span className="r-where">
                    <b>{r.vendor ?? 'Unknown vendor'}</b> <TestBadge item={r} />
                    <small>
                      {count(r.lineCount, 'line')} saved{r.time && `, ${clock(r.time)}`}
                      {r.pendingCount > 0 && <span className="badge new">{r.pendingCount} not saved</span>}
                    </small>
                  </span>
                  <span className="r-photos">
                    {r.images.slice(0, 3).map((img) => <img key={img.id} src={img.thumbUrl} alt="" loading="lazy" />)}
                    {r.images.length > 3 && <small className="muted">+{r.images.length - 3}</small>}
                  </span>
                  <span className="r-total">{money(r.savedTotal)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
