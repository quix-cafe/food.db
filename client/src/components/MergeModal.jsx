import { useEffect, useState } from 'react';
import { unitRatio } from '@kitchen/shared';
import { api, notifyDataChanged } from '../api.js';
import { useDebounced } from '../hooks.js';
import { money, perUnit, qty, toDecimal, unitMoney } from '../format.js';
import IngredientCombobox from './IngredientCombobox.jsx';
import { Field, Modal, Notice, Spinner, TestBadge, useToast } from './ui.jsx';

/**
 * Merge two ingredients that are one thing under two names. `first` is one of them and
 * `second` the other (null: pick it here); `keepId` is the suggested one to keep. The other
 * one's purchases, recipe lines, blend spices and receipt names move to the kept one, converted
 * into its unit. A dry run previews it, recipe costs included, before anything changes.
 */
export default function MergeModal({ first, second = null, keepId, reason, onClose, onMerged }) {
  const [other, setOther] = useState(second);
  const [search, setSearch] = useState('');
  const [keep, setKeep] = useState(keepId ?? second?.id ?? first.id);
  const [factorText, setFactorText] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const pair = other ? [first, other] : null;
  const kept = pair?.find((i) => i.id === keep) ?? null;
  const source = pair?.find((i) => i.id !== keep) ?? null;
  const auto = source && kept ? unitRatio(source.uom, kept.uom) : null;
  const typed = toDecimal(factorText);
  const factor = auto ? auto.toString() : typed?.gt(0) ? typed.toString() : null;
  const settled = useDebounced(factor, 300);

  useEffect(() => {
    setPreview(null);
    setError(null);
    if (!source || !factor || settled !== factor) return undefined;
    let stale = false;
    api(`/ingredients/${source.id}/merge`, { method: 'POST', body: { intoId: kept.id, factor, dryRun: true } })
      .then((p) => { if (!stale) setPreview(p); })
      .catch((err) => { if (!stale) setError(err.message); });
    return () => { stale = true; };
  }, [source?.id, kept?.id, factor, settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (id) => {
    setKeep(id);
    setFactorText(''); // the conversion flips with the direction
  };

  const merge = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await api(`/ingredients/${source.id}/merge`, { method: 'POST', body: { intoId: kept.id, factor } });
      notifyDataChanged();
      toast(`Merged ${result.merged.name} into ${result.kept.name}`);
      onMerged(result.kept.id);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title="Merge ingredients" onClose={onClose}>
      {reason && <p className="muted" style={{ margin: 0 }}>{reason}.</p>}

      {!pair ? (
        <Field label={`${first.name} is the same as`} hint="Pick the other ingredient. You choose which one to keep next.">
          <IngredientCombobox value={search} onInput={setSearch} exclude={[first.id]} autoFocus ariaLabel={`The ingredient ${first.name} is the same as`}
            onPick={(ing) => { setOther(ing); setKeep(ing.id); }} />
        </Field>
      ) : (
        <fieldset className="merge-choice">
          <legend>Keep which one?</legend>
          {pair.map((i) => (
            <label key={i.id} className="merge-card" data-kept={i.id === keep}>
              <input type="radio" name="merge-keep" checked={i.id === keep} onChange={() => choose(i.id)} />
              <span className="merge-card-body">
                <span><b>{i.name}</b> <TestBadge item={i} /></span>
                <span className="muted">{[i.uom, i.category].filter(Boolean).join(' · ')}</span>
                <span>
                  {i.latestUnitPrice ? perUnit(i.latestUnitPrice, i.uom) : 'No price yet'}
                  {i.purchaseCount != null && ` · ${i.purchaseCount} purchase${i.purchaseCount === 1 ? '' : 's'}`}
                </span>
                <small>{i.id === keep ? 'Kept: its name, unit and category stay' : `Merged in: “${i.name}” becomes a receipt name`}</small>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {source && !auto && (
        <Field label={`How many ${kept.uom} is 1 ${source.uom} of ${source.name}?`}
          hint={`${kept.name} is measured in ${kept.uom}. Pack sizes and recipe amounts are converted with this.`}>
          <span className="merge-factor">
            <span>1 {source.uom} =</span>
            <input className="input num" inputMode="decimal" value={factorText} autoFocus
              aria-invalid={factorText !== '' && !factor} onChange={(e) => setFactorText(e.target.value)} />
            <span>{kept.uom}</span>
          </span>
        </Field>
      )}
      {source && auto && !auto.eq(1) && <small className="muted">1 {source.uom} = {qty(auto, 6)} {kept.uom}, so amounts convert by themselves.</small>}

      {error && <Notice kind="error">{error}</Notice>}
      {source && factor && !preview && !error && <Spinner />}
      {preview && <MergePreview preview={preview} keptWasTest={kept.isTest} />}

      <div className="form-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!preview || saving} onClick={merge}>
          {source ? `Merge ${source.name} into ${kept.name}` : 'Merge'}
        </button>
      </div>
    </Modal>
  );
}

function MergePreview({ preview: p, keptWasTest }) {
  const amount = (value, uom) => `${qty(value, 4)} ${uom}`;
  const facts = [
    p.purchasesMoved
      ? `${p.purchasesMoved === 1 ? '1 purchase moves' : `${p.purchasesMoved} purchases move`} to ${p.kept.name}${p.factor === '1' ? '' : `, with pack sizes in ${p.kept.uom}`}.`
      : `${p.merged.name} has no purchases to move.`,
    keptWasTest && !p.kept.isTest && `${p.kept.name} becomes real data, since ${p.merged.name} is; clearing test data will keep it.`,
    p.priceAfter && (p.priceBefore && p.priceBefore !== p.priceAfter
      ? `${p.kept.name} will cost ${perUnit(p.priceAfter, p.kept.uom)}, the newest purchase of the two (now ${perUnit(p.priceBefore, p.kept.uom)}).`
      : `${p.kept.name} stays at ${perUnit(p.priceAfter, p.kept.uom)}.`),
    p.blends.length > 0 && `Spice blends now using ${p.kept.name}: ${p.blends.join(', ')}.`,
    p.events.length > 0 && `Shopping-list amounts move over in ${p.events.join(', ')}.`,
    p.aliasesAdded.length > 0 && `Receipts that say ${p.aliasesAdded.map((a) => `“${a}”`).join(', ')} will match ${p.kept.name}.`,
  ].filter(Boolean);
  const changed = (before, after, fmt) => (before === after ? fmt(after) : <>{fmt(before)} → <b>{fmt(after)}</b></>);

  return (
    <section className="merge-preview">
      <h3>What changes</h3>
      <ul>{facts.map((f) => <li key={f}>{f}</li>)}</ul>
      {p.recipes.length > 0 && (
        <div className="table-wrap">
          <table className="grid">
            <thead><tr><th>Recipe</th><th>Amount</th><th className="num">Cost / serving</th><th className="num">Price</th></tr></thead>
            <tbody>
              {p.recipes.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td className="muted">
                    {r.lines.length
                      ? `${r.lines.map((l) => `${amount(l.from, p.merged.uom)} → ${amount(l.to, p.kept.uom)}`).join(', ')}${r.combined ? `, joined with its ${p.kept.name} line` : ''}`
                      : 'Unchanged'}
                  </td>
                  <td className="num nowrap">{changed(r.costPerServingBefore, r.costPerServingAfter, unitMoney)}</td>
                  <td className="num nowrap">{changed(r.priceBefore, r.priceAfter, money)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Notice>{p.warnings.map((w) => <div key={w}>{w}</div>)}</Notice>
    </section>
  );
}
