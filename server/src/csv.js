// CSV downloads (RFC 4180), opened in spreadsheets: a UTF-8 BOM so Excel reads accents, and
// text that a spreadsheet would run as a formula (= + - @ at the start) is prefixed with '.

const FORMULA = /^[=+\-@\t\r]/;

function cell(value, isText) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (isText && FORMULA.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Send rows as a CSV attachment. columns: [header, key or (row) => value, { text: true }?]
 * Mark free-text columns (names, vendors) as text so they're guarded against formulas;
 * numbers stay as they are, negatives included.
 */
export function sendCsv(res, filename, columns, rows) {
  const lines = [columns.map(([header]) => cell(header, true)).join(',')];
  for (const row of rows) {
    lines.push(columns.map(([, get, opts]) => cell(typeof get === 'function' ? get(row) : row[get], opts?.text)).join(','));
  }
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.send('﻿' + lines.join('\r\n') + '\r\n');
}

/** A file-name-safe version of a title: "Harvest dinner" → "harvest-dinner". */
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
