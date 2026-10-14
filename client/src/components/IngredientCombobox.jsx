import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api.js';
import { useDebounced } from '../hooks.js';
import { unitMoney } from '../format.js';

/**
 * Searchable combobox over the master ingredient list.
 * - `value` / `onInput`: the typed text (controlled)
 * - `onPick(ingredient)`: called when an existing ingredient is chosen
 * - `exclude`: ingredient ids to hide (e.g. already on the recipe)
 * - `autoHighlight`: pre-select the first option so Enter picks it; when false, Enter with
 *   nothing highlighted calls `onCommit` (keep the typed text) and Escape calls `onCancel`
 */
export default function IngredientCombobox({ value, onInput, onPick, exclude = [], placeholder = 'Search ingredients…', ariaLabel, autoFocus, footer, autoHighlight = true, onCommit, onCancel, onBlur, selectOnFocus }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [options, setOptions] = useState([]);
  const q = useDebounced(value, 180);
  const listId = useId();
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    api(`/ingredients${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`)
      .then((rows) => !stale && setOptions(rows.filter((r) => !exclude.includes(r.id)).slice(0, 12)))
      .catch(() => !stale && setOptions([]));
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open, exclude.join()]);

  const first = autoHighlight ? 0 : -1;
  useEffect(() => setActive(first), [options, first]);

  useEffect(() => {
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const pick = (opt) => {
    onPick(opt);
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, first)); }
    else if (e.key === 'Enter' && open && options[active]) { e.preventDefault(); pick(options[active]); }
    else if (e.key === 'Enter' && onCommit) { e.preventDefault(); onCommit(); }
    else if (e.key === 'Escape') { setOpen(false); onCancel?.(); }
  };

  return (
    <div className="combo" ref={ref}>
      <input
        className="input"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => { onInput(e.target.value); setOpen(true); }}
        onFocus={(e) => { setOpen(true); if (selectOnFocus) e.target.select(); }}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
      {open && (options.length > 0 || footer) && (
        <div className="popover" role="listbox" id={listId}>
          {options.map((o, i) => (
            <div
              key={o.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className="option"
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{o.name}</span>
              <small>{o.latestUnitCost ? `${unitMoney(o.latestUnitCost)} / ${o.latestUnit ?? 'unit'}` : 'no price yet'}</small>
            </div>
          ))}
          {footer && footer(q, () => setOpen(false))}
        </div>
      )}
    </div>
  );
}
