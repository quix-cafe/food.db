// Who changed what: a character's name for each IP, and the changes audit_log's triggers recorded
// (see 001_schema.sql), put into words for the Backup page and the Sales tab.

import { randomInt } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { pool, query } from './db.js';

const QUALITIES = ['Copper', 'Velvet', 'Crimson', 'Silver', 'Golden', 'Midnight', 'Saffron', 'Ember', 'Juniper', 'Marble', 'Cobalt', 'Thistle', 'Paprika', 'Fennel', 'Rusty', 'Salty', 'Smoky', 'Peppery', 'Wandering', 'Sleepy', 'Clever', 'Dapper', 'Merry', 'Stormy'];
const CHARACTERS = ['Badger', 'Otter', 'Falcon', 'Heron', 'Fox', 'Marmot', 'Raven', 'Lynx', 'Wombat', 'Pangolin', 'Gecko', 'Magpie', 'Tapir', 'Ibis', 'Narwhal', 'Hedgehog', 'Wizard', 'Bard', 'Knight', 'Ranger', 'Alchemist', 'Pirate', 'Baker', 'Sous Chef'];
const pick = (list) => list[randomInt(list.length)];

/** Addresses the app is reached through rather than from: only these get to say who a request is for. */
export const isLocalProxy = (addr) => /^(::ffff:)?(127\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr) || addr === '::1';

const known = new Map();

/** The character a network goes by, given one the first time something on it changes something. */
/**
 * What a character goes with: a home network rather than one address, as devices rotate their IPv6
 * addresses. IPv6 goes by its /64 and private IPv4 by its /24. A public IPv4 is already a whole network.
 * Tailscale's addresses, and anything else that says where a device is rather than which, stay as they are:
 * every device on a tailnet shares one IPv6 range wherever it is.
 */
export function networkOf(rawIp) {
  const ip = String(rawIp ?? 'unknown').replace(/^::ffff:/, '').replace(/%.*$/, '').toLowerCase();
  if (isIPv4(ip)) return /^(10\.|192\.168\.)/.test(ip) ? `${ip.split('.').slice(0, 3).join('.')}.0/24` : ip;
  if (!isIPv6(ip) || /^(fd7a:115c:a1e0:|fe80:|::1$)/.test(ip)) return ip;
  const [head, tail = ''] = ip.split('::');
  const before = head ? head.split(':') : [];
  const after = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...before, ...Array(8 - before.length - after.length).fill('0'), ...after] : before;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export async function actorFor(rawIp) {
  const ip = networkOf(rawIp);
  const name = known.get(ip) ?? await assign(ip);
  known.set(ip, name);
  await pool.query('UPDATE actors SET last_seen = now() WHERE name = $1', [name]);
  return name;
}

async function assign(ip) {
  const { rows: [existing] } = await pool.query('SELECT name FROM actors WHERE ip = $1', [ip]);
  if (existing) return existing.name;
  for (let tries = 0; ; tries++) {
    const base = `${pick(QUALITIES)} ${pick(CHARACTERS)}`;
    const name = tries < 20 ? base : `${base} ${tries}`; // only once most of the names are taken
    const { rows: [added] } = await pool.query('INSERT INTO actors (name, ip) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING name', [name, ip]);
    if (added) return added.name;
    const { rows: [raced] } = await pool.query('SELECT name FROM actors WHERE ip = $1', [ip]);
    if (raced) return raced.name;
  }
}

/** Every character, with its address and how many changes it has made. */
export async function listActors() {
  const { rows } = await query(
    `SELECT a.name, a.ip, a.first_seen AS "firstSeen", a.last_seen AS "lastSeen", count(l.id)::int AS changes,
            max(l.at) AS "lastChange"
       FROM actors a LEFT JOIN audit_log l ON l.actor = a.name
      GROUP BY a.name ORDER BY count(l.id) DESC, a.first_seen`,
  );
  return rows;
}

const TABLE_LABELS = {
  ingredients: 'Ingredient', ingredient_aliases: 'Receipt name', ingredient_pair_dismissals: 'Not-a-duplicate pair', receipts: 'Receipt',
  ingredient_purchases: 'Purchase', receipt_lines: 'Receipt line', spice_blends: 'Blend or sauce', spice_blend_items: 'Blend item',
  recipes: 'Recipe', recipe_ingredients: 'Recipe line', events: 'Event', event_recipes: 'Event recipe', event_amounts: 'Event amount', event_packs: 'Packs to buy',
  event_blends: 'Event sauce', event_sales: 'Order', event_sale_items: 'Order line', images: 'Photo', backup: 'Backup',
};
// Bookkeeping that changes with every save, and says nothing on its own.
const QUIET = new Set(['id', 'version', 'created_at', 'updated_at', 'status_changed_at', 'is_test', 'last_seen']);
// Columns holding another row's id, shown by that row's name.
const REFERENCES = { recipe_id: 'recipes', ingredient_id: 'ingredients', blend_id: 'spice_blends', event_id: 'events', receipt_id: 'receipts', ingredient_a: 'ingredients', ingredient_b: 'ingredients', purchase_id: null, sale_id: null };

const shown = (row) => Object.fromEntries(Object.entries(row ?? {}).filter(([k, v]) => !QUIET.has(k) && v !== null));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function fieldsOf(oldRow, newRow) {
  const before = shown(oldRow);
  const after = shown(newRow);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => !same(before[k], after[k]))
    .map((field) => ({ field, from: before[field] ?? null, to: after[field] ?? null }));
}

/**
 * One save's rows as what actually changed. Saving an event's plan replaces its recipes wholesale,
 * so a delete and an insert of the same row in one save are one change, or none.
 */
function netChanges(rows) {
  const byRow = new Map();
  for (const r of rows) {
    const key = `${r.table_name}:${r.row_key}`;
    const seen = byRow.get(key);
    if (!seen) byRow.set(key, { table: r.table_name, oldRow: r.old_row, newRow: r.new_row, created: r.action === 'insert', action: r.action });
    else { seen.newRow = r.new_row; }
  }
  return [...byRow.values()].flatMap((c) => {
    if (c.action === 'restore') return [{ table: 'backup', action: 'restore', name: null, fields: fieldsOf(null, c.newRow) }];
    const action = c.created ? (c.newRow ? 'insert' : null) : (c.newRow ? 'update' : 'delete');
    if (!action) return [];
    const fields = fieldsOf(action === 'insert' ? null : c.oldRow, action === 'delete' ? null : c.newRow);
    if (action === 'update' && !fields.length) return [];
    const row = c.newRow ?? c.oldRow;
    return [{ table: c.table, action, name: row.name ?? row.customer_name ?? row.alias ?? row.vendor ?? null, row, fields }];
  });
}

const PAGE = 40;

/**
 * A page of saves, newest first: who, when, and each row they changed. `before` continues from the
 * last page. `deleted`: only what was really removed, which a save replacing a row is not, so a page
 * can come back short or empty with more behind it.
 */
export async function listChanges(before, { deleted = false } = {}) {
  const where = [before ? 'id < $1' : null, deleted ? "action = 'delete'" : null].filter(Boolean);
  const { rows: saves } = await query(
    `SELECT txid, max(id) AS last FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY txid ORDER BY max(id) DESC LIMIT ${PAGE + 1}`,
    before ? [before] : [],
  );
  const page = saves.slice(0, PAGE);
  const { rows } = await query('SELECT * FROM audit_log WHERE txid = ANY($1::bigint[]) ORDER BY id', [page.map((s) => s.txid)]);
  const groups = new Map(page.map((s) => [String(s.txid), []]));
  for (const r of rows) groups.get(String(r.txid))?.push(r);
  const made = page.map((s) => {
    const list = groups.get(String(s.txid));
    return { id: s.last, at: list.at(-1).at, actor: list[0].actor, test: list[0].test, changes: netChanges(list).filter((c) => !deleted || c.action === 'delete') };
  }).filter((s) => s.changes.length);

  // The names behind the ids shown.
  const ids = Object.fromEntries(Object.values(REFERENCES).filter(Boolean).map((t) => [t, new Set()]));
  for (const s of made) for (const c of s.changes) for (const [col, table] of Object.entries(REFERENCES)) if (table && c.row?.[col]) ids[table].add(c.row[col]);
  const names = new Map();
  for (const [table, set] of Object.entries(ids)) {
    if (!set.size) continue;
    const label = table === 'receipts' ? 'vendor' : 'name';
    const { rows: found } = await query(`SELECT id, ${label} AS name FROM ${table} WHERE id = ANY($1::uuid[])`, [[...set]]);
    for (const f of found) names.set(f.id, f.name);
    // Since deleted: the name it had, from its own record here.
    const gone = [...set].filter((id) => !names.has(id));
    if (gone.length) {
      const { rows: past } = await query(
        `SELECT row_key, coalesce(old_row, new_row) ->> '${label}' AS name FROM audit_log WHERE table_name = $1 AND row_key = ANY($2) ORDER BY id`,
        [table, gone],
      );
      for (const r of past) if (r.name) names.set(r.row_key, r.name);
      for (const id of gone) if (!names.has(id)) names.set(id, '(deleted)');
    }
  }
  for (const s of made) {
    for (const c of s.changes) {
      c.label = TABLE_LABELS[c.table] ?? c.table;
      c.name ??= [c.row?.recipe_id, c.row?.ingredient_id, c.row?.blend_id].map((id) => names.get(id)).find(Boolean) ?? null;
      for (const f of c.fields) {
        if (f.field in REFERENCES) {
          f.from = names.get(f.from) ?? f.from;
          f.to = names.get(f.to) ?? f.to;
        }
        f.field = f.field.replaceAll('_', ' ');
      }
      delete c.row;
    }
  }
  return { saves: made, next: saves.length > PAGE ? page.at(-1).last : null };
}

/**
 * Who last changed an event's plan, and when; null if not since changes were tracked. Every save of
 * the plan moves the event's version, and amounts set on the shopping list have rows of their own.
 * `you`: the same network as this request, so maybe another of their windows rather than someone else.
 */
export async function lastEdit(eventId, rawIp) {
  const { rows: [edit] } = await query(
    `SELECT l.actor, l.at, a.ip = $2 AS you
       FROM audit_log l LEFT JOIN actors a ON a.name = l.actor
      WHERE l.actor <> 'Migration'
        AND ((l.table_name = 'events' AND l.row_key = $1) OR (l.table_name IN ('event_amounts', 'event_packs') AND l.row_key LIKE $1 || '/%'))
      ORDER BY l.id DESC LIMIT 1`,
    [eventId, networkOf(rawIp)],
  );
  return edit ? { actor: edit.actor, at: edit.at, you: !!edit.you } : null;
}

/** Who entered an event's newest order since changes were tracked, and when; null if none. Apart from lastEdit: an order doesn't change the plan, so it can't be what a refused save lost out to. */
export async function lastOrder(eventId) {
  const { rows: [order] } = await query(
    `SELECT actor, at FROM audit_log
      WHERE table_name = 'event_sales' AND action = 'insert' AND new_row ->> 'event_id' = $1
      ORDER BY id DESC LIMIT 1`,
    [eventId],
  );
  return order ?? null;
}

const STATUS_WORDS = { placed: 'Reopened', in_progress: 'Started', completed: 'Completed', cancelled: 'Cancelled' };
const statusWord = (was, status) => (status === 'in_progress' && (was === 'completed' || was === 'cancelled') ? 'Reopened' : STATUS_WORDS[status]);

/** Who did what to each order, oldest first: { saleId: [{ actor, at, what }] }. */
export async function orderHistory(saleIds) {
  const { rows } = await query(
    `SELECT row_key, actor, at, action, old_row ->> 'status' AS was, new_row ->> 'status' AS status,
            old_row ->> 'customer_name' IS DISTINCT FROM new_row ->> 'customer_name' AS renamed,
            old_row ->> 'note' IS DISTINCT FROM new_row ->> 'note' AS noted
       FROM audit_log WHERE table_name = 'event_sales' AND row_key = ANY($1) ORDER BY id`,
    [saleIds],
  );
  const history = {};
  for (const r of rows) {
    const what = r.action === 'insert' ? 'Entered' : r.was !== r.status ? statusWord(r.was, r.status) : r.renamed ? 'Renamed' : r.noted ? 'Note changed' : 'Changed';
    (history[r.row_key] ??= []).push({ actor: r.actor, at: r.at, what });
  }
  return history;
}
