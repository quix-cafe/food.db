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
      ? { kind: 'existing', id: r.resolved.id, name: r.resolved.name, via: r.resolved.via }
      : { kind: 'new', name: r.source };
  }
  if (r.ingredientId) return { kind: 'existing', id: r.ingredientId, name: r.name, alias: true };
  return { kind: 'new', name: r.name.trim(), alias: !!r.source };
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
  const commitText = () => {
    const text = draft.trim();
    if (!row.source) return text ? finish({ keep: false, name: text, ingredientId: null }) : undefined;
    if (!text || same(text, row.source)) return finish(revert);
    if (same(text, target.name)) return finish(null); // unchanged
    finish({ keep: false, name: text, ingredientId: null });
  };
  const pick = (ing) => {
    if (row.source && row.resolved?.id === ing.id) return finish(revert); // what the receipt already maps to
    finish({ keep: false, name: ing.name, ingredientId: ing.id, category: ing.category ?? row.category });
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
        {row.source && !same(row.source, target.name) && <span className="muted">Receipt: “{row.source}”</span>}
        {renamed && row.source && (
          <button type="button" className="link-btn" onClick={() => onChange(revert)}>Undo rename</button>
        )}
      </div>

      {!renamed && !row.resolved && row.suggestion && !editing && (
        <div className="name-status">
          <span className="muted">Similar to {row.suggestion.name}.</span>
          <button type="button" className="link-btn" onClick={() => onChange({ keep: false, name: row.suggestion.name, ingredientId: row.suggestion.id, category: row.suggestion.category ?? row.category })}>Use it</button>
        </div>
      )}
      {row.note && <div className="name-status muted">{row.note}</div>}
    </div>
  );
}
