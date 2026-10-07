// Fixed-point decimals with 8 places, stored as BigInt "units" (1 unit = 1e-8).
// Every amount that goes into the ledger is computed here with integer math,
// so anyone can recompute the same numbers in any language.

export const DP = 8;
export const SCALE = 10n ** 8n;

const DEC = /^(-)?(\d+)(?:\.(\d*))?$/;

/** Parse "65000.01", 100, 0.5 or a BigInt into units. Extra decimals are cut, not rounded. */
export function parse(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`not a finite number: ${value}`);
    value = value.toFixed(DP);
  }
  if (typeof value !== 'string') throw new TypeError(`not a decimal: ${value}`);
  const m = DEC.exec(value.trim());
  if (!m) throw new TypeError(`not a decimal: ${value}`);
  const [, sign, int, frac = ''] = m;
  const units = BigInt(int) * SCALE + BigInt((frac + '0'.repeat(DP)).slice(0, DP));
  return sign ? -units : units;
}

/** Units to a decimal string. Fixed 8 places by default (what the ledger stores). */
export function fmt(units, { trim = false } = {}) {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  let s = `${abs / SCALE}.${(abs % SCALE).toString().padStart(DP, '0')}`;
  if (trim) s = s.replace(/\.?0+$/, '');
  return (neg && abs !== 0n ? '-' : '') + s;
}

/** Floor division for non-negative numerators and positive denominators. */
export function floorDiv(a, b) {
  if (b <= 0n) throw new RangeError('denominator must be positive');
  const q = a / b;
  return a < 0n && q * b !== a ? q - 1n : q;
}

/** Ceiling division, same contract as floorDiv. */
export function ceilDiv(a, b) {
  return -floorDiv(-a, b);
}

/** a × b, both in units → units, rounded down. */
export function mul(a, b) {
  return floorDiv(a * b, SCALE);
}

/** a ÷ b, both in units → units, rounded down. */
export function div(a, b) {
  return floorDiv(a * SCALE, b);
}

/** Percent (5, 2.5) → basis points as BigInt (500n, 250n). */
export function bps(pct) {
  if (!Number.isFinite(pct)) throw new TypeError(`bad percent: ${pct}`);
  return BigInt(Math.round(pct * 100));
}

/** Readable number for agents and people: trims zeros, cuts (toward zero) to `dp` places. */
export function show(units, dp = 2) {
  const cut = 10n ** BigInt(DP - dp);
  return fmt((units / cut) * cut, { trim: true });
}
