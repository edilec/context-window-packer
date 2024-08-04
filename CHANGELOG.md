# Changelog

All notable changes to this project are documented here. Rule ids are part of
the public contract: renaming one is a breaking change and is recorded here.

## 0.1.0

First working release.

- Packs manifest-declared segments into a token budget by stable priority.
- Mandatory segments and their citation closure are selected first; an
  over-budget mandatory set produces `mandatory-over-budget`, no pack, and
  exit 1.
- Atomic units (`unit`) are retained or dropped whole.
- Citation targets (`cites`) are retained transitively with the segments that
  cite them; cycles are legal and reported as information.
- Two token cost models, `declared` and `estimate`, with no default.
- Every dropped segment gets its own finding naming its cost and what was left.
- Missing, undecodable, unparseable or bounded-out evidence produces an
  `incomplete` report with no pack and exit 2.
- `--pack-out` writes the retained segments and their verbatim text as JSON to a
  destination that is checked before it is opened: not a symbolic link, not a
  directory, and not any file this run read -- the manifest, a segment or the
  configuration file -- whether it is named directly, reached through a link, or
  hard-linked to one of them under a different name.

### Fixed before release

Adversarial verification of the write path found three ways `--pack-out`
destroyed a file it was never asked to touch, each of them exiting 0 and
reporting that the pack had been written. The guard compared the real path of
the destination against the real path of the manifest, which catches one
spelling of one of the three.

- A symbolic link at `--pack-out` was resolved and written through, destroying a
  file outside the tree entirely.
- Naming a segment file destroyed a document the same run had just read: only
  the manifest was ever compared.
- A hard link to the manifest destroyed the manifest, because it shares no path
  with it and `realpath` reports it as a different file.

All three are refused now, by `assertWritableDestination` in
`src/destination.mjs` -- `lstat` before anything resolves, device and inode
against every file the run read, and `O_NOFOLLOW` at the open for the window in
between. `test/destination.test.mjs` has one case per hole and one per
legitimate destination, because a guard that refuses everything passes a
data-loss test while making `--pack-out` useless.
