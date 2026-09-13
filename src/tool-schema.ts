/**
 * Projection of a DSH tool JSON Schema onto the Antigravity
 * `functionDeclarations[].parameters` dialect.
 *
 * The endpoint parses `parameters` as a protobuf message and does **not** ignore
 * keywords that message does not define: it rejects the whole request with
 * HTTP 400 `INVALID_ARGUMENT` ("Invalid JSON payload received. Unknown name …")
 * and names only the first offender. A verbatim pass-through therefore fails
 * every request that carries such a tool — whether the tool is ever called.
 *
 * Measured against `cloudcode-pa.googleapis.com` (2026-09-13), one keyword per
 * request, everything else identical:
 *
 * | keyword | result |
 * | --- | --- |
 * | `const` | 400, `Unknown name "const"` |
 * | `$ref` | 400 |
 * | `examples` | 400 |
 * | `allOf` / `anyOf` / `oneOf` / `not` | accepted |
 * | `enum` / `pattern` / `format` / `default` | accepted |
 * | `minimum` / `maximum` / `minItems` | accepted |
 * | `additionalProperties: false` | accepted |
 *
 * `const` is the one DSH itself emits (`cordis_define`'s `plugin` argument is a
 * `oneOf` over branches discriminated by `const: "new" | "existing"`), so a
 * cordis-preset agent routed to Antigravity failed at the very first request
 * while the same catalog worked on other providers.
 *
 * The projection walks every position that can hold a schema and: rewrites
 * `const: v` into the equivalent one-value `enum: [v]`, drops the reference and
 * document-level keywords a self-contained parameter schema never needs on the
 * wire, and passes everything else through untouched — an unknown keyword still
 * fails loudly at the endpoint instead of being silently weakened here.
 *
 * @module dsh-antigravity/tool-schema
 */

/**
 * Keywords dropped from the wire schema.
 *
 * `$ref`/`$defs`/`definitions`/`$id`/`$schema` describe a JSON Schema document,
 * not a parameter shape the endpoint can consume (it rejects each of them), and
 * `examples` is advisory for a model that already sees `description`. None of
 * them is produced by DSH's own tool schemas.
 */
const DROPPED_KEYWORDS = new Set(['$ref', '$defs', 'definitions', '$id', '$schema', 'examples'])

/** Keywords whose value is a map of schemas, keyed by property name. */
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties'])

/** Keywords whose value is a single schema. */
const SCHEMA_KEYWORDS = new Set(['not'])

/** Keywords whose value is a list of schemas. */
const SCHEMA_LIST_KEYWORDS = new Set(['oneOf', 'anyOf', 'allOf'])

/** Keywords that hold either a schema or a boolean / list of schemas. */
const SCHEMA_OR_BOOLEAN_KEYWORDS = new Set(['additionalProperties', 'additionalItems'])

/** Depth guard for a pathological or cyclic schema. */
const MAX_DEPTH = 64

/** Whether `value` is a plain object (a schema is never an array or `null`). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Project one sub-schema, tolerating `undefined` where a schema is optional. */
function projectSchema(schema: unknown, depth: number): Record<string, unknown> {
  if (!isPlainObject(schema) || depth > MAX_DEPTH) return {}
  const projected: Record<string, unknown> = {}
  for (const [keyword, value] of Object.entries(schema)) {
    if (DROPPED_KEYWORDS.has(keyword) || keyword === 'const') continue
    if (SCHEMA_MAP_KEYWORDS.has(keyword)) {
      if (!isPlainObject(value)) continue
      const mapped: Record<string, unknown> = {}
      for (const [name, sub] of Object.entries(value)) mapped[name] = projectSchema(sub, depth + 1)
      projected[keyword] = mapped
      continue
    }
    if (SCHEMA_KEYWORDS.has(keyword)) {
      projected[keyword] = projectSchema(value, depth + 1)
      continue
    }
    if (SCHEMA_LIST_KEYWORDS.has(keyword) || keyword === 'items') {
      projected[keyword] = Array.isArray(value)
        ? value.map(entry => projectSchema(entry, depth + 1))
        : projectSchema(value, depth + 1)
      continue
    }
    if (SCHEMA_OR_BOOLEAN_KEYWORDS.has(keyword)) {
      projected[keyword] = isPlainObject(value) ? projectSchema(value, depth + 1) : value
      continue
    }
    projected[keyword] = value
  }
  if (schema.const !== undefined) {
    // `const: v` is `enum: [v]` in JSON Schema, and only the latter is defined here.
    const existing = projected.enum
    if (Array.isArray(existing)) {
      if (!existing.includes(schema.const)) projected.enum = [...existing, schema.const]
    } else {
      projected.enum = [schema.const]
    }
  }
  return projected
}

/**
 * Convert a DSH tool's `parameters` into an Antigravity-safe parameter schema.
 *
 * @param schema - the tool's JSON Schema, as DSH registered it.
 * @returns the projected schema, with the object fallback used for a missing one.
 */
export function toAntigravityToolSchema(schema?: unknown): Record<string, unknown> {
  const projected = projectSchema(schema, 0)
  return Object.keys(projected).length > 0 ? projected : { type: 'object', properties: {} }
}
