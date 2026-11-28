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
3. Run `npm run supabase:sync` before deploying `numora-create-room`, `numora-rematch-room`, and `numora-daily`. Deploy the files in `supabase/functions/`, including each function's `deno.json` and `_shared` dependencies. The installed Supabase CLI or Supabase connector can deploy them. The JavaScript SDK is pinned to the same exact version in npm and the Edge import maps.
4. Set the two browser variables above and restart/rebuild the app. Create a room, then join from a second browser profile or device to test separate guest identities.

`supabase/config.toml` enables anonymous sign-ins for a **local** Supabase instance; it does not change the hosted project's Auth setting. Keep `supabase/` at the repository root if using Supabase's GitHub integration with working directory `.`. Avoid applying the same initial migration manually and through GitHub under different migration versions.

The server generates competition puzzles with a private random seed. Neither the solution nor its reproducible seed is sent to players. Public tables contain only room settings and leaderboard information. Room polling returns only the participant's own saved entries; a separate spectator RPC releases an opponent's progress only after the viewer has finished that same race. RPCs enforce membership, readiness, clues, board rules, and server-calculated finish times. Database constraints and RPC permissions are covered by local Postgres tests (`npm run test:backend`); these tests do not require Docker or a live project.

Supabase's advisor may flag [guest-access policies](https://supabase.com/docs/guides/database/database-advisors?queryGroups=lint&lint=0012_auth_allow_anonymous_sign_ins): these intentionally admit signed-in guests **only to their own rooms**. Private tables intentionally have [RLS enabled with no policies](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), denying direct client access; the scoped server functions access them. These findings do not require opening the private tables.

## Play

Fill every cell. Each horizontal and vertical segment between thick walls must contain every number from **1 through its length**, exactly once. A cell must satisfy both its across segment and its down segment. Underlined numbers are fixed clues.

**Learn** holds the six starter puzzles, the rules with segment examples, and the controls and keyboard guide. Choose a starter to practice it in Solo play; its saved progress is kept. The starter collection spans 5×5 through 8×8 boards. Every starter puzzle has exactly one solution, checked by an independent solver in the tests. Starter difficulty labels are initial estimates. The Learn tab is available from Solo, Daily, and Compete, and can be opened directly with `?view=learn`.

Solo features include pencil notes, undo/redo, hints, mistake checking, a pauseable timer, per-puzzle saved progress, dark mode, responsive layouts, and keyboard and touch controls. Solo progress is stored in this browser on this device; it does not sync between devices. Hints and checks are counted separately from solve time.

Arrow keys move between editable cells in Solo, Daily, and Compete. Left/right wrap within the current row; up/down wrap within the current column. Fixed clues are skipped, while numbers you entered remain selectable. If a row or column has no other editable cell, selection stays put.

Use arrow keys to move, number keys to enter, Backspace/Delete to clear, **N** to toggle notes, and **⌘/Ctrl Z** to undo (**Shift** to redo). Hold **Shift** to temporarily enable notes: Shift + a number adds or removes that note, and releasing Shift restores your notes setting. **Show mistakes** and **Check** mark only visible rule conflicts with a full-cell cross: numbers outside `1..segment length`, or duplicate numbers within an across/down segment. A legal guess is never marked merely because it differs from the stored answer. Repeats separated by thick walls are allowed, fixed clues never receive crosses, and pencil notes are not checked. All digits from `1..board size` can be entered so you can explore your own deductions. The timer starts on the first entry or note. Switching browser tabs or leaving Solo pauses the game.

## Generate a puzzle

In **Solo play**, use the puzzle creation panel to choose a size from **5×5 through 8×8** and **Easy, Medium, or Hard**, then click **Generate puzzle**. Leave the seed field blank for a fresh seed, or enter your own seed of up to 64 characters. Generation runs in a background worker so the interface remains responsive. Choosing **Cancel generation** or leaving Solo terminates that worker; your current board is replaced only after generation succeeds. Recent generated boards are available below the creation panel. Solo keeps the game controls and mistake toggle beside the grid; the starter collection and learning material live in Learn.

The same **generator version, size, difficulty, and normalized seed** reproduce the same walls, clues, solution, and rating. Seed normalization trims surrounding whitespace and normalizes Unicode. Use **Copy puzzle code** below a generated grid to copy all four reproduction settings together, for example:

```text
numora:2:6:medium:my-seed
```

Paste a code into the **Seed or puzzle code** field in Solo’s creation panel to recreate its board. Seeds containing spaces, Unicode, or delimiters are encoded automatically. Version 1 codes and saved boards remain supported, including legacy `oneup:` codes, and use their original generator and board IDs. New puzzles use version 2. Existing browser saves retain their original storage namespace, so the Numora rename preserves progress. Codes from unsupported generator versions are rejected rather than silently producing a different board.

The **last 12 generated puzzles and their progress** are saved in this browser on this device and appear under Your recent puzzles. Returning to a recent board—or recreating its code—resumes its saved progress. Creating a thirteenth different puzzle expires the oldest cached board and its progress to keep storage bounded. Its code can still recreate the original board with a fresh session. Copying a code shares the puzzle settings, not your entries or solve time.

Generation has deterministic attempt and solver-node budgets. If a seed cannot produce the requested difficulty within those bounds, the dialog reports a retry error and keeps your current puzzle. Try a different seed; a partial or unverified board is never substituted.

## Generation and difficulty

The generator creates fresh mirrored wall layouts with internal boundaries across most rows and columns and at least three segment lengths. Every new board has at least `size − 1` internal walls in each direction, including Hard boards. It uses randomized constraint search to find a valid solution and removes clues using uniqueness-preserving deductions or complete solution counts. A final complete count certifies that exactly one solution remains. Incomplete searches do not count as uniqueness proofs. Tests also certify generated puzzles with an independent solver and check that wall geometry extends beyond transformations of the starter boards.

Generated difficulty is estimated from deductions made using the clues, without consulting the stored answer:

- **Easy:** naked singles—direct placements with only one candidate.
- **Medium:** hidden singles or naked-pair deductions are needed, without branching.
- **Hard:** this solver needs branching after exhausting its supported logical deductions.

These are technique-based estimates, not human-calibrated ratings. They reflect this solver's supported techniques and deterministic solving order; grid size and clue count alone do not determine the label.

`GENERATOR_VERSION` must be incremented whenever the generation algorithm, PRNG, or rating rules change. Reproducible codes depend on that contract; keep old implementations if older codes need continued support.

The game tests cover visible-rule mistake marking, contradiction and search-budget handling, uniqueness, reproduction and legacy-code compatibility, difficulty, library restoration and expiry, and play sessions. Segmentation checks cover every size and difficulty; version 1 golden fixtures protect existing puzzle codes and saved games.

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

Choose **Compete**, enter a nickname, and create a room with a board size and difficulty. Share its six-character code or invitation link. A room supports **2–8 players**, with up to eight people total including spectators. In the lobby, every active player can vote for a grid size and difficulty. Vote totals and names are visible, and ties remain suggestions: the host has the final say and can choose any supported grid. Applying a new grid clears readiness so everyone can confirm the actual choice. Everyone marks themselves ready, then the host starts a five-second countdown. The board is released at the shared server start time.

Players see the same puzzle and each other's filled-cell counts. Entries and notes remain private until a racer has finished or given up their own round. New people arriving after the countdown starts join as spectators: they can watch racers live and take part in the next game, without entering or scoring in the current race. Notes and undo/redo work during races. Visible rule violations are automatically marked with full-cell crosses: duplicate numbers within a wall-delimited segment or numbers outside `1..segment length`. The same marks appear while spectating. Hints are unavailable. A complete valid board is submitted automatically, with a manual retry available. The server validates the board and records elapsed time; fastest valid finish ranks first. Repeated submissions preserve the original finish time. Switching tabs or returning to solo does not stop the race clock. Choose **Pause** to stop the room for everyone and hide all grids. Every active player still solving must choose **Ready to resume** before a shared **three-second countdown** begins. **Stay paused** cancels that countdown. Paused time and the resume countdown are excluded from official times. A disconnected player remains part of the resume check; explicitly leaving excludes them. Rejoining while still solving and paused requires a fresh confirmation. Finished players and players who gave up do not vote and cannot pause the remaining solvers.

Choose **Give up** to stop solving the current round without leaving the room. Confirming records **Did not finish**, preserves your last saved grid, and unlocks spectating without awarding a rank or finish time. Giving up is also available while paused and removes your resume vote. After everyone finishes or gives up, everyone returns to the voting and ready page. The host’s connected browser automatically prepares the next round with the same size and difficulty; a failed preparation offers a retry, and a lost acknowledgement is checked before retrying. The host can then apply a different grid from the room’s suggestions or their own choice. Everyone confirms readiness for that grid before the host starts the countdown. There is no separate Create next game step. The room code, invitation, chat, players, and nicknames stay the same. Grids, notes, timers, votes, and readiness start fresh. **View previous results** shows the last round’s standings, including removed racers and players who did not finish, and survives refreshes or another lobby grid change. Only room members receive this score-only archive; puzzle solutions, entries, notes, and chat are excluded. Each round and applied lobby grid has its own identity so delayed votes, saves, submissions, readiness changes, or spectator requests cannot affect the next game. Leaving excludes a player from the tally; rejoining restores their current preference.

After the server accepts your finish or give-up, choose **Spectate** beside an opponent to watch their grid and pencil notes update as they play. Switch between opponents or choose **Back to my grid** to return to your result. Spectating is read-only and does not change your recorded time. Players whose solution was accepted can toggle **Compare board** to compare placed entries with their own server-accepted finish: differing entries get amber crosses, matching entries are shaded green, and counts summarize matching, differing, and unfilled editable cells. Blanks, clues, and pencil notes are not marked as differences. Comparison updates with the live view and is unavailable to unfinished players, players who gave up, or midgame spectators. It uses the solver’s existing private board; no new answer data is sent to other players. The server checks membership and allows either a spectator role or a finished/given-up race before releasing a racer’s entries; players still solving cannot use the spectator endpoint. The view follows the opponent's latest saved progress, so unsynced edits appear once their connection recovers.

Refresh or reopen the invitation in the **same browser profile** to reconnect. Private progress syncs to the server, and unsent edits are also stored locally for reconnection. Keep the browser's guest session: clearing storage or switching devices creates a different identity and cannot recover an existing race entry. New arrivals during the countdown, race, pause, or results join as spectators and receive no editable grid or score. Spectators never block shared resumes or round completion. They become players in the next lobby and can vote and ready up alongside everyone else. Leaving as a spectator frees their slot. Existing racers can reconnect to their own progress. Explicitly leaving a lobby removes the player and transfers the host if needed; leaving a started race retains its history and clock.

The host can choose **Remove away player** for someone who explicitly left or has not checked in with the room for **60 seconds**. The server verifies this grace period; a short reconnect does not make an online player removable. A confirmation removes that identity from this room and frees the slot. Removed players cannot rejoin the same room, and their running requests lose access. Recorded results remain in the current standings and archived round, so removing a finisher does not change other ranks. Removing a paused or unfinished racer releases their resume/completion blocker.

**Room chat** is available to current players and spectators from the floating chat button. It stays with the room across rounds and works during a pause. Messages are plain text, up to 500 characters; Enter sends and Shift+Enter adds a line. The latest 100 messages are shown, and new incoming messages show an unread count while chat is closed. A failed send keeps its draft for retry without posting duplicates. Leaving or being removed ends chat access. Chat drafts stay in memory rather than browser storage.

Rooms expire after **24 hours without activity**. Connected members keep their room alive through its existing room heartbeat; messages and game activity also extend its life. A server cleanup job runs every five minutes and deletes expired rooms and their chat messages together. Chat is not copied into round archives. Existing rooms receive a 24-hour grace period when this expiry feature is first installed, and replaying the migration does not reset their activity clock.

This version supports casual private races. Guest-only identities cannot be recovered on another device. Public matchmaking, tournaments, and bot prevention are not included. Server timing and hidden answers prevent trusting a client-supplied score; they cannot prevent a player from using an external solver.

## Daily challenge and leaderboard

Choose **Daily** for the shared **6×6 Medium** puzzle. A new challenge starts at **9:30 AM IST (04:00 UTC)** every day. The page shows the time until reset using the server clock. The first visit creates that day's puzzle on the server; the database's unique date key ensures concurrent visitors receive the same board. No cron job is required, and old puzzle data is retained. Seeds and stored solutions stay private. Puzzle dates identify the day the challenge opens; that challenge remains current until 9:30 AM IST the following day. Existing puzzle IDs, attempts, finishes, and streak history are retained when changing the schedule.

**Reset-time rollout:** deploy the frontend first; it accepts both the former midnight-UTC schedule and the new schedule, and displays the server's actual reset time in IST. Keep `20261128185317_numora_daily_reset_ist.sql` out of any automatic Supabase deployment until that frontend is live, then apply it to switch the server. No Edge Function or environment-variable change is needed. Applying the migration while an older frontend is still deployed would make that frontend reject daily metadata. Reload already-open tabs after the frontend deployment.

Sign in with Google **before starting** to enter the ranked daily challenge. Starting releases the clues and starts one server timer for that account and date. The timer continues through refreshes and closed tabs unless you explicitly choose **Pause**. Pausing hides the daily grid and stops the server clock; choose **Resume daily puzzle** to continue. The pause persists across devices and refreshes. Notes and undo are available. Full-cell crosses automatically show duplicates within a segment or numbers outside its allowed range; legal guesses are never compared with the hidden solution. Hints are unavailable. Paused milliseconds are excluded from your finish time, while the 9:30 AM IST deadline stays unchanged. The first valid server submission locks the result. The global leaderboard ranks completed eligible attempts by elapsed milliseconds, with shared ranks for ties. The friends view includes you and accepted friends. Names and friend codes are public on the leaderboard; email addresses are not.

Guests can play the same board as **practice**. A practice attempt stays unranked if the guest later links Google, preventing a previewed board from becoming a fresh ranked attempt. Return the next day for a ranked challenge. A daily attempt expires at the next 9:30 AM IST reset; old entries cannot be submitted against the new day's board. Signed-in daily progress follows the same account across devices. Unsent edits also use a local draft while the connection is interrupted.

**Your daily streaks** shows your current and longest run of consecutive ranked daily finishes. Existing results count automatically. Finishing today extends the current streak; if you finished yesterday, it stays active while today's puzzle is still available. Missing a full puzzle day (9:30 AM IST to 9:30 AM IST) resets the current streak, while your longest streak remains. Practice attempts and incomplete puzzles do not count. Streaks are calculated on the server for the signed-in account and update after a verified finish.

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

Google accounts receive a playful random adjective-and-noun display name, such as `HungryGoose` or `PedanticStonebreaker`, and a unique ten-character friend code. The generated name stays the same between visits and can be edited. Open the daily page's friends panel to change your display name, copy your code, or enter a friend's code. Requests require the recipient to accept them before either player appears in the other's friends leaderboard. Requests can be declined or cancelled, and accepted friends can be removed. Only the involved accounts can act on a request or friendship. Friend codes avoid publishing or searching email addresses.
