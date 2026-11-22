# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/NgademinSikil/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/NgademinSikil/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** is one command-line tool that applies the edits AI models write, in
four formats, to a tree of files — built for the [make.fun "Build mend, one
patch tool for every AI edit format" bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?ref=ds1567x3).
`SPEC.md` is the whole specification.

    node main.ts [options] [PATCH]

## The formats

- **Unified diffs** — including ones with wrong line numbers: hunks are found
  by their content, not their `@@` counts, and a rename is reported as
  `R <old> -> <new>`.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`,
  with the file path on the line above the first block and inherited by the
  blocks after it.
- **V4A patches** — `*** Begin Patch` … `*** End Patch`, with `*** Add File:`,
  `*** Delete File:` and `*** Update File:` sections, `@@` anchors,
  `*** Move to:` and `*** End of File`.
- **Text-editor tool calls as JSON** — one object per line, or a JSON array:
  `create`, `str_replace` and `insert`.

## Matching

Edits are matched at three tiers (SPEC.md section 5): exact, then ignoring
trailing whitespace, then ignoring leading and trailing whitespace — and at
the third tier the replacement is re-indented to the file's own indentation.
`--strict` matches exactly (tier 0 only). `--check` is a dry run: the same
output and exit code, and no file is created, changed or deleted.
`--format=auto|unified|search-replace|v4a|json` picks the format; `auto` is
the default.

Every file is changed or none is: a patch whose edits cannot all apply
reports `error: <code> <path>` for each failed edit and
`failed: <k> of <n> edits`, and writes nothing. Safe paths only — nothing
outside the tree, nothing absolute, nothing through `..`.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines
  hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env,
  runs `node main.ts` on each one in a fresh directory, and posts what
  main.ts did (its exit code, its stdout and the files left in the
  directory).
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the
  practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.
- `tests/extra-checks.json`: 59 extra checks of my own, in the same format
  as the practice set — usage errors, creations and deletions without a
  final line break, renames, moves, empty anchors, cursor rules and output
  ordering. Run them the same way:

      node check.ts tests/extra-checks.json

## A check

A check is one run: its arguments, its standard input (or none) and the
files it starts with. It passes when the exit code, everything written to
stdout and every file afterwards are exactly what SPEC.md says. stderr is
never compared, so write what you like there. Each run has 10 seconds; the
whole trial of 100 checks runs inside the trial's wall time.

## Results

- Practice set: **100 of 100 passed, practice score 1000**.
- Kit trials 0, 1 and 2: **100 of 100 passed each**.
- My extra checks: **59 of 59 passed**.

The checks are written the way models get edits wrong: wrong line numbers,
drifted whitespace and indentation, blank context lines without their
leading space, prose and code fences around the patch, CRLF files, files
without a final line break, blocks that occur twice. Read SPEC.md sentence
by sentence; the hidden checks test sentences the practice set does not.

<sub>Entered on [make.fun](https://make.fun/?ref=ds1567x3&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
