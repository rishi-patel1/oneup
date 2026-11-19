# One Up, locally

A solo browser puzzle game inspired by [One Up](https://oneuppuzzle.com/), created by Rodolfo Kurchan. Play six original starter boards or generate new puzzles on demand. No boards or solutions were copied from the reference game.

## Run locally

Requires Node.js 22 or newer and npm.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. Other commands:

```sh
npm test          # Rules, generation, uniqueness, saved-library, and session tests
npm run build    # TypeScript check and production build in dist/
npm run preview  # Serve the production build locally
```

## Play

Fill every cell. Each horizontal and vertical segment between thick walls must contain every number from **1 through its length**, exactly once. A cell must satisfy both its across segment and its down segment. Underlined numbers are fixed clues.

The starter collection spans 5×5 through 8×8 boards. Every starter puzzle has exactly one solution, checked by an independent solver in the tests. Starter difficulty labels are initial estimates.

Features include pencil notes, undo/redo, hints, mistake checking, a pauseable timer, per-puzzle saved progress, dark mode, responsive layouts, and keyboard and touch controls. Progress is stored in this browser on this device; it does not sync between devices. Hints and checks are counted separately from solve time.

Use arrow keys to move, number keys to enter, Backspace/Delete to clear, **N** to toggle notes, and **⌘/Ctrl Z** to undo (**Shift** to redo). Hold **Shift** to temporarily enable notes: Shift + a number adds or removes that note, and releasing Shift restores your notes setting. Checked mistakes have a full-cell cross. The timer starts on the first entry or note. Switching tabs or opening help pauses the game.

## Generate a puzzle

Click **New puzzle**, choose a size from **5×5 through 8×8** and **Easy, Medium, or Hard**, then click **Generate puzzle**. Leave the seed field blank for a fresh seed, or enter your own seed of up to 64 characters. Generation runs in a background worker so the interface remains responsive. Closing the dialog or choosing **Cancel generation** terminates that worker; your current board is replaced only after generation succeeds.

The same **generator version, size, difficulty, and normalized seed** reproduce the same walls, clues, solution, and rating. Seed normalization trims surrounding whitespace and normalizes Unicode. Use **Copy puzzle code** below a generated grid to copy all four reproduction settings together, for example:

```text
oneup:1:6:medium:my-seed
```

Paste a code into the **Seed or puzzle code** field in New puzzle to recreate its board. Seeds containing spaces, Unicode, or delimiters are encoded automatically. Codes from unsupported generator versions are rejected rather than silently producing a different board.

The **last 12 generated puzzles and their progress** are saved in this browser on this device and appear under Your recent puzzles. Returning to a recent board—or recreating its code—resumes its saved progress. Creating a thirteenth different puzzle expires the oldest cached board and its progress to keep storage bounded. Its code can still recreate the original board with a fresh session. Copying a code shares the puzzle settings, not your entries or solve time.

Generation has deterministic attempt and solver-node budgets. If a seed cannot produce the requested difficulty within those bounds, the dialog reports a retry error and keeps your current puzzle. Try a different seed; a partial or unverified board is never substituted.

## Generation and difficulty

The generator creates fresh mirrored wall layouts, uses randomized constraint search to find a valid solution, and removes clues only when a complete solution count proves that exactly one solution remains. Incomplete searches do not count as uniqueness proofs. Tests also certify generated puzzles with an independent solver and check that wall geometry extends beyond transformations of the starter boards.

Generated difficulty is estimated from deductions made using the clues, without consulting the stored answer:

- **Easy:** naked singles—direct placements with only one candidate.
- **Medium:** hidden singles or naked-pair deductions are needed, without branching.
- **Hard:** this solver needs branching after exhausting its supported logical deductions.

These are technique-based estimates, not human-calibrated ratings. They reflect this solver's supported techniques and deterministic solving order; grid size and clue count alone do not determine the label.

`GENERATOR_VERSION` must be incremented whenever the generation algorithm, PRNG, or rating rules change. Reproducible codes depend on that contract; keep old implementations if older codes need continued support.

The current 61-test suite covers rules, contradiction and search-budget handling, uniqueness, reproduction, difficulty, library restoration and expiry, and play sessions. A development-machine benchmark generated **240/240** requested boards across 20 seeds × four sizes × three difficulties, taking **1–269 ms** per board. This measurement is not a browser performance guarantee.

## Code layout

- `src/game/engine.ts` — wall segmentation, candidates, conflicts, completion, and puzzle integrity checks.
- `src/game/puzzles.ts` — original starter puzzle definitions, stable IDs, walls, clues, and solutions.
- `src/game/solver.ts` — bounded solution counting and deterministic deduction-based difficulty analysis.
- `src/game/generator.ts` — versioned seeded layout creation, solution search, and uniqueness-preserving clue removal.
- `src/game/generator.worker.ts` and `src/game/generationProtocol.ts` — background generation and typed worker messages.
- `src/game/generatedLibrary.ts` — defensive recent-board restoration, bounded history, and reproducible puzzle codes.
- `src/game/session.ts` — immutable play state, undo/redo, timing, assistance counts, and defensive save restoration.
- `src/game/*.test.ts` — rule, solver, generator, independent uniqueness, library, and session checks.
- `src/components/NewPuzzleForm.tsx` — size, difficulty, and seed/code controls, generation status, errors, and cancellation.
- `src/App.tsx` — game interface, controls, timer lifecycle, and browser storage.
- `src/styles.css` — responsive layout and light/dark themes.

## Next steps

The current version is **solo only**. Live multiplayer is the next phase.

For live competitions, have the server assign every player the same puzzle seed/version and control the start, submissions, and elapsed-time calculation. Define whether hints and checks are allowed and how they affect scoring. Verify submitted boards against the rules on the server; never trust the client timer or client-supplied solution. Current browser saves and timers are intended for solo play, not competitive verification.
