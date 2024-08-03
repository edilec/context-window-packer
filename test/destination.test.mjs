/**
 * The write guard on `--pack-out`, with one case per hole and one per
 * legitimate destination.
 *
 * This tool shipped all three holes open behind a guard that compared the real
 * path of the destination against the real path of the manifest. Every one of
 * the three exited 0 and reported that the pack had been written:
 *
 *   - a symbolic link at `--pack-out` destroyed a file outside the tree;
 *   - naming a segment file destroyed a document the same run had just read,
 *     because only the manifest was compared;
 *   - a hard link to the manifest destroyed the manifest, because it shares no
 *     path with it and `realpath` calls it a different file.
 *
 * The allowed cases are not optional: a guard that refuses every destination
 * passes all three cases above while making `--pack-out` useless.
 */

import assert from 'node:assert/strict'
import { link, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { DestinationError, assertWritableDestination } from '../src/destination.mjs'
import { cleanup, makeTree, manifest, runCli } from './helpers.mjs'

const KEPT = 'NOTES-THE-USER-KEPT-HERE\n'
const SEGMENT = 'the segment text the user wrote\n'

const TREE = {
  'manifest.json': manifest({
    good: { kind: 'instruction', priority: 0, mandatory: true, tokens: 5, file: 'segments/background.md' },
  }),
  'segments/background.md': SEGMENT,
}

/** A fixture root, an output directory beside it, and somewhere a link can point. */
async function withTree(t) {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))
  const out = join(root, '..', `${root.split('/').pop()}-out`)
  const elsewhere = join(root, '..', `${root.split('/').pop()}-elsewhere`)
  await mkdir(out, { recursive: true })
  await mkdir(elsewhere, { recursive: true })
  t.after(() => cleanup(out))
  t.after(() => cleanup(elsewhere))
  return { root, out, elsewhere }
}

const pack = (root, destination) => runCli([
  '--manifest', join(root, 'manifest.json'), '--root', root, '--json',
  '--token-cost', 'declared', '--budget-tokens', '100', '--pack-out', destination,
])

test('hole 1: a symbolic link at --pack-out is refused, and the file it points at survives', async (t) => {
  const { root, out, elsewhere } = await withTree(t)
  const victim = join(elsewhere, 'notes.txt')
  await writeFile(victim, KEPT)
  await symlink(victim, join(out, 'packed.json'))

  const result = pack(root, join(out, 'packed.json'))
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stdout, '', 'a refused destination is a configuration error, so stdout stays empty')
  assert.match(result.stderr, /symbolic link/)
  assert.equal(await readFile(victim, 'utf8'), KEPT, 'the file outside the tree is untouched')
})

test('hole 1b: a dangling link creates nothing where it points', async (t) => {
  const { root, out, elsewhere } = await withTree(t)
  await symlink(join(elsewhere, 'created-outside.json'), join(out, 'packed.json'))

  const result = pack(root, join(out, 'packed.json'))
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.deepEqual(await readdir(elsewhere), [], 'nothing was created outside the named path')
})

test('hole 2: a resolved parent outside the permitted root is refused by the guard itself', async (t) => {
  /**
   * This tool's CLI passes no root -- `--pack-out` names a file anywhere the
   * operator likes, deliberately, because writing a pack into the tree the next
   * run reads is the thing to avoid. The check is still part of the guard and
   * is still pinned here, so the copy stays the guard rather than drifting into
   * a subset of it: a lexical prefix test passes for `out/link/pack.json` where
   * `link` leaves the directory, and only resolving the parent sees it.
   */
  const { out, elsewhere } = await withTree(t)
  await symlink(elsewhere, join(out, 'link'))

  await assert.rejects(
    () => assertWritableDestination(join(out, 'link', 'pack.json'), { root: out }),
    (error) => error instanceof DestinationError && /outside the permitted root/.test(error.message),
  )
  await assert.rejects(
    () => assertWritableDestination(join(out, '..', 'escaped.json'), { root: out }),
    DestinationError,
  )
  await assert.doesNotReject(
    () => assertWritableDestination(join(out, 'pack.json'), { root: out }),
    'the same root still allows the destination inside it',
  )
})

test('hole 3: a hard link to an input is refused, and the input survives', async (t) => {
  const { root, out } = await withTree(t)
  const target = join(out, 'packed.json')
  await link(join(root, 'manifest.json'), target)

  const result = pack(root, target)
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /same file as an input/)
  assert.equal(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')).schemaVersion, '1')
})

test('a segment file this run read is an input too, not just the manifest', async (t) => {
  // The previous guard compared the destination against the manifest alone, so
  // naming a segment file destroyed a document the same run had just read and
  // exited 0 saying the pack was written.
  const { root } = await withTree(t)
  const segment = join(root, 'segments', 'background.md')

  const result = pack(root, segment)
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /same file as an input/)
  assert.equal(await readFile(segment, 'utf8'), SEGMENT, 'the segment is byte-identical')
})

test('a hard link to a segment file is refused as well', async (t) => {
  const { root, out } = await withTree(t)
  const target = join(out, 'packed.json')
  await link(join(root, 'segments', 'background.md'), target)

  const result = pack(root, target)
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /same file as an input/)
  assert.equal(await readFile(join(root, 'segments', 'background.md'), 'utf8'), SEGMENT)
})

test('a destination that is a directory is refused', async (t) => {
  const { root, out } = await withTree(t)
  await mkdir(join(out, 'packed.json'))
  const result = pack(root, join(out, 'packed.json'))
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /not a regular file/)
})

test('allowed: a fresh destination is written, including one whose directory does not exist yet', async (t) => {
  const { root, out } = await withTree(t)
  const destination = join(out, 'nested', 'packed.json')

  const result = pack(root, destination)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /wrote 1 retained segment\(s\)/)
  const written = JSON.parse(await readFile(destination, 'utf8'))
  assert.equal(written.tool, 'context-window-packer')
  assert.equal(written.segments[0].text, SEGMENT)
})

test('allowed: writing over this tool\'s own previous pack', async (t) => {
  const { root, out } = await withTree(t)
  const destination = join(out, 'packed.json')

  assert.equal(pack(root, destination).status, 0)
  const first = await readFile(destination, 'utf8')
  assert.equal(pack(root, destination).status, 0, 'a second run is not refused')
  assert.equal(await readFile(destination, 'utf8'), first, 'and produces the same bytes')
})

test('allowed: a destination reached through a linked ancestor', async (t) => {
  // The false refusal is a defect too, and this is the shape that produces it:
  // on macOS every temporary directory sits under a symbolic link, so a guard
  // that refuses a linked ancestor refuses the ordinary case.
  const { root, out } = await withTree(t)
  const linked = join(out, 'linked')
  await symlink(out, linked)

  const result = pack(root, join(linked, 'packed.json'))
  assert.equal(result.status, 0, result.stderr)
  assert.equal((await readdir(out)).includes('packed.json'), true)
})

test('allowed: other files beside the destination are left alone', async (t) => {
  const { root, out } = await withTree(t)
  const bystander = join(out, 'somebody-elses-notes.txt')
  await writeFile(bystander, KEPT)

  assert.equal(pack(root, join(out, 'packed.json')).status, 0)
  assert.equal(await readFile(bystander, 'utf8'), KEPT)
})

test('the identity comparison is the one a stat makes', async (t) => {
  // Pins the comparison rather than the message: a hard link shares the device
  // and inode of the file it links to, which is the only thing separating it
  // from an unrelated path.
  const { root, out } = await withTree(t)
  const source = join(root, 'manifest.json')
  const hard = join(out, 'hard.json')
  await link(source, hard)

  const [a, b] = [await stat(source), await stat(hard)]
  assert.equal(a.dev === b.dev && a.ino === b.ino, true)
  await assert.rejects(() => assertWritableDestination(hard, { inputs: [source] }), /same file as an input/)
  await assert.doesNotReject(() => assertWritableDestination(hard, { inputs: [] }))
})
