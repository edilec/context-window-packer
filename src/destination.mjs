/**
 * The write guard: refuse a `--pack-out` destination that would write somewhere
 * the caller did not name, or over something this run is reading.
 *
 * Copied into this package rather than imported: zero dependencies means there
 * is no shared library to put it in, and a guard that lives somewhere else is a
 * guard this package cannot prove it runs. The proof is
 * `test/destination.test.mjs`, which has one case per hole plus the legitimate
 * destinations that must still be allowed -- a guard that refuses everything
 * passes a data-loss test while making `--pack-out` useless.
 *
 * `root` is left null by this tool's CLI and the check is still written and
 * still tested. `--pack-out` names a file anywhere the operator likes, so there
 * is no boundary for a resolved parent to be confined *inside*. The root check
 * is pinned by a unit case so the copy stays the guard rather than drifting
 * into a subset of it.
 *
 * What this tool needs is the opposite boundary, and `assertOutsideRoot` below
 * is it: the destination may be anywhere except inside the tree the run reads.
 * That rule is this package's own, not part of the copied guard, so it lives in
 * its own function and the copy stays comparable to the reference.
 */

import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** Raised when a destination cannot be written to safely. The caller exits 2. */
export class DestinationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DestinationError'
  }
}

/**
 * The real path of `directory`, or the closest existing ancestor with the
 * missing segments appended.
 *
 * `realpath` fails outright on a directory that is not there, and the CLI
 * creates the destination's parent, so the parent frequently does not exist
 * yet at the moment it has to be judged. Falling back to the lexical path
 * would be a lexical check wearing a resolved check's uniform: with
 * `outside/link -> root`, the parent `outside/link/new` does not exist,
 * `realpath` fails, and a lexical comparison sees nothing inside the root while
 * the write lands in it.
 */
async function realDirectoryOrNearest(directory) {
  const wanted = resolve(directory)
  let current = wanted
  const missing = []
  for (;;) {
    try {
      return join(await realpath(current), ...missing)
    } catch {
      const parent = dirname(current)
      if (parent === current) return wanted
      missing.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Refuse a destination that lands inside the tree this run reads.
 *
 * This tool's own rule rather than part of the copied guard above, and the
 * inverse of that guard's `root` option: `--pack-out` is confined *out of* the
 * root, not into one. A pack written into the tree the next run reads is read
 * back as material -- and on the way there it overwrites whatever file it
 * names, which need not be a file this particular run happened to open. That is
 * how a manifest's sibling document gets destroyed at exit 0 with `wrote N
 * retained segment(s)` on stderr.
 *
 * The parent is **resolved** before it is compared, for the same reason hole 2
 * exists: a lexical prefix test passes for `outside/link/pack.json` where
 * `link` points into the root, and for a `..` segment that walks back into it.
 * Outside the root the destination stays unconfined, which is deliberate and
 * said so in `--help`.
 *
 * @throws {DestinationError} when the destination would land inside the root.
 */
export async function assertOutsideRoot(destination, root, label = '--pack-out') {
  const realRoot = await realpath(resolve(root))
  const parent = await realDirectoryOrNearest(dirname(resolve(destination)))
  if (parent === realRoot || parent.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) {
    throw new DestinationError(
      `${label} resolves into ${realRoot}, the tree this run reads. A pack written there is `
      + `read back as material by the next run, and it overwrites whatever file it names on the `
      + `way. A link or a ".." segment on the way in does not make it a different tree. `
      + `Name a destination outside the root.`,
    )
  }
}

/**
 * Refuse an output destination that would write somewhere the caller did not
 * name, or over something the caller is reading.
 *
 * Three distinct holes, and each needs its own check because no one of them
 * catches the others:
 *
 * 1. A SYMLINK AT THE DESTINATION writes wherever the link points, which may be
 *    anywhere on the machine. `realpath` on the destination does not help --
 *    it resolves the link, and resolving is precisely the dangerous act. The
 *    link is refused on sight, by `lstat`, before anything is opened.
 * 2. A SYMLINKED PARENT does the same thing one level up, so the parent is
 *    resolved and checked against the root rather than compared lexically.
 *    Lexical comparison passes for `root/link/out` where `link` leaves the root.
 * 3. A HARD LINK TO AN INPUT has no target to resolve and shares no path with
 *    it, so realpath and string comparison both say it is a different file. It
 *    is the same file. Only device plus inode sees that.
 *
 * Measured across this catalog: ten tools accepted a destination that destroyed
 * a file they were never asked to touch, and four exited 0 reporting success.
 * This tool was one of them, three times over. Its previous guard compared the
 * real path of the destination against the real path of the manifest, which
 * caught one spelling of one of the three: a symbolic link at `--pack-out`
 * destroyed a file outside the tree, naming a segment file destroyed a
 * document the same run had just read, and a hard link to the manifest
 * destroyed the manifest -- every one of them exiting 0 and reporting that the
 * pack had been written.
 */
export async function assertWritableDestination(destination, options = {}) {
  const { inputs = [], root = null, label = '--pack-out' } = options
  const target = resolve(destination)

  let existing = null
  try {
    existing = await lstat(target)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new DestinationError(`${label} could not be inspected: ${error.code ?? 'unknown error'}`)
    }
  }

  if (existing !== null && existing.isSymbolicLink()) {
    throw new DestinationError(
      `${label} is a symbolic link. Writing through it would put the output wherever `
      + `the link points, which is not the path you named, so it is refused. `
      + `Name the real destination.`,
    )
  }
  if (existing !== null && !existing.isFile()) {
    throw new DestinationError(`${label} exists and is not a regular file.`)
  }

  let parent
  try {
    parent = await realpath(dirname(target))
  } catch {
    throw new DestinationError(`${label} names a directory that does not exist.`)
  }

  if (root !== null) {
    const base = await realpath(resolve(root))
    if (parent !== base && !parent.startsWith(base + sep)) {
      throw new DestinationError(
        `${label} resolves to ${parent}, which is outside the permitted root. `
        + `A link or a ".." segment on the way there does not widen it.`,
      )
    }
  }

  if (existing === null) return target

  // Same file as an input? Compare identity, not paths.
  for (const input of inputs) {
    let source
    try {
      source = await stat(input)
    } catch {
      continue
    }
    if (source.dev === existing.dev && source.ino === existing.ino) {
      throw new DestinationError(
        `${label} is the same file as an input (they share device ${existing.dev} and `
        + `inode ${existing.ino}, so a hard link does not make them different files). `
        + `This tool never rewrites what it reads.`,
      )
    }
  }
  return target
}
