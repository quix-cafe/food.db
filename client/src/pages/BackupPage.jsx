import { useState } from 'react';
import { api, notifyDataChanged } from '../api.js';
import { useApi } from '../hooks.js';
import { dateTime } from '../format.js';
import { Icon, Notice, Spinner, useToast } from '../components/ui.jsx';

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

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Automatic copies</h2>
            <p className="muted">Before every restore, what was in the app is saved here first. The last 10 are kept.</p>
          </div>
        </div>
        {summary?.snapshots.length ? (
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Saved</th><th className="num">Size</th><th><span className="visually-hidden">Download</span></th></tr></thead>
              <tbody>
                {summary.snapshots.map((s) => (
                  <tr key={s.name}>
                    <td>Before the restore on {dateTime(s.createdAt)}</td>
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
