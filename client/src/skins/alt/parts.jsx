// Pieces every page of the alternate app shares.
import { NavLink } from 'react-router';

/**
 * A date's dot color: one of the eight event-menu colors (`--dot-0` … `--dot-7`), the same for that
 * date everywhere. Each day steps three colors round the wheel, so neighbouring days, and a run of
 * Saturdays, all look different.
 */
const dotFor = (dt) => `c${(((Math.round(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()) / 86400000) * 3) % 8) + 8) % 8}`;

/** Today's day-dot color class. */
export const todayDot = () => dotFor(new Date());

/** 'YYYY-MM-DD' as a local date, never shifted by the time zone. */
export function parseDay(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const longDay = (iso) => parseDay(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
export const monthName = (iso) => parseDay(iso).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

/** A date as a kitchen day dot: the sticker that says which day something was made, its weekday and day of the month. */
export function DayDot({ iso, size = '' }) {
  if (!iso) return <span className={`daydot none ${size}`} aria-hidden="true" />;
  const dt = parseDay(iso);
  return (
    <span className={`daydot ${dotFor(dt)} ${size}`} title={longDay(iso)}>
      <small>{dt.toLocaleDateString('en-US', { weekday: 'short' })}</small>
      <b>{dt.getDate()}</b>
    </span>
  );
}

/** A section's name, written on a strip of masking tape. */
export const Tape = ({ children, as: As = 'h2' }) => <As className="tape"><span>{children}</span></As>;

export const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How far off a date is: "Today", "Tomorrow", "In 12 days", "3 days ago". */
export function daysAway(iso, today) {
  const days = Math.round((parseDay(iso) - parseDay(today)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return days > 0 ? `In ${days} days` : `${-days} days ago`;
}

export const KIND_LABEL = { market: 'Market', supper_club: 'Supper club', personal_chef: 'Personal chef job' };

/** Where a page sits: the areas above it as links, the page's own title being the heading under them. */
export function Crumbs({ trail }) {
  if (!trail?.length) return null;
  return (
    <nav className="alt-crumbs" aria-label="You are in">
      <ol>
        {trail.map(([label, to]) => <li key={to}><NavLink to={to} end>{label}</NavLink></li>)}
      </ol>
    </nav>
  );
}

/** The pages of one area, as a row of links under the main rail. */
export function SubNav({ label, items }) {
  return (
    <nav className="alt-subnav" aria-label={label}>
      {items.map((it) => <NavLink key={it.to} to={it.to} end={it.end}>{it.label}</NavLink>)}
    </nav>
  );
}

/** Pick one of a few: filter and sort choices. */
export function Segments({ label, value, onChange, options }) {
  return (
    <div className="alt-segments" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', width: 22, height: 22, viewBox: '0 0 24 24', 'aria-hidden': true };
export const AltIcon = {
  today: () => <svg {...stroke}><path d="M5 3h14v18l-2.3-1.5L14.3 21 12 19.5 9.7 21l-2.4-1.5L5 21z" /><path d="M9 8h6M9 12h6" /></svg>,
  events: () => <svg {...stroke}><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>,
  cookbook: () => <svg {...stroke}><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" /><path d="M5 17a3 3 0 0 1 3-3h11M9 8h6" /></svg>,
  pantry: () => <svg {...stroke}><path d="M7 3h10M8 3v3l-2 3v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9l-2-3V3" /><path d="M6 12h12" /></svg>,
  orders: () => <svg {...stroke}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9.5 8h5M9.5 12h5" /></svg>,
  gear: () => <svg {...stroke}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
};
