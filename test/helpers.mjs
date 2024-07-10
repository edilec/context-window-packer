/**
 * Fixture helpers shared by the suite.
 *
 * Every fixture lives in a fresh temporary directory: a test that writes into
 * the repository leaves the next run a different subject, and this tool's whole
 * claim is that the same subject produces the same bytes.
 */

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BIN = fileURLToPath(new URL('../bin/context-window-packer.mjs', import.meta.url))

/** Create a temporary tree. Values are strings or byte arrays, written as-is. */
export async function makeTree(files) {
  const root = await mkdtemp(join(tmpdir(), 'context-window-packer-'))
  for (const name of Object.keys(files).sort()) {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true })
    const content = files[name]
    await writeFile(path, content instanceof Uint8Array ? content : String(content))
  }
  return root
}

export async function cleanup(root) {
  await rm(root, { recursive: true, force: true })
}

/** A manifest document, written the way a caller would. */
export function manifest(segments, extra = {}) {
  return JSON.stringify({ schemaVersion: '1', segments, ...extra }, null, 2)
}

/** Run the real CLI and return its streams and exit status. */
export function runCli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Run the real CLI over a fixture and parse the JSON report.
 *
 * Deliberately goes through the process boundary rather than calling the
 * library: an exit code is the one assertion nobody can satisfy by editing a
 * table, and the JSON on stdout is what a consumer actually receives.
 */
export function runReport(root, args) {
  const result = runCli(['--manifest', join(root, 'manifest.json'), '--root', root, '--json', ...args])
  return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
}

export function findingsFor(report, ruleId) {
  return report.findings.filter((finding) => finding.ruleId === ruleId)
}

export function findingFor(report, ruleId) {
  const matches = findingsFor(report, ruleId)
  if (matches.length === 0) throw new Error(`no finding for rule "${ruleId}"`)
  return matches[0]
}
