import { useState } from 'react';
import { api, notifyDataChanged, setTestMode } from '../api.js';
import { useApi, useTestMode } from '../hooks.js';
import { dateTime } from '../format.js';
import { Icon, Modal, Notice, Spinner, useToast } from '../components/ui.jsx';

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

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function bytes(n) {
  if (!n) return '0 KB';
  const units = ['bytes', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i < 2 ? 0 : 1)} ${units[i]}`;
}

export default function BackupPage() {
  const { data: summary, error, reload } = useApi('/backup/summary');

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Backup and restore</h1>
          <p>One file holds everything: ingredients and price history, receipt names, receipts, recipes, events and all photos.</p>
        </div>
      </div>
      {error && <Notice kind="error">{error.message}</Notice>}

      <div className="backup-grid">
        <section className="panel panel-pad backup-card">
          <h2>Back up</h2>
          <p className="muted">Downloads a .tar.gz file you can keep anywhere. Nothing in the app changes.</p>
          {summary ? (
            <dl className="backup-counts">
              {ROWS.map(([key, label]) => (
                <div key={key}><dt>{label}</dt><dd>{summary.counts[key]}</dd></div>
              ))}
              <div><dt>Photo storage</dt><dd>{bytes(summary.imageBytes)}</dd></div>
            </dl>
          ) : <Spinner />}
          <div>
            <a className="btn primary" href="/api/backup" download><Icon.download /> Download backup</a>
          </div>
        </section>

        <RestoreCard current={summary?.counts} onRestored={reload} />
      </div>

      <section className="panel panel-pad backup-card">
        <h2>Spreadsheets</h2>
        <p className="muted">For Excel, Numbers or Google Sheets. These are copies to read; a backup file is what restores.</p>
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <a className="btn" href="/api/export/ingredients.csv" download title="Every ingredient with its latest price, as a spreadsheet file"><Icon.download /> Ingredients CSV</a>
          <a className="btn" href="/api/export/purchases.csv" download title="Every purchase ever recorded, as a spreadsheet file"><Icon.download /> Price history CSV</a>
        </div>
      </section>

      <CompressPhotosCard onDone={reload} />

      <TestDataCard />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Automatic copies</h2>
            <p className="muted">Before every restore, clearing of test data or photo compression, what was in the app is saved here first. The last 10 are kept.</p>
          </div>
        </div>
        {summary?.snapshots.length ? (
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Saved</th><th className="num">Size</th><th><span className="visually-hidden">Download</span></th></tr></thead>
              <tbody>
                {summary.snapshots.map((s) => (
                  <tr key={s.name}>
                    <td>{SNAPSHOT_LABELS.find(([prefix]) => s.name.startsWith(prefix))?.[1] ?? 'Before the restore'} on {dateTime(s.createdAt)}</td>
                    <td className="num">{bytes(s.bytes)}</td>
                    <td className="num"><a className="btn small" href={`/api/backup/snapshots/${encodeURIComponent(s.name)}`} download>Download</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="panel-pad muted">None yet.</p>
        )}
      </section>
    </main>
  );
}

const SNAPSHOT_LABELS = [
  ['before-clearing-test-data', 'Before clearing test data'],
  ['before-compressing-photos', 'Before compressing photos'],
  ['before-restore', 'Before the restore'],
];

/** Longest sides marked on the slider, each with what it would save. */
const MARKS = [2048, 4096];
const BATCH = 2; // photos per request: each takes a second or two to resample

/**
 * What resampling the photos larger than `side` (longest side, px) would save. JPEG size goes
 * roughly with the pixel count, so each is estimated as its bytes × (side / longest side)²;
 * re-encoding usually saves a little more.
 */
function estimate(photos, side) {
  const over = photos.filter((p) => p.compressible && Math.max(p.width, p.height) > side);
  const before = over.reduce((n, p) => n + p.bytes, 0);
  const after = over.reduce((n, p) => n + p.bytes * (side / Math.max(p.width, p.height)) ** 2, 0);
  return { over, before, after: Math.round(after), saved: Math.round(before - after) };
}

/** Resample recipe and receipt photos down to a longest side, to save storage and backup size. */
function CompressPhotosCard({ onDone }) {
  const { data, error, reload } = useApi('/images/compress');
  const [side, setSide] = useState(2048);
  const [snapshot, setSnapshot] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total }
  const [runError, setRunError] = useState(null);
  const toast = useToast();

  if (error) return <section className="panel panel-pad backup-card"><h2>Compress photos</h2><Notice kind="error">{error.message}</Notice></section>;
  const photos = data?.photos ?? [];
  const total = photos.reduce((n, p) => n + p.bytes, 0);
  const at = estimate(photos, side);
  const fixed = photos.filter((p) => !p.compressible).length;
  const pct = (e) => (e.before ? Math.round((e.saved / e.before) * 100) : 0);

  const run = async () => {
    setRunError(null);
    const ids = at.over.map((p) => p.id);
    setProgress({ done: 0, total: ids.length });
    let before = 0;
    let after = 0;
    try {
      if (snapshot) await api('/images/compress/snapshot', { method: 'POST' });
      for (let i = 0; i < ids.length; i += BATCH) {
        const { results } = await api('/images/compress', { method: 'POST', body: { maxSide: side, ids: ids.slice(i, i + BATCH) } });
        for (const r of results) { before += r.before ?? 0; after += r.after ?? r.before ?? 0; }
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
    <section className="panel panel-pad backup-card" id="compress-photos">
      <h2>Compress photos</h2>
      <p className="muted">
        Resamples recipe and receipt photos larger than the size you pick, so they take less space and backups get smaller.
        Smaller photos are left as they are.
      </p>
      {!data ? <Spinner /> : (
        <>
          <div className="margin-slider compress-slider">
            <div className="margin-slider-head">
              <label htmlFor="compress-side">Longest side, at most</label>
              <output htmlFor="compress-side">{side} px</output>
            </div>
            <input id="compress-side" type="range" min={data.minSide} max={data.maxSide} step="256" value={side} list="compress-marks"
              onChange={(e) => setSide(Number(e.target.value))}
              style={{ '--fill': `${((side - data.minSide) / (data.maxSide - data.minSide)) * 100}%` }} />
            <datalist id="compress-marks">{MARKS.map((m) => <option key={m} value={m} />)}</datalist>
          </div>
          <div className="compress-marks">
            {MARKS.map((m) => {
              const e = estimate(photos, m);
              return (
                <button key={m} type="button" className={`compress-mark ${side === m ? 'on' : ''}`} onClick={() => setSide(m)}>
                  <b>{m} px</b>
                  <span>{e.over.length ? `saves about ${bytes(e.saved)} (${pct(e)}%)` : 'nothing to do'}</span>
                  <small className="muted">{count(e.over.length, 'photo')}</small>
                </button>
              );
            })}
          </div>
          <p>
            {at.over.length
              ? <><b>{count(at.over.length, 'photo')}</b> larger than {side} px: {bytes(at.before)} now, about {bytes(at.after)} after, saving about <b>{bytes(at.saved)}</b> ({pct(at)}%).</>
              : <>No photo is larger than {side} px.</>}
            {' '}<span className="muted">All {count(photos.length, 'photo')}: {bytes(total)}.{fixed > 0 && ` ${fixed} WebP or GIF ${fixed === 1 ? 'photo isn’t' : 'photos aren’t'} compressed.`}</span>
          </p>
          <div>
            <button className="btn" disabled={!at.over.length} onClick={() => setConfirming(true)}>Compress {count(at.over.length, 'photo')}</button>
          </div>
        </>
      )}
      {confirming && (
        <Modal title={`Compress ${count(at.over.length, 'photo')}?`} onClose={() => !progress && setConfirming(false)}>
          <p>Each photo larger than {side} px on its longest side is resampled down to it and replaces the original. This can’t be undone except from a copy.</p>
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

const TEST_ROWS = [
  ['events', 'event'],
  ['recipes', 'recipe'],
  ['blends', 'spice blend'],
  ['ingredients', 'ingredient'],
  ['purchases', 'purchase', 'of real ingredients'],
  ['receipts', 'receipt'],
];

/** Test mode on/off, and clearing everything added in test mode. */
function TestDataCard() {
  const on = useTestMode();
  const { data, error } = useApi('/test-data');
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
    <section className="panel panel-pad backup-card" id="test-data">
      <h2>Test data</h2>
      <label className="switch-row">
        <input type="checkbox" checked={on} onChange={(e) => setTestMode(e.target.checked)} />
        <span>
          <b>Test mode</b>
          <span className="muted" style={{ display: 'block' }}>
            While it’s on, everything you add (ingredients, purchases, receipts, recipes, spice blends, events) is marked <span className="badge test">Test</span>. Turn it off and new things are real data again. It applies to this browser only.
          </span>
        </span>
      </label>
      {error && <Notice kind="error">{error.message}</Notice>}
      {data && (total ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span>Clearing removes:</span>
          <div className="test-counts">
            {found.map(([key, word, note]) => <span key={key} className="badge">{count(data.deleted[key], word)}{note ? ` ${note}` : ''}</span>)}
          </div>
          {kept.length > 0 && (
            <small className="muted">Kept because real data uses them: {kept.join(', ')}. They stay marked as test and go once nothing real needs them.</small>
          )}
        </div>
      ) : (
        <p className="muted">{kept.length ? `Only test items that real data uses are left: ${kept.join(', ')}.` : 'There’s no test data.'}</p>
      ))}
      <div>
        <button className="btn danger" disabled={!total} onClick={() => setConfirming(true)}><Icon.trash /> Clear test data</button>
      </div>
      {confirming && (
        <Modal title="Clear test data?" onClose={() => !clearing && setConfirming(false)}>
          <p>This deletes {count(total, 'test item')}, along with their price history and photos. A copy of everything as it is now is saved under Automatic copies first, so you can restore it.</p>
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

function RestoreCard({ current, onRestored }) {
  const [file, setFile] = useState(null);
  const [checking, setChecking] = useState(false);
  const [backup, setBackup] = useState(null); // inspected summary, with token
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

  return (
    <section className="panel panel-pad backup-card">
      <h2>Restore</h2>
      <p className="muted">Replaces everything in the app with the contents of a backup file. You’ll see what’s in it before anything changes.</p>
      <label className="btn" style={{ alignSelf: 'flex-start' }}>
        {checking ? <Spinner /> : <Icon.upload />} {file ? 'Choose a different file' : 'Choose backup file'}
        <input type="file" accept=".gz,.tgz,application/gzip" className="visually-hidden" disabled={checking || restoring}
          onChange={(e) => { choose(e.target.files[0]); e.target.value = ''; }} />
      </label>
      {file && <p className="muted">{file.name} ({bytes(file.size)})</p>}
      {error && <Notice kind="error">{error}</Notice>}

      {backup && (
        <>
          <p>Backup made {dateTime(backup.createdAt)}{backup.olderVersion ? ' by an older version of the app' : ''}.</p>
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Item</th><th className="num">In backup</th><th className="num">In app now</th></tr></thead>
              <tbody>
                {ROWS.map(([key, label]) => (
                  <tr key={key}><td>{label}</td><td className="num">{backup.counts[key]}</td><td className="num">{current?.[key] ?? '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {backup.warnings.length > 0 && <Notice>{backup.warnings.map((w) => <div key={w}>{w}</div>)}</Notice>}
          <label className="agree">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            Replace everything in the app with this backup. A copy of the current data is saved first.
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
          The previous data is listed under Automatic copies.
        </Notice>
      )}
    </section>
  );
}
