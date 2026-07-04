// Minimal JSON -> EDN serializer for Workflow Studio authoring.
//
// The workflow data model is the JSON-normalizable subset of EDN used by
// `src/tesseraft/spec.clj`: maps, vectors, keywords, strings, numbers,
// booleans, and nil. This emitter writes that subset. It intentionally does
// NOT parse or round-trip arbitrary EDN; the server runs `bin/tesseraft lint`
// as the validation authority on save, so malformed output is caught there.
//
// Keywords: a string starting with `:` is emitted verbatim (without quotes);
// otherwise a bare string is emitted as a double-quoted EDN string. Map keys
// are emitted as keywords (prefixed with `:` if missing). Studio forms only
// ever produce keyword strings (e.g. ':agent', ':pass') or plain string values,
// so callers control keyword-ness.

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const indentStr = (depth: number): string => ' '.repeat(depth * 2);

const isKeyword = (value: string): boolean => value.startsWith(':');

const emit = (value: Json, depth: number): string => {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'nil';
  if (typeof value === 'string') {
    if (isKeyword(value)) return value;
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inner = value.map((item) => indentStr(depth + 1) + emit(item, depth + 1)).join('\n');
    return `[\n${inner}\n${indentStr(depth)}]`;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  const entries = keys.map((key) => {
    const emittedKey = isKeyword(key) ? key : `:${key}`;
    return `${indentStr(depth + 1)}${emittedKey} ${emit(value[key], depth + 1)}`;
  });
  return `{\n${entries.join('\n')}\n${indentStr(depth)}}`;
};

export const toEdn = (value: unknown): string => emit(value as Json, 0);