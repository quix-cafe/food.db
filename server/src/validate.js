import { toDecimal } from '@kitchen/shared';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (message) => new HttpError(400, message);
export const notFound = (what) => new HttpError(404, `${what} not found`);

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

export function text(value, field, { required = false, max = 200 } = {}) {
  if (blank(value)) {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw badRequest(`${field} must be text`);
  const v = value.trim();
  if (v.length > max) throw badRequest(`${field} must be at most ${max} characters`);
  return v;
}

/** Validate a decimal; returns it as a string (or Number when integer: true). */
export function number(value, field, { required = false, min, max, minExclusive = false, maxExclusive = false, integer = false } = {}) {
  if (blank(value)) {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  const d = toDecimal(value);
  if (!d) throw badRequest(`${field} must be a number`);
  if (integer && !d.isInteger()) throw badRequest(`${field} must be a whole number`);
  if (min !== undefined && (minExclusive ? d.lte(min) : d.lt(min))) {
    throw badRequest(`${field} must be ${minExclusive ? 'greater than' : 'at least'} ${min}`);
  }
  if (max !== undefined && (maxExclusive ? d.gte(max) : d.gt(max))) {
    throw badRequest(`${field} must be ${maxExclusive ? 'below' : 'at most'} ${max}`);
  }
  return integer ? d.toNumber() : d.toString();
}

export function date(value, field, { required = false } = {}) {
  if (blank(value)) {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw badRequest(`${field} must be a date like 2026-10-14`);
  }
  return m[0];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(value, field, { required = true } = {}) {
  if (blank(value)) {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  if (!UUID.test(String(value))) throw badRequest(`${field} is not a valid id`);
  return String(value);
}

export function array(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest(`${field} must be a list`);
  return value;
}

export const today = () => new Date().toLocaleDateString('en-CA');
