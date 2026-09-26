/**
 * Manifest shape and validation.
 *
 * The manifest is untrusted data. Every key it may carry is listed here, an
 * unknown key is refused rather than ignored, and every string that reaches a
 * problem message is sanitised on the way out -- including the identifiers,
 * which is where a control character forges a line in a human report.
 *
 * Nothing in this module reads a file. It validates a parsed document and
 * returns problems; the caller decides what a problem means for the run.
 */

import { byCodeUnit, escapePointerSegment, sanitize } from './text.mjs'

export const MANIFEST_SCHEMA_VERSION = '1'

/**
 * What a segment is for. Purely descriptive of the caller's material, but the
 * ranking below is part of the output contract: it decides the order retained
 * segments are assembled in, so mandatory instructions lead the packed context
 * rather than landing wherever their priority happened to put them.
 */
export const SEGMENT_KINDS = Object.freeze(['instruction', 'claim', 'evidence', 'context'])
export const KIND_RANK = Object.freeze({ instruction: 0, claim: 1, evidence: 2, context: 3 })

/**
 * Identifiers are constrained, and the constraint is enforced with a message
 * that sanitises the offending id. Refusing a bad id and then printing it raw
 * moves the hole rather than closing it.
 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export const MANIFEST_KEYS = Object.freeze(['schemaVersion', 'segments'])
export const SEGMENT_KEYS = Object.freeze(['cites', 'file', 'kind', 'mandatory', 'priority', 'text', 'tokens', 'unit'])

export const MAX_PRIORITY = 1000

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function problem(ruleId, pointer, message, evidence) {
  return evidence === undefined ? { ruleId, pointer, message } : { ruleId, pointer, message, evidence }
}

/**
 * Validate a parsed manifest document.
 *
 * Returns `{ segments, problems }`. `segments` holds only the entries that
 * survived validation, ordered by id with `byCodeUnit` -- never by the object's
 * own key order, because JSON key order is an accident of how the file was
 * written and output that depends on it is not reproducible.
 *
 * Every problem here means the manifest could not be interpreted as written, so
 * the caller treats all of them as missing evidence rather than as a verdict.
 */
export function validateManifest(document, limits) {
  const problems = []
  if (!isRecord(document)) {
    return { segments: [], problems: [problem('manifest-malformed', '', 'The manifest must be a JSON object.')] }
  }
  if (document.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    problems.push(problem(
      'manifest-schema-unsupported',
      '/schemaVersion',
      `Unsupported manifest schemaVersion "${sanitize(String(document.schemaVersion ?? 'missing'), 40)}"; this tool reads version ${MANIFEST_SCHEMA_VERSION}.`,
    ))
  }
  for (const key of Object.keys(document).sort(byCodeUnit)) {
    if (!MANIFEST_KEYS.includes(key)) {
      problems.push(problem(
        'manifest-unknown-key',
        `/${escapePointerSegment(key)}`,
        `Unknown manifest key "${sanitize(key, 60)}"; this tool accepts ${MANIFEST_KEYS.join(', ')}. A misspelled key that is ignored turns a real instruction into no instruction at all.`,
      ))
    }
  }
  if (!isRecord(document.segments)) {
    problems.push(problem('manifest-malformed', '/segments', 'The "segments" key must be a JSON object keyed by segment id.'))
    return { segments: [], problems }
  }

  const ids = Object.keys(document.segments).sort(byCodeUnit)
  if (ids.length > limits.maxSegments) {
    problems.push(problem(
      'too-many-segments',
      '/segments',
      `The manifest declares ${ids.length} segments, above the maxSegments limit of ${limits.maxSegments}. Raise --max-segments or split the manifest; this run read none of them.`,
    ))
    return { segments: [], problems }
  }

  const segments = []
  const known = new Set()
  for (const id of ids) {
    const pointer = `/segments/${escapePointerSegment(id)}`
    if (!ID_PATTERN.test(id)) {
      problems.push(problem(
        'segment-id-invalid',
        pointer,
        `Segment id "${sanitize(id, 80)}" is not a valid identifier; ids are 1-64 characters of letters, digits, dot, dash or underscore and start with a letter or digit.`,
        sanitize(id, 80),
      ))
      continue
    }
    known.add(id)
    const raw = document.segments[id]
    if (!isRecord(raw)) {
      problems.push(problem('segment-malformed', pointer, `Segment "${id}" must be a JSON object.`))
      continue
    }

    let rejected = false
    const reject = (ruleId, at, message, evidence) => {
      problems.push(problem(ruleId, at, message, evidence))
      rejected = true
    }

    for (const key of Object.keys(raw).sort(byCodeUnit)) {
      if (!SEGMENT_KEYS.includes(key)) {
        reject(
          'segment-unknown-key',
          `${pointer}/${escapePointerSegment(key)}`,
          `Segment "${id}" carries unknown key "${sanitize(key, 60)}"; a segment accepts ${SEGMENT_KEYS.join(', ')}.`,
        )
      }
    }

    if (typeof raw.kind !== 'string' || !SEGMENT_KINDS.includes(raw.kind)) {
      reject(
        'segment-kind-unknown',
        `${pointer}/kind`,
        `Segment "${id}" has kind "${sanitize(String(raw.kind ?? 'missing'), 40)}"; kind must be one of ${SEGMENT_KINDS.join(', ')}.`,
      )
    }

    if (!Number.isInteger(raw.priority) || raw.priority < 0 || raw.priority > MAX_PRIORITY) {
      reject(
        'segment-malformed',
        `${pointer}/priority`,
        `Segment "${id}" needs an integer "priority" between 0 and ${MAX_PRIORITY}; lower is packed first.`,
      )
    }

    if (raw.mandatory !== undefined && typeof raw.mandatory !== 'boolean') {
      reject('segment-malformed', `${pointer}/mandatory`, `Segment "${id}" has a non-boolean "mandatory".`)
    }

    if (raw.unit !== undefined && (typeof raw.unit !== 'string' || !ID_PATTERN.test(raw.unit))) {
      reject(
        'segment-malformed',
        `${pointer}/unit`,
        `Segment "${id}" has an invalid atomic unit name "${sanitize(String(raw.unit), 80)}"; a unit name follows the same rule as an id.`,
      )
    }

    const hasText = raw.text !== undefined
    const hasFile = raw.file !== undefined
    if (hasText === hasFile) {
      reject(
        'segment-source-missing',
        pointer,
        `Segment "${id}" must carry exactly one of "text" or "file"; it carries ${hasText ? 'both' : 'neither'}.`,
      )
    }
    if (hasText && typeof raw.text !== 'string') {
      reject('segment-malformed', `${pointer}/text`, `Segment "${id}" has a non-string "text".`)
    }
    if (hasFile && (typeof raw.file !== 'string' || raw.file.trim() === '')) {
      reject('segment-malformed', `${pointer}/file`, `Segment "${id}" has an empty or non-string "file".`)
    }

    if (raw.tokens !== undefined && (!Number.isInteger(raw.tokens) || raw.tokens < 0)) {
      reject('segment-malformed', `${pointer}/tokens`, `Segment "${id}" has a "tokens" value that is not a non-negative integer.`)
    }

    let cites = []
    if (raw.cites !== undefined) {
      if (!Array.isArray(raw.cites)) {
        reject('segment-malformed', `${pointer}/cites`, `Segment "${id}" has a non-array "cites".`)
      } else if (raw.cites.length > limits.maxCitations) {
        reject(
          'too-many-citations',
          `${pointer}/cites`,
          `Segment "${id}" cites ${raw.cites.length} targets, above the maxCitations limit of ${limits.maxCitations}.`,
        )
      } else {
        for (const target of raw.cites) {
          if (typeof target !== 'string' || !ID_PATTERN.test(target)) {
            reject(
              'segment-malformed',
              `${pointer}/cites`,
              `Segment "${id}" cites "${sanitize(String(target), 80)}", which is not a valid segment id.`,
            )
          }
        }
        cites = [...new Set(raw.cites)].sort(byCodeUnit)
      }
    }

    if (rejected) continue

    segments.push(Object.freeze({
      id,
      kind: raw.kind,
      priority: raw.priority,
      mandatory: raw.mandatory === true,
      unit: raw.unit ?? id,
      cites: Object.freeze(cites),
      text: hasText ? raw.text : null,
      file: hasFile ? raw.file : null,
      declaredTokens: raw.tokens === undefined ? null : raw.tokens,
    }))
  }

  // Resolved last, so a citation of a segment that failed its own validation is
  // reported as unresolved rather than silently satisfied by a segment that is
  // not in the pack.
  const surviving = new Set(segments.map((segment) => segment.id))
  for (const segment of segments) {
    for (const target of segment.cites) {
      if (surviving.has(target)) continue
      problems.push(problem(
        'citation-unresolved',
        `/segments/${escapePointerSegment(segment.id)}/cites`,
        known.has(target)
          ? `Segment "${segment.id}" cites "${sanitize(target, 80)}", which is declared but did not survive validation, so the citation cannot be honoured.`
          : `Segment "${segment.id}" cites "${sanitize(target, 80)}", which no segment declares.`,
        sanitize(target, 80),
      ))
    }
  }

  return { segments, problems }
}
