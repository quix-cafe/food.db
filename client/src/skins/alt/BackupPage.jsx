import { useEffect, useRef, useState } from 'react';
import { api, notifyDataChanged, setTestMode } from '../../api.js';
import { useApi, useTestMode } from '../../hooks.js';
import { setSkin, useSkin } from '../../skin.js';
import { dateTime } from '../../format.js';
import { Icon, Modal, Notice, Spinner, useToast } from '../../components/ui.jsx';

const ROWS = [
  ['ingredients', 'Ingredients'],
  ['ingredient_purchases', 'Purchases'],
  ['ingredient_aliases', 'Receipt names'],
  ['receipts', 'Receipts'],
  ['spice_blends', 'Spice blends'],
  ['recipes', 'Recipes'],
  ['events', 'Events'],
  ['images', 'Photos'],
];

const SNAPSHOT_LABELS = [
  ['before-clearing-test-data', 'Before clearing test data'],
  ['before-compressing-photos', 'Before compressing photos'],
  ['before-restore', 'Before the restore'],
];

const TEST_ROWS = [
  ['events', 'event'],
  ['recipes', 'recipe'],
  ['blends', 'spice blend'],
  ['ingredients', 'ingredient'],
  ['purchases', 'purchase', 'of real ingredients'],
  ['receipts', 'receipt'],
];

const MARKS = [2048, 4096];
const BATCH = 2; // photos per request: each takes a second or two to resample
const ACTION_WORD = { insert: 'Added', update: 'Changed', delete: 'Removed', restore: 'Restored' };

const TABS = [
  { id: 'backup', label: 'Backup & restore' },
  { id: 'storage', label: 'Storage & exports' },
  { id: 'environment', label: 'Environment' },
  { id: 'audit', label: 'Audit log' },
];

const HASH_TO_TAB = {
  '#backup': 'backup',
  '#snapshots': 'backup',
  '#storage': 'storage',
  '#compress-photos': 'storage',
  '#exports': 'storage',
  '#environment': 'environment',
  '#test-data': 'environment',
  '#alt-theme': 'environment',
  '#audit': 'audit',
  '#whos-who': 'audit',
  '#changes': 'audit',
};

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function bytes(n) {
  if (!n) return '0 KB';
  const units = ['bytes', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i < 2 ? 0 : 1)} ${units[i]}`;
}

function estimate(photos, side) {
  const over = photos.filter((p) => p.compressible && Math.max(p.width, p.height) > side);
  const before = over.reduce((n, p) => n + p.bytes, 0);
  const after = over.reduce((n, p) => n + p.bytes * (side / Math.max(p.width, p.height)) ** 2, 0);
  return { over, before, after: Math.round(after), saved: Math.round(before - after) };
}

const fieldValue = (v) => (v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Scoped layout styles for the alternate skin so cards, tabs, and meters align cleanly. */
function AltBackupStyles() {
  return (
    <style>{`
      .alt-backup-shell { display: flex; flex-direction: column; gap: 20px; }
      .alt-header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 16px; }
      .alt-header h1 { margin: 0 0 4px; }
      .alt-header p { margin: 0; max-width: 62ch; }

      .alt-tabs {
        display: flex; flex-wrap: wrap; gap: 4px; padding: 4px;
        background: var(--bg-subtle, rgba(127, 127, 127, 0.08));
        border: 1px solid var(--border, rgba(127, 127, 127, 0.18));
        border-radius: 12px; width: fit-content; max-width: 100%;
      }
      .alt-tab {
        appearance: none; border: 0; background: transparent; color: inherit;
        font: inherit; font-weight: 500; font-size: 0.92rem;
        padding: 8px 14px; border-radius: 8px; cursor: pointer;
        display: inline-flex; align-items: center; gap: 8px;
        opacity: 0.75; transition: background 0.15s ease, opacity 0.15s ease;
      }
      .alt-tab:hover { opacity: 1; background: rgba(127, 127, 127, 0.08); }
      .alt-tab[aria-selected="true"] {
        opacity: 1; font-weight: 600;
        background: var(--panel-bg, #fff);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08), 0 0 0 1px var(--border, rgba(127, 127, 127, 0.15));
      }
      .alt-tab-pill {
        font-size: 0.75rem; font-weight: 600; padding: 1px 7px; border-radius: 999px;
        background: rgba(127, 127, 127, 0.14);
      }

      .alt-stat-strip {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(125px, 1fr)); gap: 10px;
      }
      .alt-stat {
        padding: 12px 14px; border-radius: 10px;
        border: 1px solid var(--border, rgba(127, 127, 127, 0.18));
        background: var(--panel-bg, transparent);
      }
      .alt-stat-val { font-size: 1.25rem; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
      .alt-stat-lbl { font-size: 0.8rem; opacity: 0.7; margin-top: 2px; }

      .alt-two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; align-items: stretch; }
      .alt-card { display: flex; flex-direction: column; justify-content: space-between; gap: 16px; margin: 0; }
      .alt-card-top { display: flex; flex-direction: column; gap: 10px; }
      .alt-card h2 { margin: 0; font-size: 1.12rem; }
      .alt-card p { margin: 0; }

      .alt-dropzone {
        display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
        gap: 6px; padding: 20px 16px; border-radius: 10px; cursor: pointer;
        border: 1.5px dashed var(--border, rgba(127, 127, 127, 0.35));
        background: rgba(127, 127, 127, 0.03);
        transition: border-color 0.15s ease, background 0.15s ease;
      }
      .alt-dropzone:hover, .alt-dropzone.dragging {
        border-color: var(--accent, currentColor);
        background: rgba(127, 127, 127, 0.08);
      }

      .alt-meter {
        height: 8px; border-radius: 999px; overflow: hidden;
        background: rgba(127, 127, 127, 0.16);
      }
      .alt-meter-fill {
        height: 100%; border-radius: 999px;
        background: var(--accent, #2563eb);
        transition: width 0.2s ease;
      }

      .alt-export-item {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 14px 16px; border-radius: 10px;
        border: 1px solid var(--border, rgba(127, 127, 127, 0.18));
      }
      .alt-panel-toolbar {
        display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;
        padding: 16px 20px; border-bottom: 1px solid var(--border, rgba(127, 127, 127, 0.15));
      }
      .alt-panel-toolbar h2 { margin: 0; font-size: 1.12rem; }
    `}</style>
  );
}

/** Top summary strip showing live counts across the database. */
function SummaryStrip({ summary }) {
  if (!summary) return <div className="panel panel-pad"><Spinner /></div>;
  return (
    <div className="alt-stat-strip" aria-label="Current database totals">
      {ROWS.map(([key, label]) => (
        <div key={key} className="alt-stat">
          <div className="alt-stat-val">{summary.counts[key]}</div>
          <div className="alt-stat-lbl">{label}</div>
        </div>
      ))}
      <div className="alt-stat">
        <div className="alt-stat-val">{bytes(summary.imageBytes)}</div>
        <div className="alt-stat-lbl">Photo storage</div>
      </div>
    </div>
  );
}

/** Download a complete archive of all database records and photos. */
function BackupCard({ summary }) {
  const totalRecords = summary
    ? ROWS.reduce((sum, [key]) => sum + (key === 'images' ? 0 : (summary.counts[key] ?? 0)), 0)
    : null;

  return (
    <section className="panel panel-pad alt-card">
      <div className="alt-card-top">
        <h2>Export full backup</h2>
        <p className="muted">
          Packages your database and every original photo into a single portable <code>.tar.gz</code> archive. Nothing in the app changes.
        </p>
        {summary && (
          <p style={{ fontSize: '0.9rem' }}>
            Ready to archive <b>{count(totalRecords, 'record')}</b>, <b>{count(summary.counts.images, 'photo')}</b> ({bytes(summary.imageBytes)}), and up to 10 safety snapshots.
          </p>
        )}
      </div>
      <div>
        <a className="btn primary" href="/api/backup" download>
          <Icon.download /> Download .tar.gz backup
        </a>
      </div>
    </section>
  );
}

/** Inspect and restore from a previously downloaded backup archive. */
function RestoreCard({ current, onRestored }) {
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [checking, setChecking] = useState(false);
  const [backup, setBackup] = useState(null);
  const [agreed, setAgreed] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const toast = useToast();

  const choose = async (f) => {
    if (!f) return;
    setFile(f);
    setBackup(null);
    setAgreed(false);
    setDone(null);
    setError(null);
    setChecking(true);
    try {
      const fd = new FormData();
      fd.append('file', f, f.name);
      setBackup(await api('/backup/inspect', { method: 'POST', body: fd }));
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  };

  const restore = async () => {
    setRestoring(true);
    setError(null);
    try {
      const res = await api('/backup/restore', { method: 'POST', body: { token: backup.token } });
      setDone(res);
      setBackup(null);
      setFile(null);
      notifyDataChanged();
      onRestored();
      toast('Backup restored');
    } catch (err) {
      setError(err.message);
    } finally {
      setRestoring(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (!checking && !restoring && e.dataTransfer.files?.[0]) {
      choose(e.dataTransfer.files[0]);
    }
  };

  return (
    <section className="panel panel-pad alt-card">
      <div className="alt-card-top">
        <h2>Restore from backup</h2>
        <p className="muted">
          Replaces everything in the app with a backup file. You’ll review a side-by-side comparison before anything changes.
        </p>

        <label
          className={`alt-dropzone ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          {checking ? <Spinner /> : <Icon.upload />}
          <b>{file ? file.name : 'Choose a backup file or drop it here'}</b>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {file ? `${bytes(file.size)} — click to choose a different archive` : 'Accepts .tar.gz or .tgz archives'}
          </span>
          <input
            type="file"
            accept=".gz,.tgz,application/gzip"
            className="visually-hidden"
            disabled={checking || restoring}
            onChange={(e) => { choose(e.target.files[0]); e.target.value = ''; }}
          />
        </label>

        {error && <Notice kind="error">{error}</Notice>}

        {backup && (
          <>
            <p style={{ fontSize: '0.9rem' }}>
              Backup made <b>{dateTime(backup.createdAt)}</b>
              {backup.olderVersion ? ' (by an older version of the app)' : ''}.
            </p>
            <div className="table-wrap">
              <table className="grid">
                <thead>
                  <tr><th>Item</th><th className="num">In backup</th><th className="num">In app now</th></tr>
                </thead>
                <tbody>
                  {ROWS.map(([key, label]) => (
                    <tr key={key}>
                      <td>{label}</td>
                      <td className="num">{backup.counts[key]}</td>
                      <td className="num">{current?.[key] ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {backup.warnings.length > 0 && (
              <Notice>{backup.warnings.map((w) => <div key={w}>{w}</div>)}</Notice>
            )}
            <label className="agree">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              Replace everything in the app with this backup. A copy of current data is saved first.
            </label>
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              <button className="btn danger-solid" disabled={!agreed || restoring} onClick={restore}>
                {restoring && <Spinner />} Restore backup
              </button>
              <button className="btn ghost" onClick={() => { setBackup(null); setFile(null); }}>Cancel</button>
            </div>
          </>
        )}

        {done && (
          <Notice kind="success">
            Restored {count(done.counts.ingredients, 'ingredient')}, {count(done.counts.recipes, 'recipe')}, {count(done.counts.receipts, 'receipt')} and {count(done.counts.images, 'photo')}.
            Your previous data is saved under Automatic copies below.
          </Notice>
        )}
      </div>
    </section>
  );
}

/** Rolling list of the last 10 automatic safety snapshots. */
function SnapshotsCard({ snapshots }) {
  return (
    <section className="panel" id="snapshots">
      <div className="panel-head">
        <div>
          <h2>Automatic copies</h2>
          <p className="muted" style={{ margin: 0 }}>
            Saved automatically before every restore, test-data wipe, or photo compression. The last 10 are kept.
          </p>
        </div>
      </div>
      {snapshots?.length ? (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr><th>Trigger</th><th>Created</th><th className="num">Size</th><th><span className="visually-hidden">Download</span></th></tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.name}>
                  <td style={{ fontWeight: 550 }}>
                    {SNAPSHOT_LABELS.find(([prefix]) => s.name.startsWith(prefix))?.[1] ?? 'Before the restore'}
                  </td>
                  <td className="nowrap">{dateTime(s.createdAt)}</td>
                  <td className="num">{bytes(s.bytes)}</td>
                  <td className="num">
                    <a className="btn small" href={`/api/backup/snapshots/${encodeURIComponent(s.name)}`} download>
                      <Icon.download /> Download
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="panel-pad muted" style={{ margin: 0 }}>No automatic copies saved yet.</p>
      )}
    </section>
  );
}

/** Resample recipe and receipt photos down to a longest side, to save storage and backup size. */
function CompressPhotosCard({ onDone }) {
  const { data, error, reload } = useApi('/images/compress');
  const [side, setSide] = useState(2048);
  const [snapshot, setSnapshot] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState(null);
  const [runError, setRunError] = useState(null);
  const toast = useToast();

  if (error) {
    return (
      <section className="panel panel-pad alt-card" id="compress-photos">
        <h2>Compress photos</h2>
        <Notice kind="error">{error.message}</Notice>
      </section>
    );
  }

  const photos = data?.photos ?? [];
  const total = photos.reduce((n, p) => n + p.bytes, 0);
  const at = estimate(photos, side);
  const fixed = photos.filter((p) => !p.compressible).length;
  const pct = (e) => (e.before ? Math.round((e.saved / e.before) * 100) : 0);
  const remainingPct = total > 0 ? Math.max(4, Math.round(((total - at.saved) / total) * 100)) : 100;

  const run = async () => {
    setRunError(null);
    const ids = at.over.map((p) => p.id);
    setProgress({ done: 0, total: ids.length });
    let before = 0;
    let after = 0;
    try {
      if (snapshot) await api('/images/compress/snapshot', { method: 'POST' });
      for (let i = 0; i < ids.length; i += BATCH) {
        const { results } = await api('/images/compress', {
          method: 'POST',
          body: { maxSide: side, ids: ids.slice(i, i + BATCH) },
        });
        for (const r of results) {
          before += r.before ?? 0;
          after += r.after ?? r.before ?? 0;
        }
        setProgress({ done: Math.min(i + BATCH, ids.length), total: ids.length });
      }
      setConfirming(false);
      toast(`Compressed ${count(ids.length, 'photo')}, saving ${bytes(before - after)}`);
    } catch (err) {
      setRunError(err.message);
    } finally {
      setProgress(null);
      reload();
      onDone();
      notifyDataChanged();
    }
  };

  return (
    <section className="panel panel-pad alt-card" id="compress-photos">
      <div className="alt-card-top">
        <h2>Compress photos</h2>
        <p className="muted">
          Resamples recipe and receipt photos larger than your chosen dimension so backups stay lightweight. Smaller photos are untouched.
        </p>

        {!data ? <Spinner /> : (
          <>
            <div className="compress-marks">
              {MARKS.map((m) => {
                const e = estimate(photos, m);
                return (
                  <button
                    key={m}
                    type="button"
                    className={`compress-mark ${side === m ? 'on' : ''}`}
                    onClick={() => setSide(m)}
                  >
                    <b>{m} px max</b>
                    <span>{e.over.length ? `saves ~${bytes(e.saved)} (${pct(e)}%)` : 'already within limit'}</span>
                    <small className="muted">{count(e.over.length, 'photo')} affected</small>
                  </button>
                );
              })}
            </div>

            <div className="margin-slider compress-slider">
              <div className="margin-slider-head">
                <label htmlFor="compress-side">Maximum longest side</label>
                <output htmlFor="compress-side">{side} px</output>
              </div>
              <input
                id="compress-side"
                type="range"
                min={data.minSide}
                max={data.maxSide}
                step="256"
                value={side}
                list="compress-marks"
                onChange={(e) => setSide(Number(e.target.value))}
                style={{ '--fill': `${((side - data.minSide) / (data.maxSide - data.minSide)) * 100}%` }}
              />
              <datalist id="compress-marks">{MARKS.map((m) => <option key={m} value={m} />)}</datalist>
            </div>

            {total > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="alt-meter" title={`Projected photo footprint: ${bytes(total - at.saved)} of ${bytes(total)}`}>
                  <div className="alt-meter-fill" style={{ width: `${remainingPct}%` }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span>
                    {at.over.length
                      ? <><b>{count(at.over.length, 'photo')}</b> over {side} px: {bytes(at.before)} → ~{bytes(at.after)} (saves <b>{bytes(at.saved)}</b>)</>
                      : <>No photos are larger than {side} px.</>}
                  </span>
                  <span className="muted">Total library: {bytes(total)}</span>
                </div>
              </div>
            )}

            {fixed > 0 && (
              <small className="muted">{fixed} WebP or GIF {fixed === 1 ? 'photo is' : 'photos are'} skipped automatically.</small>
            )}
          </>
        )}
      </div>

      <div>
        <button className="btn primary" disabled={!at.over.length} onClick={() => setConfirming(true)}>
          Compress {count(at.over.length, 'photo')}
        </button>
      </div>

      {confirming && (
        <Modal title={`Compress ${count(at.over.length, 'photo')}?`} onClose={() => !progress && setConfirming(false)}>
          <p>
            Each photo larger than {side} px on its longest side is resampled down to {side} px and replaces the original. This can’t be undone except from a backup copy.
          </p>
          <label className="agree">
            <input type="checkbox" checked={snapshot} disabled={!!progress} onChange={(e) => setSnapshot(e.target.checked)} />
            Save a copy of everything first, under Automatic copies ({bytes(total)} of photos, plus the data)
          </label>
          {progress && (
            <div className="compress-progress">
              <progress max={progress.total} value={progress.done} />
              <small className="muted">{progress.done === 0 && snapshot ? 'Saving a copy…' : `${progress.done} of ${progress.total} done`}</small>
            </div>
          )}
          {runError && <Notice kind="error">{runError}</Notice>}
          <div className="form-actions">
            <button className="btn ghost" disabled={!!progress} onClick={() => setConfirming(false)}>Cancel</button>
            <button className="btn primary" disabled={!!progress} onClick={run}>{progress && <Spinner />} Compress</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** Human-readable CSV spreadsheets for external analysis. */
function ExportsCard() {
  return (
    <section className="panel panel-pad alt-card" id="exports">
      <div className="alt-card-top">
        <h2>Spreadsheet exports</h2>
        <p className="muted">
          Read-only CSV tables for Excel, Numbers, or Google Sheets. Use a full backup archive above if you want to restore data later.
        </p>
        <div className="alt-two-col" style={{ marginTop: 4 }}>
          <div className="alt-export-item">
            <div>
              <b>Ingredients catalog</b>
              <div className="muted" style={{ fontSize: '0.85rem' }}>Every ingredient with its latest recorded price</div>
            </div>
            <a className="btn" href="/api/export/ingredients.csv" download>
              <Icon.download /> CSV
            </a>
          </div>
          <div className="alt-export-item">
            <div>
              <b>Purchase history</b>
              <div className="muted" style={{ fontSize: '0.85rem' }}>Complete chronological ledger of every purchase</div>
            </div>
            <a className="btn" href="/api/export/purchases.csv" download>
              <Icon.download /> CSV
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Test mode on/off, and clearing everything added in test mode. */
function TestDataCard({ onCleared }) {
  const on = useTestMode();
  const { data, error, reload } = useApi('/test-data');
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState(null);
  const toast = useToast();

  const found = data ? TEST_ROWS.filter(([key]) => data.deleted[key] > 0) : [];
  const total = found.reduce((n, [key]) => n + data.deleted[key], 0);
  const kept = data ? [...data.kept.recipes, ...data.kept.blends, ...data.kept.ingredients] : [];

  const clear = async () => {
    setClearing(true);
    setClearError(null);
    try {
      const res = await api('/test-data/clear', { method: 'POST' });
      const n = Object.values(res.deleted).reduce((a, b) => a + b, 0);
      reload();
      onCleared?.();
      notifyDataChanged();
      setConfirming(false);
      toast(`Cleared ${count(n, 'test item')}. A copy from before is under Automatic copies.`);
    } catch (err) {
      setClearError(err.message);
    } finally {
      setClearing(false);
    }
  };

  return (
    <section className="panel panel-pad alt-card" id="test-data">
      <div className="alt-card-top">
        <h2>Test data & sandbox</h2>
        <label className="switch-row">
          <input type="checkbox" checked={on} onChange={(e) => setTestMode(e.target.checked)} />
          <span>
            <b>Test mode</b>
            <span className="muted" style={{ display: 'block' }}>
              Everything you add while active (ingredients, purchases, receipts, recipes, blends, events) is tagged <span className="badge test">Test</span>. Applies to this browser only.
            </span>
          </span>
        </label>

        {error && <Notice kind="error">{error.message}</Notice>}

        {data && (total ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: '0.9rem' }}>Queued for cleanup:</span>
            <div className="test-counts">
              {found.map(([key, word, note]) => (
                <span key={key} className="badge">
                  {count(data.deleted[key], word)}{note ? ` ${note}` : ''}
                </span>
              ))}
            </div>
            {kept.length > 0 && (
              <small className="muted">
                Kept because real data uses them: {kept.join(', ')}. They stay marked as test until nothing real references them.
              </small>
            )}
          </div>
        ) : (
          <p className="muted">
            {kept.length ? `Only test items referenced by real data remain: ${kept.join(', ')}.` : 'No test data is currently stored.'}
          </p>
        ))}
      </div>

      <div>
        <button className="btn danger" disabled={!total} onClick={() => setConfirming(true)}>
          <Icon.trash /> Clear {total ? count(total, 'test item') : 'test data'}
        </button>
      </div>

      {confirming && (
        <Modal title="Clear test data?" onClose={() => !clearing && setConfirming(false)}>
          <p>
            This deletes {count(total, 'test item')}, along with their price history and photos. A copy of everything as it is now is saved under Automatic copies first, so you can restore it.
          </p>
          {clearError && <Notice kind="error">{clearError}</Notice>}
          <div className="form-actions">
            <button className="btn ghost" disabled={clearing} onClick={() => setConfirming(false)}>Keep it</button>
            <button className="btn danger-solid" disabled={clearing} onClick={clear}>{clearing && <Spinner />} Clear test data</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** Switches the alternate theme (`skins/alt/`: its own app and styles) for this browser. */
function AltThemeCard() {
  const on = useSkin() === 'alt';
  return (
    <section className="panel panel-pad alt-card" id="alt-theme">
      <div className="alt-card-top">
        <h2>Appearance</h2>
        <label className="switch-row">
          <input type="checkbox" checked={on} onChange={(e) => setSkin(e.target.checked ? 'alt' : 'default')} />
          <span>
            <b>Alternate theme</b>
            <span className="muted" style={{ display: 'block' }}>
              A completely different look and layout for the whole app, still in testing. Applies to this browser only.
            </span>
          </span>
        </label>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Recovery tip: if an experimental layout ever hides this toggle, append <code>?skin=default</code> to the page URL to revert immediately.
        </p>
      </div>
    </section>
  );
}

/** The character each address goes by. */
function WhosWhoCard() {
  const { data, error } = useApi('/audit/actors');
  return (
    <section className="panel" id="whos-who">
      <div className="panel-head">
        <div>
          <h2>Who’s who</h2>
          <p className="muted" style={{ margin: 0 }}>
            Each network that changes something gets a character, so everyone on one home network shares a name, and a phone away from home has another. It tells you the connection, not the person.
          </p>
        </div>
      </div>
      {error && <Notice kind="error">{error.message}</Notice>}
      {data && (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr><th>Character</th><th>Network</th><th className="num">Changes</th><th>Last change</th><th>First seen</th></tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.name}>
                  <td style={{ fontWeight: 650 }}>{a.name}</td>
                  <td className={a.ip ? '' : 'muted'}>{a.ip ?? 'Manual database changes'}</td>
                  <td className="num">{a.changes}</td>
                  <td>{a.lastChange ? dateTime(a.lastChange) : '—'}</td>
                  <td>{a.ip ? dateTime(a.firstSeen) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** What one save did: a line per kind of thing, opening to each row and its fields. */
function SaveChanges({ changes }) {
  const kinds = new Map();
  for (const c of changes) {
    const key = `${ACTION_WORD[c.action]} ${c.label.toLowerCase()}`;
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
  }
  const line = [...kinds].map(([k, n]) => (n > 1 ? `${k} × ${n}` : k)).join(', ');
  return (
    <details className="change-line">
      <summary>{line}</summary>
      <ul>
        {changes.map((c, i) => (
          <li key={i}>
            <b>{ACTION_WORD[c.action]} {c.label.toLowerCase()}{c.name ? `: ${c.name}` : ''}</b>
            {c.fields.length > 0 && (
              <div className="change-fields">
                {c.fields.map((f) => (c.action === 'update'
                  ? `${f.field}: ${fieldValue(f.from)} → ${fieldValue(f.to)}`
                  : `${f.field}: ${fieldValue(c.action === 'delete' ? f.from : f.to)}`)).join(' · ')}
              </div>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Every change to the data, newest first, loaded on demand when the Audit tab is viewed. */
function ChangesCard() {
  const [saves, setSaves] = useState([]);
  const [next, setNext] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [deletedOnly, setDeletedOnly] = useState(false);
  const asked = useRef(0);

  const load = async (before) => {
    const ask = ++asked.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        ...(before ? { before } : {}),
        ...(deletedOnly ? { only: 'deleted' } : {}),
      });
      const page = await api(`/audit/changes?${params}`);
      if (ask !== asked.current) return;
      setSaves((s) => (before ? [...s, ...page.saves] : page.saves));
      setNext(page.next);
    } catch (err) {
      setError(err.message);
    } finally {
      if (ask === asked.current) setLoading(false);
    }
  };

  useEffect(() => { load(); }, [deletedOnly]);

  return (
    <section className="panel changes-log" id="changes">
      <div className="alt-panel-toolbar">
        <div>
          <h2>Database changes</h2>
          <p className="muted" style={{ margin: 0, fontSize: '0.9rem' }}>
            Every saved edit, addition, or deletion across the database, newest first.
          </p>
        </div>
        <label className="changes-filter" style={{ margin: 0 }}>
          <input type="checkbox" checked={deletedOnly} onChange={(e) => setDeletedOnly(e.target.checked)} /> Only what was deleted
        </label>
      </div>

      {error && <div className="panel-pad"><Notice kind="error">{error}</Notice></div>}
      {loading && !saves.length && <div className="changes-more"><Spinner /></div>}
      {!loading && !error && !saves.length && !next && (
        <p className="muted changes-more">{deletedOnly ? 'Nothing deleted since tracking began.' : 'No changes recorded yet.'}</p>
      )}
      {saves.length > 0 && (
        <div className="table-wrap">
          <table className="grid">
            <thead><tr><th>When</th><th>Who</th><th>What changed</th></tr></thead>
            <tbody>
              {saves.map((s) => (
                <tr key={s.id}>
                  <td className="nowrap">{dateTime(s.at)}</td>
                  <td className="nowrap" style={{ fontWeight: 650 }}>
                    {s.actor}
                    {s.test && <span className="badge" style={{ marginLeft: 6 }}>Test</span>}
                  </td>
                  <td><SaveChanges changes={s.changes} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <div className="changes-more">
          <button className="btn small" disabled={loading} onClick={() => load(next)}>
            {loading ? 'Loading…' : 'Show older changes'}
          </button>
        </div>
      )}
    </section>
  );
}

export default function BackupPage() {
  const { data: summary, error, reload } = useApi('/backup/summary');
  const testMode = useTestMode();
  const [tab, setTab] = useState(() => HASH_TO_TAB[window.location.hash] ?? 'backup');

  useEffect(() => {
    const onHashChange = () => {
      const mapped = HASH_TO_TAB[window.location.hash];
      if (mapped) setTab(mapped);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const selectTab = (id) => {
    setTab(id);
    if (window.history?.replaceState) {
      window.history.replaceState(null, '', `#${id}`);
    }
  };

  return (
    <main className="page alt-backup-shell">
      <AltBackupStyles />

      <header className="alt-header">
        <div>
          <h1>Backup &amp; system</h1>
          <p className="muted">
            Manage full-app archives, photo storage, CSV exports, test data, and the database audit log.
          </p>
        </div>
        {testMode && (
          <span className="badge test" style={{ alignSelf: 'center' }}>
            Test mode active
          </span>
        )}
      </header>

      <nav className="alt-tabs" role="tablist" aria-label="System and backup sections">
        {TABS.map((t) => {
          const badge =
            t.id === 'backup' && summary?.snapshots?.length ? summary.snapshots.length :
            t.id === 'environment' && testMode ? 'Test' : null;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              className="alt-tab"
              aria-selected={tab === t.id}
              onClick={() => selectTab(t.id)}
            >
              {t.label}
              {badge !== null && <span className="alt-tab-pill">{badge}</span>}
            </button>
          );
        })}
      </nav>

      {error && <Notice kind="error">{error.message}</Notice>}

      {tab === 'backup' && (
        <>
          <SummaryStrip summary={summary} />
          <div className="alt-two-col">
            <BackupCard summary={summary} />
            <RestoreCard current={summary?.counts} onRestored={reload} />
          </div>
          <SnapshotsCard snapshots={summary?.snapshots} />
        </>
      )}

      {tab === 'storage' && (
        <>
          <CompressPhotosCard onDone={reload} />
          <ExportsCard />
        </>
      )}

      {tab === 'environment' && (
        <div className="alt-two-col">
          <TestDataCard onCleared={reload} />
          <AltThemeCard />
        </div>
      )}

      {tab === 'audit' && (
        <>
          <WhosWhoCard />
          <ChangesCard />
        </>
      )}
    </main>
  );
}
