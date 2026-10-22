import { useRef, useState } from 'react';
import IngredientCombobox from './IngredientCombobox.jsx';
import { Icon } from './ui.jsx';

/**
 * What ingredient a review row will be saved as. Row fields:
 *   source   — the name as the receipt printed it (never overwritten)
 *   keep     — true: use `source` (resolving via `resolved` if it's a known alias/name)
 *   name / ingredientId — the rename, when keep is false
 * A renamed row is saved with `source` as an alias, so the next import resolves it.
 */
export function rowTarget(r) {
  if (r.keep) {
    return r.resolved
      ? { kind: 'existing', id: r.resolved.id, name: r.resolved.name, uom: r.resolved.uom, via: r.resolved.via }
      : { kind: 'new', name: r.source, uom: r.uom || 'each' };
  }
  if (r.ingredientId) return { kind: 'existing', id: r.ingredientId, name: r.name, uom: r.ingredientUom, alias: true };
  return { kind: 'new', name: r.name.trim(), uom: r.uom || 'each', alias: !!r.source };
}

const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Click the name to rename it: type a new name or pick an existing ingredient. */
export default function ReceiptNameCell({ row, index, onChange }) {
  const target = rowTarget(row);
  const [editing, setEditing] = useState(!row.source); // manual lines start in edit mode
  const [draft, setDraft] = useState('');
  const settled = useRef(false); // guards against blur firing after Enter/pick/Escape

  const revert = { keep: true, name: '', ingredientId: null };

  const start = () => {
    settled.current = false;
    setDraft(target.name);
    setEditing(true);
  };
  const finish = (patch) => {
    if (settled.current) return;
    settled.current = true;
    if (patch) onChange(patch);
    setEditing(false);
  };
  // A rename ticks the row for saving; ReviewLinesTable unticks it if the row still has a problem.
  // Comparisons are exact so a capitalization fix counts as a rename.
  const commitText = () => {
    const text = draft.trim();
    if (!text) return row.source ? finish(revert) : undefined;
    if (text === target.name) return finish(null); // unchanged
    if (text === row.source) return finish(revert);
    if (row.resolved && same(text, row.resolved.name)) {
      // Recasing the ingredient the receipt already maps to: saving renames it.
      return finish({ keep: false, name: text, ingredientId: row.resolved.id, ingredientUom: row.resolved.uom, confirmed: true });
    }
    finish({ keep: false, name: text, ingredientId: null, confirmed: true });
  };
  const pick = (ing) => {
    if (row.source && row.resolved?.id === ing.id) return finish(revert); // what the receipt already maps to
    finish({ keep: false, name: ing.name, ingredientId: ing.id, ingredientUom: ing.uom, category: ing.category ?? row.category, confirmed: true });
  };

  const renamed = !row.keep;
  return (
    <div className="name-cell">
      {editing ? (
        <IngredientCombobox
          ariaLabel={`Ingredient name for line ${index + 1}`}
          value={draft}
          onInput={setDraft}
          onPick={pick}
          onCommit={commitText}
          onCancel={() => finish(null)}
          onBlur={commitText}
          autoHighlight={false}
          autoFocus
          selectOnFocus
          placeholder={row.source || 'Ingredient name'}
        />
      ) : (
        <button type="button" className="name-btn" onClick={start} aria-label={`Rename line ${index + 1}, currently ${target.name}`} title="Click to rename">
          <span>{target.name}</span>
          <Icon.pencil />
        </button>
      )}

      <div className="name-status">
        {target.kind === 'existing'
          ? <span className="badge good">In database</span>
          : target.name && <span className="badge new">New ingredient</span>}
        {row.source && row.source !== target.name && <span className="muted">Receipt: “{row.source}”</span>}
        {renamed && row.source && (
          <button type="button" className="link-btn" onClick={() => onChange(revert)}>Undo rename</button>
        )}
      </div>

      {!renamed && !row.resolved && row.choices?.length > 0 && !editing && (
        <div className="name-status">
          <span className="muted">
            {row.ambiguous === 'receipt' ? 'On several lines here' : `“${row.source}” has meant different items`}, so it isn’t matched automatically. Saved before as:
          </span>
          {row.choices.map((c) => (
            <button key={c.id} type="button" className="link-btn" onClick={() => onChange({ keep: false, name: c.name, ingredientId: c.id, ingredientUom: c.uom, category: c.category ?? row.category, confirmed: true })}>
              {c.name}{c.times > 1 ? ` (${c.times}×)` : ''}
            </button>
          ))}
        </div>
      )}
      {!renamed && !row.resolved && !row.choices?.length && row.suggestion && !editing && (
        <div className="name-status">
          <span className="muted">Similar to {row.suggestion.name}.</span>
          <button type="button" className="link-btn" onClick={() => onChange({ keep: false, name: row.suggestion.name, ingredientId: row.suggestion.id, ingredientUom: row.suggestion.uom, category: row.suggestion.category ?? row.category, confirmed: true })}>Use it</button>
        </div>
      )}
      {row.note && <div className="name-status muted">{row.note}</div>}
    </div>
  );
}
