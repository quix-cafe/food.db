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

      <TestDataCard />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Automatic copies</h2>
            <p className="muted">Before every restore and every clearing of test data, what was in the app is saved here first. The last 10 are kept.</p>
          </div>
        </div>
        {summary?.snapshots.length ? (
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Saved</th><th className="num">Size</th><th><span className="visually-hidden">Download</span></th></tr></thead>
              <tbody>
                {summary.snapshots.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name.startsWith('before-clearing-test-data') ? 'Before clearing test data' : 'Before the restore'} on {dateTime(s.createdAt)}</td>
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
