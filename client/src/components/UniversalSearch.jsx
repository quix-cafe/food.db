import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api.js';
import { useClickOutside, useDebounced } from '../hooks.js';
import { date } from '../format.js';
import { Icon } from './ui.jsx';

const GROUPS = [
  ['ingredients', 'Ingredients', (r) => `/ingredients?open=${r.id}`, (r) => r.category],
  ['recipes', 'Recipes', (r) => `/recipes/${r.id}`, (r) => `${r.baseServings} servings`],
  ['events', 'Events', (r) => `/events/${r.id}`, (r) => date(r.date)],
];

export default function UniversalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState(null);
  const [active, setActive] = useState(0);
  const debounced = useDebounced(q, 220);
  const navigate = useNavigate();
  const ref = useRef(null);
  const listId = useId();

  useEffect(() => {
    if (!debounced.trim()) return setResults(null);
    let stale = false;
    api(`/search?q=${encodeURIComponent(debounced.trim())}`).then((r) => !stale && setResults(r)).catch(() => {});
    return () => { stale = true; };
  }, [debounced]);

  useClickOutside(ref, () => setOpen(false));

  const flat = results ? GROUPS.flatMap(([key, , href, meta]) => results[key].map((r) => ({ ...r, key, href: href(r), meta: meta(r) }))) : [];
  useEffect(() => setActive(0), [results]);

  const go = (item) => {
    navigate(item.href);
    setOpen(false);
    setQ('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && flat[active]) go(flat[active]);
    else if (e.key === 'Escape') setOpen(false);
  };

  let i = -1;
  return (
    <div className="search" ref={ref}>
      <Icon.search />
      <input
        className="input"
        type="search"
        role="combobox"
        aria-label="Search ingredients, recipes and events"
        aria-expanded={open && !!results}
        aria-controls={listId}
        aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined}
        placeholder="Search ingredients, recipes, events"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && results && (
        <div className="popover" role="listbox" id={listId}>
          {flat.length === 0 && <div className="option muted">Nothing matches “{debounced}”</div>}
          {GROUPS.map(([key, label]) =>
            results[key].length ? (
              <div key={key} role="group" aria-label={label}>
                <div className="popover-group">{label}</div>
                {results[key].map((r) => {
                  i += 1;
                  const item = flat[i];
                  const idx = i;
                  return (
                    <div key={r.id} id={`${listId}-${idx}`} role="option" aria-selected={idx === active} className="option"
                      onMouseDown={(e) => { e.preventDefault(); go(item); }} onMouseEnter={() => setActive(idx)}>
                      <span>{r.name}</span>
                      <small>{item.meta}</small>
                    </div>
                  );
                })}
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
