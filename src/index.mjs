/**
 * context-window-packer
 *
 * Decides which of a manifest's document segments fit a token budget, and says
 * in the report exactly what was left out and why.
 *
 * Four properties are structural rather than incidental:
 *
 * 1. **Mandatory material is never dropped silently.** The mandatory segments
 *    and everything they cite are selected before anything else competes for
 *    the budget. If that set alone does not fit, the run stops with
 *    `mandatory-over-budget`, produces **no pack at all**, and exits 1. There is
 *    no arrangement of inputs in which a pack comes back missing a mandatory
 *    segment: `assertPackInvariants` re-checks it on every pack that is emitted.
 * 2. **A retained claim keeps its citations.** Selection works on the
 *    transitive closure of the citation graph, so a claim and its evidence are
 *    retained or dropped together.
 * 3. **Unknown evidence is never a pass.** A manifest that could not be read,
 *    decoded, parsed or interpreted, a segment file that could not be read, a
 *    token count that was not supplied in `declared` mode, a limit that was
 *    reached, or a time budget that expired -- each makes the run `incomplete`,
 *    produces no pack, and exits 2. A partially packed window is not a smaller
 *    answer, it is a wrong one.
 * 4. **Output is stable.** No clock reading, no locale, no absolute host path
 *    and no object key order reaches stdout, so the same manifest always
 *    produces byte-identical output.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { TOKEN_COST_MODELS, estimateTokens } from './cost.mjs'
import { KIND_RANK, MANIFEST_SCHEMA_VERSION, validateManifest } from './manifest.mjs'
import {
  assertPackInvariants, buildUnits, closureOf, compareAssembly, compareUnits, packUnits, unitsInCycles,
} from './pack.mjs'
import { byCodeUnit, decodeUtf8, escapePointerSegment, parseFailureDetail, sanitize } from './text.mjs'

export { CHARS_PER_TOKEN, TOKEN_COST_MODELS, estimateTokens } from './cost.mjs'
export {
  ID_PATTERN, KIND_RANK, MANIFEST_KEYS, MANIFEST_SCHEMA_VERSION, SEGMENT_KEYS, SEGMENT_KINDS, validateManifest,
} from './manifest.mjs'
export {
  assertPackInvariants, buildUnits, closureOf, compareAssembly, compareUnits, packUnits, unitsInCycles,
} from './pack.mjs'
export { CONTROL_CLASSES, byCodeUnit, decodeUtf8, escapePointerSegment, parseFailureDetail, sanitize } from './text.mjs'

export const TOOL_ID = 'context-window-packer'
export const REPORT_SCHEMA_VERSION = '1'
export const CONFIG_SCHEMA_VERSION = '1'
export const PACK_SCHEMA_VERSION = '1'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * A manifest is ordinary untrusted input: it can declare ten thousand segments,
 * point at a generated 40 MB file, or chain citations forever. Every limit is
 * explicit, overridable from the command line, and named in the finding when it
 * is reached. Exceeding one produces an `incomplete` report and no pack -- never
 * a quietly shorter window, and never a pass.
 *
 * `timeoutMs` accepts 0, and 0 means "no time at all": the first check fires.
 * That is the only way to prove from the outside that the flag is wired through
 * to the packing loop at all, and a documented limit the command line never
 * reaches is a defect this catalog has already shipped once.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxCitationDepth: 8,
  maxCitations: 20,
  maxManifestBytes: 1048576,
  maxSegmentBytes: 262144,
  maxSegments: 500,
  maxTextChars: 200000,
  timeoutMs: 10000,
})

/**
 * The authoritative rule severity table.
 *
 * Severity decides whether a run refuses. Spread across construction sites as a
 * literal it drifts silently, so every finding takes its severity from here and
 * an unknown rule id throws.
 *
 * This table is the source of truth. It is **not** the guard. Three
 * declarations agreeing with each other -- this table, the README's rule table,
 * and an expected-value map written out again in a test -- are all satisfied by
 * one coordinated edit. The guard is `test/severity-outcomes.test.mjs`, which
 * drives each rule through the real entry point and asserts the observable
 * outcome (`'fail'`, `'incomplete'`, exit `1`, exit `2`) as a literal at the
 * assertion site. An edit here has nothing there to agree with.
 */
export const RULE_SEVERITY = Object.freeze({
  'citation-cycle': 'info',
  'citation-depth-exceeded': 'error',
  'citation-unresolved': 'error',
  'mandatory-over-budget': 'error',
  'manifest-malformed': 'error',
  'manifest-not-json': 'error',
  'manifest-not-utf8': 'error',
  'manifest-schema-unsupported': 'error',
  'manifest-too-large': 'error',
  'manifest-unknown-key': 'error',
  'manifest-unreadable': 'error',
  'no-segments': 'warning',
  'path-escapes-root': 'error',
  'segment-cost-conflict': 'error',
  'segment-cost-unknown': 'error',
  'segment-dropped': 'info',
  'segment-file-not-utf8': 'error',
  'segment-file-too-large': 'error',
  'segment-file-unreadable': 'error',
  'segment-id-invalid': 'error',
  'segment-kind-unknown': 'error',
  'segment-malformed': 'error',
  'segment-source-missing': 'error',
  'segment-text-too-large': 'error',
  'segment-unknown-key': 'error',
  'time-budget-exceeded': 'error',
  'too-many-citations': 'error',
  'too-many-segments': 'error',
  'unit-exceeds-budget': 'warning',
})

/**
 * Rules that mean evidence was not obtained.
 *
 * Any one of these forces `status: "incomplete"`, suppresses the pack entirely,
 * and exits 2 -- whatever else the run found. Most are `error` severity, so it
 * would be easy to believe severity alone does the work. It does not: without
 * the flag the run would report `fail` and exit 1, claiming a verdict about
 * material it never read. And `no-segments` is a `warning`, so there the flag is
 * the *only* thing standing between an empty manifest and a green build.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'citation-depth-exceeded',
  'citation-unresolved',
  'manifest-malformed',
  'manifest-not-json',
  'manifest-not-utf8',
  'manifest-schema-unsupported',
  'manifest-too-large',
  'manifest-unknown-key',
  'manifest-unreadable',
  'no-segments',
  'path-escapes-root',
  'segment-cost-conflict',
  'segment-cost-unknown',
  'segment-file-not-utf8',
  'segment-file-too-large',
  'segment-file-unreadable',
  'segment-id-invalid',
  'segment-kind-unknown',
  'segment-malformed',
  'segment-source-missing',
  'segment-text-too-large',
  'segment-unknown-key',
  'time-budget-exceeded',
  'too-many-citations',
  'too-many-segments',
])

const INCOMPLETE_SET = new Set(INCOMPLETE_RULES)
const ALLOWED_OPTIONS = Object.freeze(['budgetTokens', 'clock', 'limits', 'manifest', 'root', 'tokenCost'])
const ALLOWED_CONFIG_KEYS = Object.freeze(['budgetTokens', 'limits', 'schemaVersion', 'tokenCost'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * True when `target` is the real root or lies inside it.
 *
 * Both arguments must already be real paths. Rejecting `../` and absolute paths
 * is not confinement: a symlink planted inside the declared root points outside
 * it while spelling nothing suspicious, and following one has already echoed
 * out-of-root content into a report in this catalog.
 */
export function isInside(realRoot, target) {
  return target === realRoot || target.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)
}

/**
 * The real path of `path`, or the closest thing to it that exists.
 *
 * `realpath` fails outright on a file that is not there, which is precisely the
 * case a report has to describe. Resolving the containing directory instead
 * keeps a missing input's reported name relative to the root rather than
 * turning it into a walk back up the host's filesystem.
 */
async function realOrNearest(path) {
  try {
    return await realpath(path)
  } catch {
    // fall through to the directory
  }
  try {
    return join(await realpath(dirname(path)), basename(path))
  } catch {
    return resolve(path)
  }
}

/** A relative path with forward slashes, so a report reads the same on every platform. */
function relativePosix(realRoot, target) {
  return relative(realRoot, target).split(sep).join('/')
}

/**
 * The documented sort key, exported so a test can pin each half of it.
 *
 * `message` and `evidence` are the fourth and fifth keys because the first
 * three do not separate every row the report can carry: several segments of one
 * unit drop for the same reason under the same rule, and two unknown keys on
 * one segment share a pointer prefix. Without the extra keys those rows tie, and
 * their order falls back to whichever upstream loop inserted them -- an ordering
 * no reader of this function can see and no test of it can pin.
 */
export function compareFindingRows(left, right) {
  return byCodeUnit(left.location.file, right.location.file)
    || byCodeUnit(left.location.pointer ?? '', right.location.pointer ?? '')
    || byCodeUnit(left.ruleId, right.ruleId)
    || byCodeUnit(left.message, right.message)
    || byCodeUnit(left.evidence ?? '', right.evidence ?? '')
}

export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${sanitize(name, 60)}"`)
    const minimum = name === 'timeoutMs' ? 0 : 1
    if (!Number.isInteger(value) || value < minimum) {
      throw new TypeError(`Limit "${name}" must be an integer of ${minimum} or more`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

/**
 * There is no default cost model.
 *
 * `declared` and `estimate` can disagree by a wide margin, and the disagreement
 * is the whole verdict. A run that does not say which one it wants is a
 * configuration error rather than a guess.
 */
export function validateTokenCost(tokenCost) {
  if (tokenCost === undefined || tokenCost === null) {
    throw new TypeError(`A token cost model is required; choose one of ${TOKEN_COST_MODELS.join(', ')}`)
  }
  if (typeof tokenCost !== 'string' || !TOKEN_COST_MODELS.includes(tokenCost)) {
    throw new TypeError(`Unknown token cost model "${sanitize(String(tokenCost), 40)}"; choose one of ${TOKEN_COST_MODELS.join(', ')}`)
  }
  return tokenCost
}

export function validateBudget(budgetTokens) {
  if (!Number.isInteger(budgetTokens) || budgetTokens < 0) {
    throw new TypeError('budgetTokens must be an integer of 0 or more')
  }
  return budgetTokens
}

/**
 * Validate a parsed configuration document.
 *
 * An unknown key is refused. Accepting `tokenCost` next to a misspelled
 * `tokenCosts` would run a cost model nobody chose, and accepting
 * `limits: { maxSegment: 1 }` would leave the real limit at its default while
 * the operator believed otherwise.
 */
export function validateConfig(config) {
  if (!isRecord(config)) throw new TypeError('Configuration must be a JSON object')
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported configuration schemaVersion: ${sanitize(String(config.schemaVersion ?? 'missing'), 40)}`)
  }
  for (const key of Object.keys(config)) {
    if (!ALLOWED_CONFIG_KEYS.includes(key)) {
      throw new TypeError(`Unknown configuration key "${sanitize(key, 60)}"; this tool accepts ${ALLOWED_CONFIG_KEYS.join(', ')}`)
    }
  }
  return Object.freeze({
    tokenCost: config.tokenCost === undefined ? null : validateTokenCost(config.tokenCost),
    budgetTokens: config.budgetTokens === undefined ? null : validateBudget(config.budgetTokens),
    limits: validateLimits(config.limits ?? {}),
  })
}

/**
 * Read and validate a configuration file.
 *
 * Decoded with the same strict decoder as the manifest. A tool that hardens its
 * data path and leaves its own configuration path lossy has moved the hole, not
 * closed it.
 */
export async function loadConfigFile(path) {
  let bytes
  try {
    bytes = await readFile(resolve(path))
  } catch (error) {
    throw new TypeError(`Configuration file could not be read: ${error.code ?? 'unreadable'}`)
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) throw new TypeError('Configuration file is not valid UTF-8')
  let parsed
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    throw new TypeError(`Configuration file is not valid JSON: ${sanitize(parseFailureDetail(error), 120)}`)
  }
  return validateConfig(parsed)
}

function makeFinding(ruleId, message, location, extra = {}) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new TypeError(`Unknown rule id "${ruleId}"`)
  const pointer = location.pointer === undefined || location.pointer === '' ? undefined : location.pointer
  return {
    ruleId,
    severity,
    message,
    location: pointer === undefined ? { file: location.file } : { file: location.file, pointer },
    ...extra,
  }
}

/**
 * Resolve one segment's text: inline, or from a file confined to the real root.
 *
 * Returns either `{ text }` or `{ problem }`. The declared path never becomes
 * `location.file` when it escapes: an escaping path is reported against the
 * manifest, with the declared spelling as bounded evidence, so the report never
 * carries a path outside the tree it was told to read.
 */
async function resolveText(segment, context) {
  const { realRoot, manifestFile, limits } = context
  const pointer = `/segments/${escapePointerSegment(segment.id)}`
  if (segment.file === null) return { text: segment.text, file: manifestFile }

  const candidate = resolve(realRoot, segment.file)
  if (!isInside(realRoot, candidate)) {
    return {
      problem: makeFinding(
        'path-escapes-root',
        `Segment "${segment.id}" points at a path that leaves the declared root. The root is the boundary of what this run may read.`,
        { file: manifestFile, pointer: `${pointer}/file` },
        { evidence: sanitize(segment.file, 120) },
      ),
    }
  }
  const relativeFile = relativePosix(realRoot, candidate)

  let realFile
  try {
    realFile = await realpath(candidate)
  } catch (error) {
    return {
      problem: makeFinding(
        'segment-file-unreadable',
        `Segment "${segment.id}" could not be read (${sanitize(String(error.code ?? 'unreadable'), 40)}), so its cost and content are unknown.`,
        { file: relativeFile, pointer: `${pointer}/file` },
      ),
    }
  }
  if (!isInside(realRoot, realFile)) {
    return {
      problem: makeFinding(
        'path-escapes-root',
        `Segment "${segment.id}" resolves through a link to a location outside the declared root, so it was not read.`,
        { file: relativeFile, pointer: `${pointer}/file` },
        { evidence: sanitize(segment.file, 120) },
      ),
    }
  }

  let info
  try {
    info = await stat(realFile)
  } catch (error) {
    return {
      problem: makeFinding(
        'segment-file-unreadable',
        `Segment "${segment.id}" could not be inspected (${sanitize(String(error.code ?? 'unreadable'), 40)}).`,
        { file: relativeFile, pointer: `${pointer}/file` },
      ),
    }
  }
  if (!info.isFile()) {
    return {
      problem: makeFinding(
        'segment-file-unreadable',
        `Segment "${segment.id}" points at something that is not a regular file.`,
        { file: relativeFile, pointer: `${pointer}/file` },
      ),
    }
  }
  if (info.size > limits.maxSegmentBytes) {
    return {
      problem: makeFinding(
        'segment-file-too-large',
        `Segment "${segment.id}" is ${info.size} bytes, above the maxSegmentBytes limit of ${limits.maxSegmentBytes}. It was not read, so it was not packed.`,
        { file: relativeFile, pointer: `${pointer}/file` },
      ),
    }
  }

  let bytes
  try {
    bytes = await readFile(realFile)
  } catch (error) {
    return {
      problem: makeFinding(
        'segment-file-unreadable',
        `Segment "${segment.id}" could not be read (${sanitize(String(error.code ?? 'unreadable'), 40)}).`,
        { file: relativeFile, pointer: `${pointer}/file` },
      ),
    }
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    return {
      problem: makeFinding(
        'segment-file-not-utf8',
        `Segment "${segment.id}" is not valid UTF-8, so its content could not be decoded. The decoder decides this; the decoded text never gets a vote.`,
        { file: relativeFile, pointer: `${pointer}/file` },
      ),
    }
  }
  return { text: decoded.text, file: relativeFile }
}

function resolveCost(segment, text, tokenCost, manifestFile) {
  const pointer = `/segments/${escapePointerSegment(segment.id)}`
  if (tokenCost === 'declared') {
    if (segment.declaredTokens === null) {
      return {
        problem: makeFinding(
          'segment-cost-unknown',
          `Segment "${segment.id}" declares no "tokens" and this run uses the declared cost model, so its cost is unknown. An unknown cost is never treated as free.`,
          { file: manifestFile, pointer: `${pointer}/tokens` },
        ),
      }
    }
    return { tokens: segment.declaredTokens }
  }
  if (segment.declaredTokens !== null) {
    return {
      problem: makeFinding(
        'segment-cost-conflict',
        `Segment "${segment.id}" declares "tokens" but this run uses the estimate cost model, which would silently ignore it. Drop the field or run with --token-cost declared.`,
        { file: manifestFile, pointer: `${pointer}/tokens` },
      ),
    }
  }
  return { tokens: estimateTokens(text) }
}

function withMaterial(material, report) {
  return { report, material }
}

/**
 * The status a run's counts imply.
 *
 * Missing evidence outranks everything: a run that could not read part of its
 * subject has no verdict to give about it, whatever the rest of the manifest
 * looked like.
 */
export function statusFor({ errors, unexamined }) {
  if (unexamined > 0) return 'incomplete'
  return errors > 0 ? 'fail' : 'pass'
}

/**
 * The pack a status permits.
 *
 * An `incomplete` run never carries a pack, however far the packing got. This
 * is a second gate: `packContext` already stops before making a single packing
 * decision once any evidence is known to be missing. It is kept, and kept
 * exported and tested, because the first gate is a `return` in one place and a
 * rule emitted after it would slip past -- and a window assembled from a
 * partial reading is not a smaller answer, it is a wrong one.
 */
export function packFor(status, pack) {
  return status === 'incomplete' ? null : pack
}

/**
 * Pack a manifest into a token budget, returning `{ report, material }`.
 *
 * `material` maps each resolved segment id to its text. It is what `--pack-out`
 * writes and it is never part of the report.
 *
 * Throws a `TypeError` for anything that makes the run impossible to define --
 * no manifest, no budget, no cost model, an unknown limit, a root that is not a
 * readable directory. Those are configuration errors: the run never had a
 * subject, so there is nothing to report about, and the CLI writes nothing to
 * stdout. Everything that is a fact about the manifest comes back in the report.
 */
export async function packContextWithMaterial(options = {}) {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${sanitize(key, 60)}"`)
  }
  if (typeof options.manifest !== 'string' || options.manifest.trim() === '') {
    throw new TypeError('A manifest file is required')
  }
  const tokenCost = validateTokenCost(options.tokenCost)
  const budgetTokens = validateBudget(options.budgetTokens)
  const limits = validateLimits(options.limits ?? {})
  const clock = options.clock ?? (() => performance.now())
  if (typeof clock !== 'function') throw new TypeError('clock must be a function returning elapsed milliseconds')

  const manifestPath = resolve(options.manifest)
  const rootPath = options.root === undefined || options.root === null
    ? dirname(manifestPath)
    : resolve(options.root)

  let realRoot
  try {
    realRoot = await realpath(rootPath)
  } catch (error) {
    throw new TypeError(`Root directory could not be resolved: ${error.code ?? 'unresolvable'}`)
  }
  let rootInfo
  try {
    rootInfo = await stat(realRoot)
  } catch (error) {
    throw new TypeError(`Root directory could not be inspected: ${error.code ?? 'uninspectable'}`)
  }
  if (!rootInfo.isDirectory()) throw new TypeError('Root must be a directory')

  // A manifest that does not exist still has to be *named* in the report, and
  // named relatively: on macOS the temporary directory is reached through a
  // symlink, so resolving the root but not the manifest produced a reported
  // path of `../../../../../../../var/folders/...`. Falling back to the real
  // path of the containing directory keeps the name relative whether or not the
  // file is there.
  const realManifest = await realOrNearest(manifestPath)
  if (!isInside(realRoot, realManifest)) {
    throw new TypeError('The manifest must lie inside the declared root, so every reported path can be relative to it')
  }
  const manifestFile = relativePosix(realRoot, realManifest)

  const started = clock()
  const deadline = () => limits.timeoutMs === 0 || clock() - started > limits.timeoutMs

  const findings = []
  // The resolved text of every segment, for `--pack-out`. It is deliberately
  // NOT part of the report: stdout carries a verdict, not the caller's
  // documents, and a report that echoed its inputs would be a redaction hole
  // with a schema.
  const material = new Map()
  const emptyPackSummary = {
    checked: 0,
    declared: 0,
    units: 0,
    retained: 0,
    dropped: 0,
    budgetTokens,
    usedTokens: 0,
    mandatoryTokens: 0,
    tokenCost,
  }
  const finish = (summaryExtra, pack) => {
    findings.sort(compareFindingRows)
    const errors = findings.filter((finding) => finding.severity === 'error').length
    const warnings = findings.filter((finding) => finding.severity === 'warning').length
    const unexamined = findings.filter((finding) => INCOMPLETE_SET.has(finding.ruleId)).length
    const status = statusFor({ errors, unexamined })
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      tool: TOOL_ID,
      status,
      summary: {
        ...emptyPackSummary,
        ...summaryExtra,
        errors,
        warnings,
        info: findings.length - errors - warnings,
        unexamined,
      },
      pack: packFor(status, pack),
      findings,
    }
  }

  let manifestInfo
  try {
    manifestInfo = await stat(manifestPath)
  } catch (error) {
    findings.push(makeFinding(
      'manifest-unreadable',
      `The manifest could not be inspected (${sanitize(String(error.code ?? 'unreadable'), 40)}).`,
      { file: manifestFile },
    ))
    return withMaterial(material, finish({}, null))
  }
  if (manifestInfo.size > limits.maxManifestBytes) {
    findings.push(makeFinding(
      'manifest-too-large',
      `The manifest is ${manifestInfo.size} bytes, above the maxManifestBytes limit of ${limits.maxManifestBytes}. It was not read.`,
      { file: manifestFile },
    ))
    return withMaterial(material, finish({}, null))
  }

  let bytes
  try {
    bytes = await readFile(manifestPath)
  } catch (error) {
    findings.push(makeFinding(
      'manifest-unreadable',
      `The manifest could not be read (${sanitize(String(error.code ?? 'unreadable'), 40)}).`,
      { file: manifestFile },
    ))
    return withMaterial(material, finish({}, null))
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    findings.push(makeFinding(
      'manifest-not-utf8',
      'The manifest is not valid UTF-8, so it could not be decoded.',
      { file: manifestFile },
    ))
    return withMaterial(material, finish({}, null))
  }
  let document
  try {
    document = JSON.parse(decoded.text)
  } catch (error) {
    findings.push(makeFinding(
      'manifest-not-json',
      `The manifest is not valid JSON: ${sanitize(parseFailureDetail(error), 120)}.`,
      { file: manifestFile },
    ))
    return withMaterial(material, finish({}, null))
  }

  const { segments, problems } = validateManifest(document, limits)
  const declared = isRecord(document) && isRecord(document.segments) ? Object.keys(document.segments).length : 0
  for (const problem of problems) {
    findings.push(makeFinding(
      problem.ruleId,
      problem.message,
      { file: manifestFile, pointer: problem.pointer },
      problem.evidence === undefined ? {} : { evidence: problem.evidence },
    ))
  }

  const resolved = []
  let timedOut = false
  for (const segment of segments) {
    if (deadline()) {
      timedOut = true
      break
    }
    const source = await resolveText(segment, { realRoot, manifestFile, limits })
    if (source.problem !== undefined) {
      findings.push(source.problem)
      continue
    }
    if (source.text.length > limits.maxTextChars) {
      findings.push(makeFinding(
        'segment-text-too-large',
        `Segment "${segment.id}" holds ${source.text.length} characters, above the maxTextChars limit of ${limits.maxTextChars}. It was not packed.`,
        { file: source.file, pointer: `/segments/${escapePointerSegment(segment.id)}` },
      ))
      continue
    }
    const cost = resolveCost(segment, source.text, tokenCost, manifestFile)
    if (cost.problem !== undefined) {
      findings.push(cost.problem)
      continue
    }
    material.set(segment.id, source.text)
    resolved.push({
      ...segment,
      kindRank: KIND_RANK[segment.kind],
      sourceFile: source.file,
      tokens: cost.tokens,
    })
  }

  if (timedOut) {
    findings.push(makeFinding(
      'time-budget-exceeded',
      `The time budget of ${limits.timeoutMs}ms expired while resolving segments, so this run packed nothing. A window assembled from a partial reading is not a smaller answer, it is a wrong one.`,
      { file: manifestFile },
    ))
    return withMaterial(material, finish({ declared }, null))
  }

  // "pass" with nothing checked is green on no evidence. This fires both for a
  // manifest that declares no segments and for one whose segments all failed
  // validation, and it is a warning -- so the incomplete flag, not the severity,
  // is what keeps it off a green build.
  if (resolved.length === 0) {
    findings.push(makeFinding(
      'no-segments',
      `No segment was resolved from this manifest (${declared} declared), so the run has no evidence to pack and no verdict to give.`,
      { file: manifestFile },
    ))
    return withMaterial(material, finish({ declared }, null))
  }

  // Anything already reported as missing evidence stops the run here, before a
  // single packing decision is made. Packing what did parse would produce a
  // window that looks complete and is not -- a manifest whose citations do not
  // resolve, or whose segments could not all be read, has no correct pack, only
  // a plausible one.
  if (findings.some((finding) => INCOMPLETE_SET.has(finding.ruleId))) {
    return withMaterial(material, finish({ declared, checked: resolved.length }, null))
  }

  const { units, edges } = buildUnits(resolved)
  const closures = new Map()
  let depthExceeded = null
  for (const id of [...units.keys()].sort(byCodeUnit)) {
    const closure = closureOf(id, edges)
    closures.set(id, closure)
    if (closure.depth > limits.maxCitationDepth && depthExceeded === null) depthExceeded = { id, depth: closure.depth }
  }
  if (depthExceeded !== null) {
    findings.push(makeFinding(
      'citation-depth-exceeded',
      `Citations from unit "${sanitize(depthExceeded.id, 80)}" reach ${depthExceeded.depth} hops, above the maxCitationDepth limit of ${limits.maxCitationDepth}. Nothing was packed.`,
      { file: manifestFile },
    ))
    return withMaterial(material, finish({ declared, checked: resolved.length, units: units.size }, null))
  }

  for (const id of unitsInCycles(units, edges, closures)) {
    const unit = units.get(id)
    findings.push(makeFinding(
      'citation-cycle',
      `Unit "${sanitize(id, 80)}" is part of a citation cycle, so it is retained or dropped together with every unit in that cycle. Cycles are legal here; this is information, not a defect.`,
      { file: manifestFile, pointer: `/segments/${escapePointerSegment(unit.members[0])}/cites` },
    ))
  }

  const outcome = packUnits({ units, closures, budgetTokens, deadline })

  if (outcome.timedOut === true) {
    findings.push(makeFinding(
      'time-budget-exceeded',
      `The time budget of ${limits.timeoutMs}ms expired while choosing what fits, so this run packed nothing.`,
      { file: manifestFile },
    ))
    return withMaterial(material, finish({ declared, checked: resolved.length, units: units.size }, null))
  }

  const byId = new Map(resolved.map((segment) => [segment.id, segment]))

  if (outcome.overBudget === true) {
    const names = outcome.mandatoryUnits.map((id) => sanitize(id, 40)).join(', ')
    findings.push(makeFinding(
      'mandatory-over-budget',
      `The mandatory segments and everything they cite cost ${outcome.mandatoryTokens} tokens, which does not fit the budget of ${budgetTokens}. No pack was produced: dropping a mandatory segment to make room is not an option this tool has.`,
      { file: manifestFile },
      { evidence: sanitize(`mandatory units: ${names}`, 160) },
    ))
    return withMaterial(material, finish({
      declared,
      checked: resolved.length,
      units: units.size,
      mandatoryTokens: outcome.mandatoryTokens,
    }, null))
  }

  const retainedSegments = resolved
    .filter((segment) => outcome.selected.has(segment.unit))
    .sort(compareAssembly)
  const droppedSegments = resolved
    .filter((segment) => !outcome.selected.has(segment.unit))
    .sort(compareUnits)

  for (const unit of [...units.values()].sort(compareUnits)) {
    if (outcome.selected.has(unit.id)) continue
    const closureTokens = [...closures.get(unit.id).units]
      .reduce((total, id) => total + units.get(id).tokens, 0)
    if (closureTokens > budgetTokens) {
      findings.push(makeFinding(
        'unit-exceeds-budget',
        `Unit "${sanitize(unit.id, 80)}" costs ${closureTokens} tokens with its citations, more than the whole budget of ${budgetTokens}. No budget this run could free would make it fit.`,
        { file: manifestFile, pointer: `/segments/${escapePointerSegment(unit.members[0])}` },
      ))
    }
  }

  for (const segment of droppedSegments) {
    const reason = outcome.drops.get(segment.unit)
    findings.push(makeFinding(
      'segment-dropped',
      reason === undefined
        ? `Segment "${segment.id}" (unit "${sanitize(segment.unit, 40)}", priority ${segment.priority}) was dropped because its unit did not fit the remaining budget.`
        : `Segment "${segment.id}" (unit "${sanitize(segment.unit, 40)}", priority ${segment.priority}) was dropped: the unit and its citations cost ${reason.unitTokens} tokens and ${reason.remaining} were left.`,
      { file: manifestFile, pointer: `/segments/${escapePointerSegment(segment.id)}` },
      { unit: sanitize(segment.unit, 64), tokens: segment.tokens },
    ))
  }

  const pack = {
    budgetTokens,
    usedTokens: outcome.usedTokens,
    remainingTokens: budgetTokens - outcome.usedTokens,
    mandatoryTokens: outcome.mandatoryTokens,
    retained: retainedSegments.map((segment) => ({
      id: segment.id,
      unit: segment.unit,
      kind: segment.kind,
      priority: segment.priority,
      mandatory: segment.mandatory,
      tokens: segment.tokens,
      cites: [...segment.cites],
    })),
    dropped: droppedSegments.map((segment) => ({
      id: segment.id,
      unit: segment.unit,
      kind: segment.kind,
      priority: segment.priority,
      tokens: segment.tokens,
    })),
  }

  // The guarantees, re-checked on the real answer before it leaves the
  // function. If one of them is false the pack is not a smaller window, it is a
  // wrong one, and the run has no business reporting it.
  const violations = assertPackInvariants(pack, [...byId.values()])
  if (violations.length > 0) {
    throw new Error(`Packing invariant violated: ${violations.join('; ')}`)
  }

  return withMaterial(material, finish({
    declared,
    checked: resolved.length,
    units: units.size,
    retained: pack.retained.length,
    dropped: pack.dropped.length,
    usedTokens: pack.usedTokens,
    mandatoryTokens: pack.mandatoryTokens,
  }, pack))
}

/**
 * Pack a manifest and return only the report.
 *
 * This is the entry point almost every caller wants: the report is the product,
 * and the caller's own text stays out of it. `packContextWithMaterial` exists
 * for the one caller that needs the retained text back -- the CLI writing
 * `--pack-out` -- and it is a separate function rather than an extra field so
 * that no accidental `JSON.stringify(report)` can put a segment's contents on
 * stdout.
 */
export async function packContext(options = {}) {
  const { report } = await packContextWithMaterial(options)
  return report
}

/**
 * The packed window as a document, in assembly order.
 *
 * Segment text is **verbatim**: this is the caller's own material on its way
 * back out, and sanitising it would corrupt the thing being packed. The report
 * is the sanitised surface; this file is not. Callers assemble the final prompt
 * from `segments[].text` themselves, which is why this is JSON and not a
 * delimiter-joined blob a document could forge a delimiter into.
 */
export function assemblePack(report, segmentsById) {
  if (report.pack === null) return null
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    tool: TOOL_ID,
    budgetTokens: report.pack.budgetTokens,
    usedTokens: report.pack.usedTokens,
    segments: report.pack.retained.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      priority: entry.priority,
      mandatory: entry.mandatory,
      tokens: entry.tokens,
      text: segmentsById.get(entry.id) ?? '',
    })),
  }
}

export function formatReport(report) {
  const lines = report.findings.map((finding) =>
    `${finding.severity.toUpperCase().padEnd(7)} ${finding.location.file}${finding.location.pointer ?? ''} ${finding.ruleId} ${finding.message}`)
  lines.push('')
  lines.push(
    `${report.summary.checked} of ${report.summary.declared} segment(s) resolved in ${report.summary.units} unit(s) `
    + `using the ${report.summary.tokenCost} cost model: ${report.summary.errors} error, `
    + `${report.summary.warnings} warning, ${report.summary.info} info, status ${report.status}.`,
  )
  if (report.pack === null) {
    lines.push(`No pack was produced. Budget ${report.summary.budgetTokens} token(s); mandatory material costs ${report.summary.mandatoryTokens}.`)
  } else {
    lines.push(
      `Retained ${report.summary.retained} segment(s) for ${report.pack.usedTokens} of ${report.pack.budgetTokens} token(s) `
      + `(${report.pack.remainingTokens} left, ${report.pack.mandatoryTokens} of them mandatory); dropped ${report.summary.dropped}.`,
    )
  }
  if (report.summary.unexamined > 0) {
    lines.push(`${report.summary.unexamined} piece(s) of evidence were not obtained, so this run is incomplete rather than a verdict.`)
  }
  return `${lines.join('\n')}\n`
}
