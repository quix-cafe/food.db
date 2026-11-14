import { useSyncExternalStore } from 'react';

// Which skin the app renders: 'default' or 'alt' (the alternate theme, in development under
// skins/alt/). Per browser: saved as `skin` in localStorage and mirrored on <html data-skin>,
// which index.html sets before the first paint (also from ?skin=alt / ?skin=default).
const listeners = new Set();

export const getSkin = () => (document.documentElement.dataset.skin === 'alt' ? 'alt' : 'default');

export function setSkin(skin) {
  const alt = skin === 'alt';
  try { localStorage.setItem('skin', alt ? 'alt' : ''); } catch { /* not remembered, still applied */ }
  if (alt) document.documentElement.dataset.skin = 'alt';
  else delete document.documentElement.dataset.skin;
  listeners.forEach((fn) => fn());
}

const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** The current skin; re-renders when it's switched. */
export const useSkin = () => useSyncExternalStore(subscribe, getSkin);

// A skin's own version of a component the default pages render themselves (the ingredient panel,
// opened from the recipe builder and the shopping list too). Registered when the skin's app loads.
const parts = {};
export const registerSkinPart = (name, Component) => { parts[name] = Component; };
/** The current skin's version of `name`, or null to use the default. */
export const useSkinPart = (name) => (useSkin() === 'alt' ? parts[name] ?? null : null);
