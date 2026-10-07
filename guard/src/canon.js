// Canonical JSON: keys sorted, no spaces, and only values that print the same
// in every language (strings, integers, booleans, null). Decimals must already be
// strings (see money.js), so a Python or Go verifier gets byte-identical text.

export function canon(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value)) throw new TypeError(`canon: only safe integers allowed, got ${value}`);
      return String(value);
    case 'object':
      if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
      return `{${Object.keys(value).sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${canon(value[k])}`)
        .join(',')}}`;
    default:
      throw new TypeError(`canon: cannot encode ${typeof value}`);
  }
}
