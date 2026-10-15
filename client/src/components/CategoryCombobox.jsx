import { useEffect, useId, useState } from 'react';
import { api } from '../api.js';

/**
 * Free-text category with suggestions from the categories already in use. Typing filters
 * them (matches at the start of a word first); leaving the field snaps a case-only
 * variant ("produce") to the existing spelling ("Produce") so categories don't split.
 * `onChange` receives the new text.
 */
export default function CategoryCombobox({ value, onChange, ariaLabel, placeholder = 'e.g. Produce', disabled, style }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [all, setAll] = useState([]);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    let stale = false;
    api('/ingredients/categories').then((rows) => !stale && setAll(rows)).catch(() => {});
    return () => { stale = true; };
  }, [open]);

  const q = value.trim().toLowerCase();
  const exact = all.find((c) => c.toLowerCase() === q);
  // An exact match shows every category, so a filled-in field still offers the others.
  const options = !q || exact
    ? all
    : all
      .filter((c) => c.toLowerCase().includes(q))
      .sort((a, b) => wordStart(b, q) - wordStart(a, q) || a.localeCompare(b));

  useEffect(() => setActive(-1), [q, open]);

  const pick = (c) => {
    onChange(c);
    setOpen(false);
  };
  const settle = () => {
    setOpen(false);
    if (exact && exact !== value) onChange(exact);
    else if (value !== value.trim()) onChange(value.trim());
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)); }
    else if (e.key === 'Enter' && open && options[active]) { e.preventDefault(); pick(options[active]); }
    else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
  };

  const show = open && options.length > 0;
  return (
    <div className="combo" style={style}>
      <input
        className="input"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={show}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={show && options[active] ? `${listId}-${active}` : undefined}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={settle}
        onKeyDown={onKeyDown}
      />
      {show && (
        <div className="popover" role="listbox" id={listId}>
          {options.map((c, i) => (
            <div
              key={c}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className="option"
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{c}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const wordStart = (c, q) => (c.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) ? 1 : 0);
