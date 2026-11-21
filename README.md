# Numora

**A moment of clarity.** Numora is a browser number puzzle game inspired by [One Up](https://oneuppuzzle.com/), created by Rodolfo Kurchan. Play six original starter boards, generate puzzles on demand, take on the shared daily challenge, or race friends in a private room. No boards or solutions were copied from the reference game.

## Run locally

Requires Node.js 22 or newer and npm.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. Other commands:

```sh
npm test          # Game, multiplayer client, Edge Function, and local Postgres tests
npm run build    # TypeScript check and production build in dist/
npm run preview  # Serve the production build locally
```

## Deploy

Use `npm run build` as the build command and publish the entire `dist/` directory, including its assets and generator worker. Use Node.js 22 or newer. Solo play works without environment variables or a backend.

Daily challenges, accounts, friends, and competition use Supabase. Set these **public browser variables** in `.env.local` for local development, and in your hosting provider's build environment for deployment:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
```

Copy `.env.example` as a starting point. Restart Vite after changing variables; rebuild and redeploy when changing production variables. Never put a service-role or secret key in a `VITE_` variable. The hosted Edge Function uses Supabase's built-in server credentials.

## Supabase setup

1. Create a Supabase project and enable **Allow anonymous sign-ins** in **Authentication → Sign In / Providers**. Players receive a guest identity without entering an email or password.
2. Apply the SQL in `supabase/migrations/` in timestamp order using your Supabase migration workflow. The initial migration creates room/player tables, private puzzle/progress tables, server RPCs, row-level security, and member-only Realtime policies.
3. Run `npm run supabase:sync` before deploying `numora-create-room` and `numora-daily`. Deploy the files in `supabase/functions/`, including each function's `deno.json` and `_shared` dependencies. The installed Supabase CLI or Supabase connector can deploy them. The JavaScript SDK is pinned to the same exact version in npm and the Edge import maps.
4. Set the two browser variables above and restart/rebuild the app. Create a room, then join from a second browser profile or device to test separate guest identities.

`supabase/config.toml` enables anonymous sign-ins for a **local** Supabase instance; it does not change the hosted project's Auth setting. Keep `supabase/` at the repository root if using Supabase's GitHub integration with working directory `.`. Avoid applying the same initial migration manually and through GitHub under different migration versions.

The server generates competition puzzles with a private random seed. Neither the solution nor its reproducible seed is sent to players. Public tables contain only room settings and leaderboard information. Room polling returns only the participant's own saved entries; a separate spectator RPC releases an opponent's progress only after the viewer has finished that same race. RPCs enforce membership, readiness, clues, board rules, and server-calculated finish times. Database constraints and RPC permissions are covered by local Postgres tests (`npm run test:backend`); these tests do not require Docker or a live project.

Supabase's advisor may flag [guest-access policies](https://supabase.com/docs/guides/database/database-advisors?queryGroups=lint&lint=0012_auth_allow_anonymous_sign_ins): these intentionally admit signed-in guests **only to their own rooms**. Private tables intentionally have [RLS enabled with no policies](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), denying direct client access; the scoped server functions access them. These findings do not require opening the private tables.

## Play

Fill every cell. Each horizontal and vertical segment between thick walls must contain every number from **1 through its length**, exactly once. A cell must satisfy both its across segment and its down segment. Underlined numbers are fixed clues.

The starter collection spans 5×5 through 8×8 boards. Every starter puzzle has exactly one solution, checked by an independent solver in the tests. Starter difficulty labels are initial estimates.

Solo features include pencil notes, undo/redo, hints, mistake checking, a pauseable timer, per-puzzle saved progress, dark mode, responsive layouts, and keyboard and touch controls. Solo progress is stored in this browser on this device; it does not sync between devices. Hints and checks are counted separately from solve time.

Use arrow keys to move, number keys to enter, Backspace/Delete to clear, **N** to toggle notes, and **⌘/Ctrl Z** to undo (**Shift** to redo). Hold **Shift** to temporarily enable notes: Shift + a number adds or removes that note, and releasing Shift restores your notes setting. **Show mistakes** and **Check** mark only visible rule conflicts with a full-cell cross: numbers outside `1..segment length`, or duplicate numbers within an across/down segment. A legal guess is never marked merely because it differs from the stored answer. Repeats separated by thick walls are allowed, fixed clues never receive crosses, and pencil notes are not checked. All digits from `1..board size` can be entered so you can explore your own deductions. The timer starts on the first entry or note. Switching tabs or opening help pauses the game.

## Generate a puzzle

Click **New puzzle**, choose a size from **5×5 through 8×8** and **Easy, Medium, or Hard**, then click **Generate puzzle**. Leave the seed field blank for a fresh seed, or enter your own seed of up to 64 characters. Generation runs in a background worker so the interface remains responsive. Closing the dialog or choosing **Cancel generation** terminates that worker; your current board is replaced only after generation succeeds.

The same **generator version, size, difficulty, and normalized seed** reproduce the same walls, clues, solution, and rating. Seed normalization trims surrounding whitespace and normalizes Unicode. Use **Copy puzzle code** below a generated grid to copy all four reproduction settings together, for example:

```text
numora:1:6:medium:my-seed
```

Paste a code into the **Seed or puzzle code** field in New puzzle to recreate its board. Seeds containing spaces, Unicode, or delimiters are encoded automatically. Legacy `oneup:` codes are still accepted and use the same generated board IDs. Existing browser saves retain their original storage namespace, so the Numora rename preserves progress. Codes from unsupported generator versions are rejected rather than silently producing a different board.

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

The game tests cover visible-rule mistake marking, contradiction and search-budget handling, uniqueness, reproduction and legacy-code compatibility, difficulty, library restoration and expiry, and play sessions. A development-machine benchmark generated **240/240** requested boards across 20 seeds × four sizes × three difficulties, taking **1–269 ms** per board. This measurement is not a browser performance guarantee.

## Code layout

- `src/branding.ts` — product name, puzzle code prefixes, and the compatible saved-game namespace.
- `src/components/BrandMark.tsx` — Numora's N monogram.
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
- `src/components/CompetitionPage.tsx` and `competition.css` — room lobby, synchronized countdown, race board, and results.
- `src/multiplayer/` — guest identity, room RPCs, defensive response parsing, and live subscriptions.
- `supabase/migrations/` — private data model, permissions, and authoritative race operations.
- `supabase/functions/numora-create-room/` — authenticated server puzzle generation and room creation.
- `scripts/sync-supabase-generator.mjs` — copies the canonical generator into the Edge runtime with explicit Deno imports.
- `tests/sql/` and `tests/edge/` — database access-control/race checks and the room-creation HTTP contract.

## Compete with friends

Choose **Compete**, enter a nickname, and create a room with a board size and difficulty. Share its six-character code or invitation link. A room supports **2–8 players**. Everyone marks themselves ready, then the host starts a five-second countdown. The board is released at the shared server start time.

Players see the same puzzle and each other's filled-cell counts. Entries and notes remain private until a viewer has completed their own puzzle. Notes and undo/redo work during races; hints, mistake checking, and pausing are unavailable. A complete valid board is submitted automatically, with a manual retry available. The server validates the board and records elapsed time; fastest valid finish ranks first. Repeated submissions preserve the original finish time. Switching tabs or returning to solo does not stop the race clock.

After the server accepts your finish, choose **Spectate** beside an opponent to watch their grid and pencil notes update as they play. Switch between opponents or choose **Back to my grid** to return to your result. Spectating is read-only and does not change your recorded time. The server enforces completion and room membership before releasing another player's entries; unfinished players cannot use the spectator endpoint. The view follows the opponent's latest saved progress, so unsynced edits appear once their connection recovers.

Refresh or reopen the invitation in the **same browser profile** to reconnect. Private progress syncs to the server, and unsent edits are also stored locally for reconnection. Keep the browser's guest session: clearing storage or switching devices creates a different identity and cannot recover an existing race entry. New players cannot enter after the countdown starts; existing members can reconnect. Explicitly leaving a lobby removes the player and transfers the host if needed; leaving a started race retains its history and clock.

This version supports casual private races. Guest-only identities cannot be recovered on another device. Public matchmaking, tournaments, and bot prevention are not included. Server timing and hidden answers prevent trusting a client-supplied score; they cannot prevent a player from using an external solver.

## Daily challenge and leaderboard

Choose **Daily** for the shared **6×6 Medium** puzzle. A new challenge starts at **00:00 UTC** every day (05:30 in India). The page shows the time until reset using the server clock. The first visit creates that day's puzzle on the server; the database's unique date key ensures concurrent visitors receive the same board. No cron job is required, and old puzzle data is retained. Seeds and stored solutions stay private.

Sign in with Google **before starting** to enter the ranked daily challenge. Starting releases the clues and starts one server timer for that account and date. The timer continues through refreshes and closed tabs. Notes and undo are available; pausing, hints, and mistake checking are unavailable. The first valid server submission locks the result. The global leaderboard ranks completed eligible attempts by elapsed milliseconds, with shared ranks for ties. The friends view includes you and accepted friends. Names and friend codes are public on the leaderboard; email addresses are not.

Guests can play the same board as **practice**. A practice attempt stays unranked if the guest later links Google, preventing a previewed board from becoming a fresh ranked attempt. Return the next day for a ranked challenge. A daily attempt expires at the next UTC reset; old entries cannot be submitted against the new day's board. Signed-in daily progress follows the same account across devices. Unsent edits also use a local draft while the connection is interrupted.

## Google sign-in setup

Google credentials belong in Supabase, never in `VITE_` environment variables. The app uses Supabase OAuth with PKCE and the existing two public browser variables.

1. In [Google Auth Platform](https://console.cloud.google.com/auth/clients), create an OAuth client of type **Web application**. Configure the consent screen and the basic `openid`, email, and profile scopes. If the app remains in testing, add your test users there.
2. Add your deployed site origin under **Authorized JavaScript origins**. For development, also add `http://127.0.0.1:5173` and/or `http://localhost:5173` as appropriate.
3. Add the hosted Supabase callback under **Authorized redirect URIs**: `https://zjnejxbsqvwbippdcxtv.supabase.co/auth/v1/callback`. For a different Supabase project, use its callback URL.
4. Open Supabase **Authentication → Sign In / Providers → Google**, enable Google, paste the client ID and client secret, and save. Enable **manual identity linking** in the Auth provider configuration to upgrade an existing anonymous guest while preserving its identity.
5. In Supabase **Authentication → URL Configuration**, set the production **Site URL** and allow your app's exact callback return URL: `https://YOUR_DOMAIN/?view=daily`. For local testing, allow `http://127.0.0.1:5173/?view=daily` and/or `http://localhost:5173/?view=daily`. Preview deployments need their own allowed return URLs. Save and test sign-in on the deployed origin.

The default Google action links a current guest to Google. If that Google account already belongs to another Numora identity, the app offers an explicit **Use an existing Google account** action. Choosing it switches identities; it does not transfer the old guest's rooms or daily attempts. Signing out affects the current browser session only.

Provider setup reference: [Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-sign-in/auth-google) and [identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking).

## Friends

Google accounts receive a public display name and a unique ten-character friend code. Open the daily page's friends panel to change your display name, copy your code, or enter a friend's code. Requests require the recipient to accept them before either player appears in the other's friends leaderboard. Requests can be declined or cancelled, and accepted friends can be removed. Only the involved accounts can act on a request or friendship. Friend codes avoid publishing or searching email addresses.
