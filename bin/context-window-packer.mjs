#!/usr/bin/env node

import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import {
  assemblePack, formatReport, loadConfigFile, packContextWithMaterial,
} from '../src/index.mjs'

const HELP = `context-window-packer

Decide which of a manifest's document segments fit a token budget, and report
exactly what was left out and why. Nothing is fetched, and nothing is written
unless --pack-out asks for it.

Usage:
  context-window-packer --manifest FILE --budget-tokens N
                        --token-cost declared|estimate
                        [--root DIR] [--config FILE] [--pack-out FILE]
                        [--json] [limits]

Options:
  --manifest FILE        Pack manifest to read (required)
  --budget-tokens N      Size of the context window, in tokens (required
                         unless the configuration file supplies it)
  --token-cost MODEL     declared | estimate (required unless the configuration
                         file supplies it)
  --root DIR             Root every reported path is relative to, and the
                         boundary of what may be read (default: the directory
                         holding the manifest)
  --config FILE          JSON configuration: tokenCost, budgetTokens, limits
  --pack-out FILE        Write the retained segments, with their text, as JSON
  --json                 Emit the machine-readable report on stdout
  --max-citation-depth N Maximum citation hops from one unit (default 8)
  --max-citations N      Maximum citations per segment (default 20)
  --max-manifest-bytes N Maximum manifest size (default 1048576)
  --max-segment-bytes N  Maximum size of one segment file (default 262144)
  --max-segments N       Maximum segments in a manifest (default 500)
  --max-text-chars N     Maximum characters in one segment (default 200000)
  --timeout-ms N         Time budget for the whole run (default 10000; 0 leaves
                         no time at all and is only useful for proving the
                         budget is enforced)
  -h, --help             Show this help

Cost models. There is no default, because the two can disagree by a wide
margin and the disagreement is the whole verdict:

  declared  every segment carries its own integer "tokens", counted by whatever
            tokenizer your model actually uses. A segment without one is
            missing evidence, not a free segment.
  estimate  the built-in heuristic counts: an alphanumeric run costs
            ceil(length / 4), every other non-whitespace character costs 1,
            whitespace is free. It is an estimate, not byte-pair encoding and
            not any model's tokenizer. A segment that also declares "tokens" is
            refused rather than silently overridden.

What cannot happen:

  - A mandatory segment is never dropped to make room. If the mandatory
    segments and everything they cite do not fit, the run reports
    mandatory-over-budget, produces no pack, and exits 1.
  - A retained claim never loses a citation. Selection works on the transitive
    closure of the citation graph, so a claim and its evidence travel together.
  - A segment sharing a "unit" name with others is retained or dropped with
    them; half an atomic unit is never packed.
  - Unknown evidence is never a pass. An unreadable manifest, an unreadable
    segment, a missing declared token count, a limit reached or a time budget
    expired all produce an "incomplete" report with no pack, and exit 2.

Every option is accepted once; a repeated flag is a configuration error rather
than a silent last-wins. An unknown option is refused rather than ignored.

Exit codes:
  0  the manifest was read and everything mandatory fits the budget
  1  the manifest was read and the mandatory material does not fit
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, undecodable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-citation-depth', 'maxCitationDepth'],
  ['--max-citations', 'maxCitations'],
  ['--max-manifest-bytes', 'maxManifestBytes'],
  ['--max-segment-bytes', 'maxSegmentBytes'],
  ['--max-segments', 'maxSegments'],
  ['--max-text-chars', 'maxTextChars'],
  ['--timeout-ms', 'timeoutMs'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = {
    manifest: null, root: null, budgetTokens: null, tokenCost: null,
    config: null, packOut: null, json: false, limits: {},
  }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--budget-tokens 8000 --budget-tokens 80` packs against a budget nobody
   * asked for. That is the same defect as an ignored typo, which this tool
   * already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') {
      once('--json')
      options.json = true
    } else if (argument === '--manifest') {
      once('--manifest')
      options.manifest = takeValue('--manifest')
    } else if (argument === '--root') {
      once('--root')
      options.root = takeValue('--root')
    } else if (argument === '--config') {
      once('--config')
      options.config = takeValue('--config')
    } else if (argument === '--pack-out') {
      once('--pack-out')
      options.packOut = takeValue('--pack-out')
    } else if (argument === '--token-cost') {
      once('--token-cost')
      options.tokenCost = takeValue('--token-cost')
    } else if (argument === '--budget-tokens') {
      once('--budget-tokens')
      const raw = takeValue('--budget-tokens')
      if (!/^\d+$/.test(raw)) throw new Error('--budget-tokens requires an integer of 0 or more')
      options.budgetTokens = Number(raw)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      const minimum = argument === '--timeout-ms' ? 0 : 1
      if (!/^\d+$/.test(raw) || Number(raw) < minimum) {
        throw new Error(`${argument} requires an integer of ${minimum} or more`)
      }
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.manifest === null) throw new Error('--manifest is required')
  return options
}

/**
 * Refuse to write the pack over one of the inputs.
 *
 * Read-only by default is the contract; the one file this tool writes goes to a
 * destination the operator names, and naming an input is how a manifest gets
 * destroyed by a typo. Compared on real paths where the destination already
 * exists, so a symlink pointing back at an input is caught too.
 */
async function assertSeparateDestination(packOut, manifestPath) {
  const target = resolve(packOut)
  let realTarget = target
  try {
    realTarget = await realpath(target)
  } catch {
    realTarget = target
  }
  let realManifest = resolve(manifestPath)
  try {
    realManifest = await realpath(realManifest)
  } catch {
    // An unreadable manifest is reported by the run itself; here it simply
    // cannot collide with the destination.
  }
  if (realTarget === realManifest) {
    throw new Error('--pack-out names the manifest; the pack is written to a separate destination, never over an input')
  }
  return target
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let config = { tokenCost: null, budgetTokens: null, limits: {} }
  if (options.config !== null) {
    try {
      config = await loadConfigFile(options.config)
    } catch (error) {
      process.stderr.write(`--config is not usable: ${error.message}\n`)
      return 2
    }
  }

  const tokenCost = options.tokenCost ?? config.tokenCost
  if (tokenCost === null || tokenCost === undefined) {
    process.stderr.write('A token cost model is required: pass --token-cost, or declare "tokenCost" in the configuration file.\n')
    return 2
  }
  const budgetTokens = options.budgetTokens ?? config.budgetTokens
  if (budgetTokens === null || budgetTokens === undefined) {
    process.stderr.write('A budget is required: pass --budget-tokens, or declare "budgetTokens" in the configuration file.\n')
    return 2
  }

  let destination = null
  if (options.packOut !== null) {
    try {
      destination = await assertSeparateDestination(options.packOut, options.manifest)
    } catch (error) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
  }

  // Which source decided the budget and the cost model is a diagnostic, not
  // data: it goes to stderr so stdout stays parseable, but it is never left
  // unsaid, because a run whose budget came from somewhere the operator forgot
  // about is exactly the run that reports the wrong verdict.
  process.stderr.write(
    `budget ${budgetTokens} token(s) from ${options.budgetTokens === null ? 'the configuration file' : '--budget-tokens'}, `
    + `cost model ${tokenCost} from ${options.tokenCost === null ? 'the configuration file' : '--token-cost'}\n`,
  )

  let report
  let material
  try {
    ;({ report, material } = await packContextWithMaterial({
      manifest: options.manifest,
      ...(options.root === null ? {} : { root: options.root }),
      budgetTokens,
      tokenCost,
      limits: { ...config.limits, ...options.limits },
    }))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  if (destination !== null) {
    const assembled = assemblePack(report, material)
    if (assembled === null) {
      process.stderr.write('No pack was produced, so nothing was written to --pack-out.\n')
    } else {
      try {
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, `${JSON.stringify(assembled, null, 2)}\n`, 'utf8')
      } catch (error) {
        process.stderr.write(`--pack-out could not be written: ${error.code ?? error.message}\n`)
        return 2
      }
      process.stderr.write(`wrote ${assembled.segments.length} retained segment(s) to the pack destination\n`)
    }
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))

  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.unexamined} piece(s) of evidence were not obtained, so no pack was produced.\n`,
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
