// SPDX-License-Identifier: MIT
// Settings integration for dsh-goal-round-compact.
//
// The plugin owns one DSH settings namespace ("goal-round-compact") so its five
// budgets can be edited from Settings instead of by editing cordis.patch.yml.
// Two layers coexist, in this order of precedence:
//
//   1. the composition entry (cordis.patch.yml) - the base layer;
//   2. the user layer written through the settings surface.
//
// Reading goes through settings.installSection(), whose resolved value folds the
// two. A profile without dsh-settings still mounts this plugin: everything here
// is behind an optional injection, and the reader falls back to the composition
// entry when no settings service is present.

/** The namespace shown in Settings. Lowercase, hyphenated, plugin-owned. */
export const SETTINGS_NAMESPACE = 'goal-round-compact'

/**
 * The single source of truth for every default in this package.
 *
 * src/index.js derives its Config defaults from here, and the numbers below are
 * mirrored by cordis.patch.yml (which cannot import JS - keep them in sync; the
 * 'cordis.patch.yml mirrors DEFAULT_SETTINGS' check in the task report is what
 * guards that). Frozen so no consumer can edit the shared object in place.
 */
export const DEFAULT_SETTINGS = deepFreeze({
  enabled: true,
  minTokensBeforeCompact: 48000,
  retainTokens: 16000,
  minGrowthTokens: 32000,
  maxCompactionsPerGoal: 8,
  modelPolicies: [],
})

// The settings service calls the registered schema directly (`schema(value)`)
// and asks it for `.toJSON()` when it describes namespaces. schemastery is one
// implementation of that contract, but this plugin does not reuse it here for
// three concrete reasons:
//
//   * dsh-settings walks schemastery INTERNALS when a wire surface asks for
//     redaction (lib/index.js:18-53 reads `node.meta?.role` / `node.type` /
//     `node.dict`). A self-contained schema is passed through untouched
//     instead of depending on those internals staying stable.
//   * The namespace is five numbers and one table, all owned by this file.
//     Spelling the contract out keeps it greppable in one place.
//   * This namespace declares no secret fields, so redaction is a no-op either
//     way; correctness must not depend on that staying true.
//
// (Note: the parallel comment in dsh-approval-whitelist/src/settings.js claims
// schemastery lives in profiles/web/node_modules. That is stale and backwards -
// it lives in profiles/node_modules. Do not copy that reasoning forward.)

/** The five scalars a settings page may change, with their kinds and defaults. */
const SCALAR_FIELD_SPEC = [
  ['enabled', 'boolean', DEFAULT_SETTINGS.enabled],
  ['minTokensBeforeCompact', 'number', DEFAULT_SETTINGS.minTokensBeforeCompact],
  ['retainTokens', 'number', DEFAULT_SETTINGS.retainTokens],
  ['minGrowthTokens', 'number', DEFAULT_SETTINGS.minGrowthTokens],
  ['maxCompactionsPerGoal', 'number', DEFAULT_SETTINGS.maxCompactionsPerGoal],
]

/**
 * The optional per-model overrides. provider and model are required and matched
 * by strict equality; every other field is optional and falls back to the global
 * value field by field at resolve time (see resolveTargetPolicy in index.js).
 */
const POLICY_NUMBER_FIELDS = [
  'minTokensBeforeCompact',
  'retainTokens',
  'minGrowthTokens',
  'maxCompactionsPerGoal',
]

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

/**
 * Type convergence with a default floor.
 *
 * Numbers additionally reject negatives: a negative token budget or compaction
 * cap is never a meaningful setting, and silently accepting one would turn a
 * typo in a hand-edited settings.yaml into a broken compression schedule. A
 * hand-edited file must never be able to inject a nonsense budget.
 */
function coerce(kind, value, fallback) {
  if (kind === 'boolean') return typeof value === 'boolean' ? value : fallback
  if (kind === 'number') {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
  }
  return typeof value === 'string' ? value : fallback
}

/**
 * Narrow the per-model override table.
 *
 * Matching is an exact (provider, model) pair - no wildcards, no prefix
 * matching - mirroring dsh-compaction-basic's modelPolicies. Entries without a
 * usable pair are dropped, and a repeated pair keeps only its first row so the
 * downstream find() first-hit rule has exactly one candidate to choose.
 *
 * Absent optional fields are left ABSENT rather than filled with the global
 * default: that keeps the per-field fallback in resolveTargetPolicy a real
 * fallback instead of a value frozen at read time.
 */
function coerceModelPolicies(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const policies = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const { provider, model } = entry
    if (typeof provider !== 'string' || provider.length === 0) continue
    if (typeof model !== 'string' || model.length === 0) continue
    const key = `${provider}/${model}`
    if (seen.has(key)) continue
    seen.add(key)
    const policy = { provider, model }
    for (const field of POLICY_NUMBER_FIELDS) {
      const raw = entry[field]
      if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) policy[field] = raw
    }
    policies.push(policy)
  }
  return policies
}

/**
 * Build the namespace schema. Deliberately narrow: it exposes exactly what a
 * settings page may change, and nothing else.
 *
 * The returned value is callable (`schema(value)` folds defaults over a merged
 * layer) and carries `toJSON()` for the settings descriptor. Three contracts
 * ride on that shape (dsh-settings/lib/index.js:361-368, 509-513):
 *
 *   1. `schema(value)` must return a COMPLETE normalized object - every field
 *      defaulted, types converged, unknown keys dropped;
 *   2. `schema.toJSON()` must return a JSON Schema style description;
 *   3. it must be a plain function.
 *
 * The result therefore has exactly these six keys and no others, whatever the
 * caller passes in.
 */
export function buildSettingsSchema() {
  const scalarProperties = {}
  for (const [field, kind, fallback] of SCALAR_FIELD_SPEC) {
    scalarProperties[field] = { type: kind, default: fallback }
  }
  const policyProperties = { provider: { type: 'string' }, model: { type: 'string' } }
  for (const field of POLICY_NUMBER_FIELDS) policyProperties[field] = { type: 'number' }
  const shape = {
    type: 'object',
    additionalProperties: false,
    properties: Object.assign(scalarProperties, {
      modelPolicies: {
        type: 'array',
        default: [],
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['provider', 'model'],
          properties: policyProperties,
        },
      },
    }),
  }
  const schema = (input) => {
    const source = input !== null && typeof input === 'object' ? input : {}
    const normalized = {}
    // Unknown keys are dropped here: they must not survive the fold.
    for (const [field, kind, fallback] of SCALAR_FIELD_SPEC) {
      normalized[field] = coerce(kind, source[field], fallback)
    }
    normalized.modelPolicies = coerceModelPolicies(source.modelPolicies)
    return normalized
  }
  schema.toJSON = () => shape
  return schema
}

/**
 * The composition entry shaped for the schema (the base layer).
 *
 * This is also the plugin's fallback value: when no settings service is present
 * the reader keeps returning this object, so a profile without dsh-settings
 * behaves exactly as it did before the namespace existed.
 */
export function settingsEntry(config) {
  const input = config !== null && typeof config === 'object' ? config : {}
  const entry = {}
  for (const [field, kind, fallback] of SCALAR_FIELD_SPEC) {
    entry[field] = coerce(kind, input[field], fallback)
  }
  entry.modelPolicies = coerceModelPolicies(input.modelPolicies)
  return entry
}

/**
 * Install the settings namespace and hand back a live reader.
 *
 * @param ctx - plugin context.
 * @param entry - the composition entry (base + fallback value).
 * @param onError - reporter for a surface that cannot be wired.
 * @returns a function returning the resolved settings object.
 */
export function installSettings(ctx, entry, onError) {
  let source = () => entry
  if (typeof ctx.inject !== 'function') return () => source()
  // Optional injection, NOT the plugin's static `inject`: a static entry is a
  // hard dependency in cordis (registry.ts:105-106, fiber.ts:611-637) and would
  // keep the whole plugin from loading on a profile without dsh-settings.
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx !== null && typeof settingsCtx === 'object'
      ? (settingsCtx.settings !== undefined ? settingsCtx.settings : (typeof settingsCtx.get === 'function' ? settingsCtx.get('settings') : undefined))
      : undefined
    if (settings === undefined || settings === null) return
    const schema = buildSettingsSchema()
    try {
      // installSection is the current API; register is the older shape. Both
      // resolve the same two layers, so either one is correct here.
      if (typeof settings.installSection === 'function') {
        // installSection REQUIRES both hooks: it calls setSource(), onChange()
        // and (on unload) setSource()+onChange() again. Omitting onChange throws
        // 'hooks.onChange is not a function' and aborts the mount.
        settings.installSection(ctx, SETTINGS_NAMESPACE, schema, entry, {
          setSource: (current) => { source = current },
          onChange: () => {},
        })
        return
      }
      if (typeof settings.register === 'function') {
        const scope = settings.register(SETTINGS_NAMESPACE, schema, { base: entry })
        source = () => scope.get()
        if (typeof ctx.effect === 'function') ctx.effect(() => () => { source = () => entry })
      }
    } catch (error) {
      if (typeof onError === 'function') onError('install settings namespace', SETTINGS_NAMESPACE, error)
    }
  })
  return () => source()
}
