// Categorical colors in fixed order (validated for color-vision deficiencies). An entity
// keeps its slot by position; anything past the last slot is shown as OTHER, never a new hue.
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const OTHER = '#8a969c';

/** Menu items' colors, boldly different hues in order around the wheel, so neighbors are the closest pair. */
const MENU_COLORS = ['#d9262c', '#f57c00', '#f4c20d', '#1a9e4b', '#00b5d8', '#2f73e8', '#8b3fe0', '#ec4aa0'];

/**
 * A color per menu item (`keys`: recipe ids, `blend:<id>` for sauces), the same on every screen that
 * shows the event. The colors spread around the wheel: in id order, each item takes the free slot
 * furthest from those taken, starting from where its id points, so order and position don't matter.
 * Changing what's on the menu can change other items' colors. Past the last slot items are OTHER.
 */
export function recipeColors(keys) {
  const n = MENU_COLORS.length;
  const slotOf = (key) => [...key].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7) % n;
  const apart = (a, b) => Math.min((a - b + n) % n, (b - a + n) % n);
  const taken = [];
  const crowding = (slot) => taken.reduce((sum, t) => sum + 1 / apart(slot, t) ** 2, 0);
  const colors = new Map();
  for (const key of [...keys].sort()) {
    const free = Array.from({ length: n }, (_, i) => (slotOf(key) + i) % n).filter((slot) => !taken.includes(slot));
    if (!free.length) { colors.set(key, OTHER); continue; }
    const slot = free.reduce((best, c) => (crowding(c) < crowding(best) ? c : best));
    taken.push(slot);
    colors.set(key, MENU_COLORS[slot]);
  }
  return colors;
}
