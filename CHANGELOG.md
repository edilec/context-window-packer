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
  destination that may not be the manifest.
