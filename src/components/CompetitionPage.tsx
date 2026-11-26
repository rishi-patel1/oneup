import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Clock3, Copy, Eraser, Eye, Flag, LoaderCircle, LogOut, Pause, Pencil, Play, Redo2, RotateCcw, Sparkles, Trophy, Undo2, UserMinus, Users } from 'lucide-react';
import { APP_NAME } from '../branding';
import BrandMark from './BrandMark';
import AccountButton from './AccountButton';
import GridChoicePanel from './GridChoicePanel';
import RoomChat from './RoomChat';
import type { Difficulty, Puzzle } from '../game/engine';
import { getMistakes, getSegments, isSolved } from '../game/engine';
import { createSession, restoreSession, serializeSession, sessionReducer, type Session, type SessionAction } from '../game/session';
import { createRoomSnapshotGate, getRoomTiming, isPlayerDone } from '../multiplayer/model';
import { createRoom, explainError, getRoom, getSpectatorState, getUserId, giveUpRoom, isRoomUnavailableError, isSupabaseConfigured, joinRoom, kickRoomPlayer, leaveRoom, pauseRoom, rematchRoom, saveProgress, setReady, setResumeReady, startRoom, submitSolution, voteRoomGrid, watchRoom, type PublicPuzzle, type RoomPlayer, type RoomState, type SpectatorState } from '../multiplayer/api';
import './competition.css';

const ROOM_KEY = 'numora:competition:room';
const NAME_KEY = 'numora:competition:nickname';
const LEVELS: Difficulty[] = ['Easy', 'Medium', 'Hard'];

function stored(key: string) { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } }
function remember(key: string, value: string) { try { localStorage.setItem(key, value); return true; } catch { return false; } }
function forget(key: string) { try { localStorage.removeItem(key); } catch { /* No persistent storage. */ } }
function normalizeCode(value: string) { return value.trim().toUpperCase().replace(/\s/g, ''); }
function requestedCode() { return normalizeCode(new URL(location.href).searchParams.get('room') ?? stored(ROOM_KEY)); }
function updateRoomUrl(code?: string) {
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code); else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}
function time(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function CompetitionPage({ onSolo, onDaily, onLearn }: { onSolo: () => void; onDaily: () => void; onLearn: () => void }) {
  const [nickname, setNickname] = useState(() => stored(NAME_KEY));
  const [code, setCode] = useState(requestedCode);
  const [entryMode, setEntryMode] = useState<'create' | 'join'>(() => requestedCode() ? 'join' : 'create');
  const [size, setSize] = useState<5 | 6 | 7 | 8>(5);
  const [difficulty, setDifficulty] = useState<Difficulty>('Easy');
  const [snapshot, setSnapshot] = useState<RoomState | null>(null);
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [syncWarning, setSyncWarning] = useState('');
  const [syncRetrying, setSyncRetrying] = useState(false);
  const [presence, setPresence] = useState<string[] | null>(null);
  const [chatRevision, setChatRevision] = useState(0);
  const [clockOffset, setClockOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const codeRef = useRef('');
  const snapshotGate = useRef(createRoomSnapshotGate());
  const epoch = useRef(0);
  const mounted = useRef(true);
  const latestSnapshot = useRef<RoomState | null>(snapshot);
  latestSnapshot.current = snapshot;

  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  const accept = useCallback((next: RoomState) => {
    if (!mounted.current || next.room.code !== codeRef.current) return;
    const serverTime = Date.parse(next.server_now);
    if (!snapshotGate.current(next)) return;
    setClockOffset(serverTime - Date.now());
    setNow(Date.now());
    setSnapshot(next);
    setSyncWarning('');
  }, []);
  const enter = useCallback((next: RoomState) => {
    codeRef.current = next.room.code;
    snapshotGate.current = createRoomSnapshotGate();
    setPresence(null);
    setChatRevision(0);
    setSyncRetrying(false);
    remember(ROOM_KEY, next.room.code);
    updateRoomUrl(next.room.code);
    accept(next);
  }, [accept]);
  const handleUnavailable = useCallback((cause: unknown, expectedCode: string) => {
    if (!isRoomUnavailableError(cause)) return false;
    if (!mounted.current || (codeRef.current && codeRef.current !== expectedCode)) return true;
    epoch.current++;
    // Revoke local room acceptance before clearing the view or any pending poll.
    codeRef.current = ''; snapshotGate.current = createRoomSnapshotGate();
    forget(ROOM_KEY); updateRoomUrl();
    setSnapshot(null); setPresence(null); setSyncWarning(''); setSyncRetrying(false);
    setCode(''); setEntryMode('join'); setBusy(false); setError(explainError(cause));
    return true;
  }, []);

  useEffect(() => {
    const pendingCode = requestedCode();
    if (!pendingCode || !isSupabaseConfigured) return;
    const token = ++epoch.current;
    setBusy(true);
    void (async () => {
      try {
        const id = await getUserId();
        const next = await getRoom(pendingCode);
        if (!mounted.current || token !== epoch.current) return;
        setUserId(id); enter(next);
      } catch (cause) {
        if (!mounted.current || token !== epoch.current) return;
        if (handleUnavailable(cause, pendingCode)) return;
        setEntryMode('join'); setCode(pendingCode);
        setError(`Join this room to continue. ${explainError(cause)}`);
      } finally { if (mounted.current && token === epoch.current) setBusy(false); }
    })();
    return () => { epoch.current++; };
  }, [enter, handleUnavailable]);

  const roomId = snapshot?.room.id;
  const roomCode = snapshot?.room.code;
  const onRoomUnavailable = useCallback((cause: unknown) => roomCode ? handleUnavailable(cause, roomCode) : false, [roomCode, handleUnavailable]);
  useEffect(() => {
    if (!roomId || !roomCode) return;
    let stopped = false, inFlight = false, lastPoll = 0;
    const refresh = async () => {
      if (stopped || inFlight || codeRef.current !== roomCode) return;
      inFlight = true;
      lastPoll = Date.now();
      try { const next = await getRoom(roomCode); if (!stopped) accept(next); }
      catch (cause) { if (!stopped && !handleUnavailable(cause, roomCode)) setSyncWarning('Room sync is reconnecting. Your entries stay on this device while we retry.'); }
      finally { inFlight = false; }
    };
    let stopWatching = () => {};
    try { stopWatching = watchRoom(roomId, () => { void refresh(); }, ids => { if (!stopped) setPresence(ids); }, () => { if (!stopped && codeRef.current === roomCode) setChatRevision(value => value + 1); }); }
    catch { setSyncWarning('Live updates are reconnecting. The room will keep checking for changes.'); }
    const interval = window.setInterval(() => {
      const current = latestSnapshot.current;
      const pace = current?.room.paused_at || (current?.room.status === 'racing' && !current.puzzle) ? 500 : 3000;
      if (Date.now() - lastPoll >= pace) void refresh();
    }, 500);
    void refresh();
    return () => { stopped = true; window.clearInterval(interval); stopWatching(); };
  }, [roomId, roomCode, accept, handleUnavailable]);

  useEffect(() => {
    if (!roomId) return;
    const interval = window.setInterval(() => setNow(Date.now()), 150);
    return () => window.clearInterval(interval);
  }, [roomId]);

  const submitEntry = async (event: React.FormEvent<HTMLFormElement>, mode: 'create' | 'join') => {
    event.preventDefault();
    if (busy) return;
    const name = nickname.trim();
    if (name.length < 2 || name.length > 24) { setError('Choose a nickname with 2–24 characters.'); return; }
    const room = normalizeCode(code);
    if (mode === 'join' && !/^[A-Z0-9]{6}$/.test(room)) { setError('Enter the six-character room code from your invitation.'); return; }
    const token = ++epoch.current;
    setBusy(true); setError('');
    try {
      const id = await getUserId();
      const next = mode === 'create' ? await createRoom({ nickname: name, size, difficulty }) : await joinRoom(room, name);
      if (!mounted.current || token !== epoch.current) return;
      remember(NAME_KEY, name); setUserId(id); enter(next);
    } catch (cause) { if (mounted.current && token === epoch.current && !handleUnavailable(cause, room)) setError(explainError(cause)); }
    finally { if (mounted.current && token === epoch.current) setBusy(false); }
  };

  const exitRoom = async () => {
    if (!snapshot || busy) return;
    const token = ++epoch.current;
    setBusy(true); setError('');
    try {
      await leaveRoom(snapshot.room.code, snapshot.room.round_id);
      if (!mounted.current || token !== epoch.current) return;
      // Ignore any late room poll before showing the fresh-room form.
      codeRef.current = ''; snapshotGate.current = createRoomSnapshotGate();
      forget(ROOM_KEY); updateRoomUrl();
      setCode(''); setEntryMode('create');
      setSize(snapshot.room.size); setDifficulty(snapshot.room.difficulty);
      const previousName = snapshot.players.find(player => player.user_id === userId)?.nickname;
      if (previousName) { setNickname(previousName); remember(NAME_KEY, previousName); }
      setSnapshot(null); setPresence(null); setSyncWarning(''); setSyncRetrying(false);
    } catch (cause) { if (mounted.current && token === epoch.current) setError(explainError(cause)); }
    finally { if (mounted.current && token === epoch.current) setBusy(false); }
  };

  const retryRoomSync = async () => {
    if (!snapshot || syncRetrying) return;
    const token = epoch.current, expectedCode = snapshot.room.code;
    setSyncRetrying(true);
    try { const next = await getRoom(expectedCode); if (mounted.current && token === epoch.current) accept(next); }
    catch (cause) { if (mounted.current && token === epoch.current && !handleUnavailable(cause, expectedCode)) setSyncWarning(explainError(cause)); }
    finally { if (mounted.current && token === epoch.current) setSyncRetrying(false); }
  };

  return <div className="app-shell arena-shell">
    <header className="site-header arena-header with-account">
      <a className="brand" href="#" aria-label={`${APP_NAME} solo play`} onClick={event => { event.preventDefault(); onSolo(); }}><span className="brand-mark"><BrandMark /></span><span>{APP_NAME}<span className="brand-period">.</span></span></a>
      <nav aria-label="Main navigation"><button className="nav-link" onClick={onSolo}>Solo play</button><button className="nav-link" onClick={onDaily}>Daily</button><button className="nav-link active" aria-current="page">Compete</button><button className="nav-link" onClick={onLearn}>Learn</button></nav>
      <AccountButton />
    </header>

    {!snapshot ? <main className="arena-entry">
      <section className="arena-intro"><div className="eyebrow"><Flag size={13} /> BETTER WITH A LITTLE COMPANY</div><h1>Same grid.<br /><em>A shared challenge.</em></h1><p>Bring your friends. Start together. See who finds their moment of clarity first.</p><div className="arena-rule-pills"><span><Users size={15} /> 2–8 players</span><span><Clock3 size={15} /> Fastest valid finish wins</span></div></section>
      <section className="arena-entry-panel" aria-label="Competition rooms">
        <div className="arena-entry-tabs"><button disabled={busy} aria-pressed={entryMode === 'create'} className={entryMode === 'create' ? 'selected' : ''} onClick={() => { setEntryMode('create'); setError(''); }}>Create a room</button><button disabled={busy} aria-pressed={entryMode === 'join'} className={entryMode === 'join' ? 'selected' : ''} onClick={() => { setEntryMode('join'); setError(''); }}>Join a room</button></div>
        {!isSupabaseConfigured && <p className="arena-notice">Competition isn’t connected yet. Solo play is ready while the room service is being set up.</p>}
        <form onSubmit={event => { void submitEntry(event, entryMode); }} aria-busy={busy}>
          <label htmlFor="arena-nickname">Your nickname</label><input id="arena-nickname" value={nickname} onChange={event => setNickname(event.target.value)} maxLength={24} minLength={2} placeholder="What should we call you?" autoComplete="nickname" disabled={busy} required />
          {entryMode === 'create' ? <><fieldset disabled={busy}><legend>Board size</legend><div className="size-options">{([5, 6, 7, 8] as const).map(value => <label className="generation-choice" key={value}><input type="radio" name="arena-size" value={value} checked={size === value} onChange={() => setSize(value)} /><span>{value} × {value}</span></label>)}</div></fieldset><fieldset disabled={busy}><legend>Difficulty</legend><div className="difficulty-options">{LEVELS.map(level => <label className="generation-choice" key={level}><input type="radio" name="arena-difficulty" value={level} checked={difficulty === level} onChange={() => setDifficulty(level)} /><span>{level}</span></label>)}</div></fieldset></>
            : <><label htmlFor="arena-room-code">Six-character room code</label><input id="arena-room-code" className="arena-code-input" value={code} onChange={event => setCode(normalizeCode(event.target.value))} minLength={6} maxLength={6} placeholder="ABC123" autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={busy} required /></>}
          {error && <p role="alert" className="arena-error">{error}</p>}
          <button className="primary-button arena-entry-submit" disabled={busy || !isSupabaseConfigured}>{busy ? <LoaderCircle className="spin" size={17} /> : entryMode === 'create' ? <Sparkles size={17} /> : <Users size={17} />}{busy ? 'Connecting…' : entryMode === 'create' ? 'Make a little competition' : 'Join the challenge'}</button>
        </form>
        <p className="arena-entry-caption">Nicknames only. Notes and undo are welcome.<br />Rule conflicts are crossed automatically. Hints sit this one out. Anyone can pause the shared clock.</p>
      </section>
    </main> : <RoomScreen key={`${snapshot.room.id}:${snapshot.room.round_id}`} snapshot={snapshot} userId={userId} serverNow={now + clockOffset} presence={presence} onSnapshot={accept} onRoomUnavailable={onRoomUnavailable} onLeave={() => { void exitRoom(); }} leaving={busy} />}
    {snapshot && (error || syncWarning) && <div className={`arena-room-message ${error ? 'arena-error' : 'arena-notice'}`} role={error ? 'alert' : 'status'}><span>{error || syncWarning}</span>{syncWarning && !error && <button className="secondary-button arena-sync-retry" disabled={syncRetrying} onClick={() => { void retryRoomSync(); }}>{syncRetrying ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}{syncRetrying ? 'Reconnecting…' : 'Retry room sync'}</button>}</div>}
    {snapshot && <RoomChat key={snapshot.room.id} roomId={snapshot.room.id} roomCode={snapshot.room.code} userId={userId} active={Boolean(snapshot.players.find(player => player.user_id === userId)?.active)} refreshKey={chatRevision} onRoomUnavailable={onRoomUnavailable} />}
    <footer className="site-footer arena-footer"><span>Small grids. Shared headspace.</span><span>Your official time excludes shared pauses.</span></footer>
  </div>;
}

interface RoomProps {
  snapshot: RoomState;
  userId: string;
  serverNow: number;
  presence: string[] | null;
  onSnapshot: (state: RoomState) => void;
  onRoomUnavailable: (cause: unknown) => boolean;
  onLeave: () => void;
  leaving: boolean;
}

function RoomScreen({ snapshot, userId, serverNow, presence, onSnapshot, onRoomUnavailable, onLeave, leaving }: RoomProps) {
  const { room, players } = snapshot;
  const own = players.find(player => player.user_id === userId);
  // Competitive clients receive no answer. These helpers only need rules and clues.
  const puzzle = useMemo<Puzzle | null>(() => snapshot.puzzle ? { ...snapshot.puzzle, solution: [] } : null, [snapshot.puzzle?.id]);
  const [game, setGame] = useState<Session | null>(null);
  const gameRef = useRef<Session | null>(null);
  const [selected, setSelected] = useState(0);
  const [notesMode, setNotesMode] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [confirmGiveUp, setConfirmGiveUp] = useState(false);
  const [kickTarget, setKickTarget] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'pending' | 'retrying'>('saved');
  const [draftAvailable, setDraftAvailable] = useState(true);
  const [spectatingId, setSpectatingId] = useState<string | null>(() => own?.is_spectator ? players.find(player => !player.is_spectator && player.user_id !== userId && !isPlayerDone(player))?.user_id ?? players.find(player => !player.is_spectator && player.user_id !== userId)?.user_id ?? null : null);
  const mounted = useRef(true);
  const revision = useRef(0);
  const dirty = useRef(false);
  const inFlight = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const submittedSignature = useRef('');
  const latest = useRef({ snapshot, puzzle, own, onSnapshot, onRoomUnavailable, serverNow });
  latest.current = { snapshot, puzzle, own, onSnapshot, onRoomUnavailable, serverNow };
  const draftKey = room.round_id === room.id ? `numora:competition:draft:${room.id}:${userId}`
    : `numora:competition:draft:${room.id}:${room.round_id}:${userId}`;
  const startTime = room.starts_at ? Date.parse(room.starts_at) : Infinity;
  const countdown = room.status === 'racing' && serverNow < startTime;
  const roomTiming = getRoomTiming(room, serverNow);
  const ownDone = Boolean(own && isPlayerDone(own));
  const ownSpectator = Boolean(own?.is_spectator);
  const canSpectate = Boolean(own?.active && (ownSpectator || ownDone));
  const canPlay = Boolean(puzzle && game && room.status === 'racing' && !countdown && !roomTiming.paused && own?.active && !ownSpectator && !ownDone && !submitBusy && !actionBusy && !confirmGiveUp);
  const effectiveNotes = notesMode || shiftHeld;
  const editableCount = puzzle?.givens.filter(value => !value).length ?? room.size ** 2;
  const segments = useMemo(() => puzzle ? getSegments(puzzle) : { rows: [], columns: [] }, [puzzle]);
  const mistakes = useMemo(() => puzzle && game ? getMistakes(puzzle, game.values) : new Set<number>(), [puzzle, game?.values]);
  const peers = useMemo(() => new Set([...(segments.rows.find(run => run.includes(selected)) ?? []), ...(segments.columns.find(run => run.includes(selected)) ?? [])]), [segments, selected]);
  const participants = players.filter(player => !player.is_spectator);
  const finishedPlayers = participants.filter(player => player.finished_at !== null).sort((a, b) => (a.elapsed_ms ?? Infinity) - (b.elapsed_ms ?? Infinity));
  const allFinishedPlayers = [...finishedPlayers, ...(snapshot.removed_results ?? []).filter(player => player.finished_at !== null)];
  const rankedPlayers = [...finishedPlayers, ...participants.filter(player => !isPlayerDone(player)).sort((a, b) => b.progress_count - a.progress_count), ...participants.filter(player => player.given_up_at), ...players.filter(player => player.is_spectator)];
  const spectatingPlayer = canSpectate && !leaving ? participants.find(player => player.user_id === spectatingId && player.user_id !== userId) : undefined;

  useEffect(() => {
    if (!canSpectate || (spectatingId && !players.some(player => !player.is_spectator && player.user_id === spectatingId && player.user_id !== userId))) setSpectatingId(null);
  }, [canSpectate, spectatingId, players, userId]);
  useEffect(() => {
    if (kickTarget && !players.some(player => player.user_id === kickTarget && player.is_away)) setKickTarget(null);
  }, [kickTarget, players]);

  const persistDraft = useCallback((session: Session, isDirty: boolean) => {
    if (isDirty) setDraftAvailable(remember(draftKey, JSON.stringify({ session: serializeSession(session), dirty: true })));
    else forget(draftKey);
  }, [draftKey]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; if (retryTimer.current) clearTimeout(retryTimer.current); }; }, []);

  useEffect(() => {
    if (!puzzle || ownSpectator || gameRef.current) return;
    let initial = createSession(puzzle);
    if (snapshot.self) initial = restoreSession(puzzle, { ...initial, ...snapshot.self }) ?? initial;
    try {
      const draft = JSON.parse(stored(draftKey) || 'null') as { session?: unknown; dirty?: boolean } | null;
      const restored = draft?.dirty ? restoreSession(puzzle, draft.session) : null;
      if (restored && !ownDone) { initial = restored; dirty.current = true; setSaveStatus('pending'); }
    } catch { /* Ignore damaged drafts and use the private server progress. */ }
    if (ownDone) initial.status = 'completed';
    gameRef.current = initial; setGame(initial);
    const first = initial.values.findIndex((value, i) => !value && !puzzle.givens[i]);
    setSelected(first >= 0 ? first : 0);
  }, [puzzle, snapshot.self, draftKey, ownDone, ownSpectator]);

  useEffect(() => {
    if (!ownDone || !gameRef.current) return;
    const completed = { ...gameRef.current, status: 'completed' as const };
    gameRef.current = completed; setGame(completed); dirty.current = false;
    persistDraft(completed, false); setSaveStatus('saved'); setConfirmGiveUp(false);
  }, [ownDone, persistDraft]);

  const flushProgress = useCallback(async () => {
    const current = latest.current;
    const session = gameRef.current;
    if (!mounted.current || inFlight.current || !dirty.current || !session || !current.puzzle || !current.own?.active || current.own.is_spectator || isPlayerDone(current.own) || current.snapshot.room.status !== 'racing' || getRoomTiming(current.snapshot.room, current.serverNow).paused) return;
    inFlight.current = true;
    const sentRevision = revision.current;
    let failed = false;
    try {
      const next = await saveProgress(room.code, [...session.values], session.notes.map(notes => [...notes]), room.round_id, current.snapshot.room.pause_version);
      if (!mounted.current) return;
      current.onSnapshot(next);
      if (sentRevision === revision.current) {
        dirty.current = false; setSaveStatus('saved');
        if (gameRef.current) persistDraft(gameRef.current, false);
      }
    } catch (cause) {
      if (current.onRoomUnavailable(cause)) { dirty.current = false; return; }
      failed = true;
      if (mounted.current) setSaveStatus('retrying');
    } finally {
      inFlight.current = false;
      if (mounted.current && dirty.current && latest.current.own && !isPlayerDone(latest.current.own) && !getRoomTiming(latest.current.snapshot.room, latest.current.serverNow).paused) retryTimer.current = setTimeout(() => { void flushProgress(); }, failed ? 2000 : 200);
    }
  }, [room.code, room.round_id, persistDraft]);

  useEffect(() => {
    if (!game || !dirty.current || roomTiming.paused) return;
    const timer = setTimeout(() => { void flushProgress(); }, 600);
    return () => clearTimeout(timer);
  }, [game?.values, game?.notes, flushProgress, roomTiming.paused, room.pause_version]);

  const edit = useCallback((action: SessionAction) => {
    if (!canPlay || !gameRef.current || submitBusy) return;
    const next = sessionReducer(gameRef.current, action);
    if (next === gameRef.current) return;
    revision.current++; dirty.current = true; setSaveStatus('pending');
    gameRef.current = next; setGame(next); persistDraft(next, true); setError('');
  }, [canPlay, submitBusy, persistDraft]);
  const enterNumber = useCallback((value: number, asNote = effectiveNotes) => {
    if (!puzzle || !gameRef.current || value > puzzle.size) return;
    edit({ type: asNote ? 'toggle-note' : 'set-value', index: selected, value: !asNote && gameRef.current.values[selected] === value ? 0 : value, puzzle });
  }, [puzzle, selected, effectiveNotes, edit]);

  useEffect(() => {
    const release = () => setShiftHeld(false);
    const keyUp = (event: KeyboardEvent) => setShiftHeld(event.shiftKey);
    const keyDown = (event: KeyboardEvent) => {
      setShiftHeld(event.shiftKey);
      const target = event.target as HTMLElement;
      if (!canPlay || !puzzle || event.isComposing || target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === 'z') { event.preventDefault(); edit({ type: event.shiftKey ? 'redo' : 'undo' }); }
        return;
      }
      if (event.altKey) return;
      const shifted = event.shiftKey ? /^(?:Digit|Numpad)([1-8])$/.exec(event.code) : null;
      const number = shifted ? Number(shifted[1]) : /^[1-8]$/.test(event.key) ? Number(event.key) : null;
      if (number !== null) { event.preventDefault(); if (!event.repeat) enterNumber(number, notesMode || event.shiftKey); }
      else if (['Backspace', 'Delete', '0'].includes(event.key)) { event.preventDefault(); edit({ type: 'clear-cell', index: selected, puzzle }); }
      else if (event.key.toLowerCase() === 'n') { event.preventDefault(); if (!event.repeat) setNotesMode(value => !value); }
      else if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        const row = Math.floor(selected / puzzle.size), column = selected % puzzle.size;
        const next = event.key === 'ArrowLeft' ? row * puzzle.size + Math.max(0, column - 1) : event.key === 'ArrowRight' ? row * puzzle.size + Math.min(puzzle.size - 1, column + 1) : event.key === 'ArrowUp' ? Math.max(0, row - 1) * puzzle.size + column : Math.min(puzzle.size - 1, row + 1) * puzzle.size + column;
        setSelected(next); boardRef.current?.querySelector<HTMLButtonElement>(`[data-race-cell="${next}"]`)?.focus();
      }
    };
    const visibility = () => { if (document.visibilityState === 'hidden') release(); };
    window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp); window.addEventListener('blur', release); document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', visibility); };
  }, [canPlay, puzzle, selected, notesMode, enterNumber, edit]);

  const submit = useCallback(async () => {
    const session = gameRef.current;
    if (!puzzle || !session || !canPlay || submitBusy) return;
    const signature = JSON.stringify(session.values);
    submittedSignature.current = signature;
    setSubmitBusy(true); setError('');
    try {
      const next = await submitSolution(room.code, session.values, session.notes, room.round_id, room.pause_version);
      if (!mounted.current) return;
      dirty.current = false; setSaveStatus('saved'); onSnapshot(next);
    } catch (cause) { if (mounted.current && !onRoomUnavailable(cause)) setError(explainError(cause)); }
    finally { if (mounted.current) setSubmitBusy(false); }
  }, [puzzle, canPlay, submitBusy, room.code, room.round_id, room.pause_version, onSnapshot, onRoomUnavailable]);
  useEffect(() => { submittedSignature.current = ''; }, [room.pause_version]);
  useEffect(() => {
    if (!puzzle || !game || !canPlay || !isSolved(puzzle, game.values)) return;
    if (submittedSignature.current === JSON.stringify(game.values)) return;
    void submit();
  }, [game?.values, puzzle, canPlay, submit]);

  const action = async (operation: () => Promise<RoomState>) => {
    if (actionBusy) return;
    setActionBusy(true); setError('');
    try { const next = await operation(); if (mounted.current) onSnapshot(next); }
    catch (cause) { if (mounted.current && !onRoomUnavailable(cause)) setError(explainError(cause)); }
    finally { if (mounted.current) setActionBusy(false); }
  };
  const copyInvite = async () => {
    try { await navigator.clipboard.writeText(location.href); setCopyMessage('Invitation copied.'); }
    catch { setCopyMessage('Share the room code or this page’s address.'); }
  };
  const readyToStart = participants.length >= 2 && participants.every(player => player.ready);
  const elapsed = own?.elapsed_ms ?? roomTiming.elapsed;
  const resumePlayers = participants.filter(player => player.active && !isPlayerDone(player));
  const canGiveUp = room.status === 'racing' && !countdown && own?.active && !ownSpectator && !ownDone;
  const gridPhase = room.status === 'lobby' || room.status === 'finished' ? room.status : null;
  const focusGridChoice = () => {
    const panel = document.getElementById('room-grid-choice');
    panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    panel?.focus({ preventScroll: true });
  };

  return <main className="arena-room">
    <section className="arena-room-top"><div><div className="eyebrow">YOUR SHARED LITTLE CHALLENGE</div><h1>{room.status === 'lobby' ? 'Room for some company.' : ownSpectator ? 'A front-row seat.' : own?.given_up_at ? 'Another round awaits.' : own?.finished_at ? 'A lovely finish.' : 'Find your moment.'}</h1><p>{room.size} × {room.size}<span className="text-dot">·</span>{room.difficulty}<span className="text-dot">·</span>{participants.length} {participants.length === 1 ? 'player' : 'players'}{players.length > participants.length && <><span className="text-dot">·</span>{players.length - participants.length} watching</>}</p></div><div className="arena-room-code"><span>ROOM CODE</span><div><strong>{room.code}</strong><button className="icon-button" aria-label="Copy room invitation" onClick={() => { void copyInvite(); }}><Copy size={18} /></button></div><small role="status">{copyMessage || 'Invite someone into the grid.'}</small></div></section>
    {own && !own.active && <div className="arena-notice arena-rejoin-grid"><span>Rejoin the room to continue.</span><button className="secondary-button" disabled={actionBusy || leaving} onClick={() => { void action(() => joinRoom(room.code, own.nickname)); }}><Users size={16} />Rejoin room</button></div>}
    {gridPhase && <>
      <GridChoicePanel key={`${room.round_id}:${gridPhase}`} snapshot={snapshot} userId={userId} busy={actionBusy || leaving || submitBusy} onVote={choice => { void action(() => voteRoomGrid(room.code, room.round_id, gridPhase, choice)); }} onApply={choice => { void action(() => rematchRoom(room.code, room.round_id, { ...choice, phase: gridPhase })); }} />
      {error && <p className="arena-error" role="alert">{error}</p>}
    </>}
    <div className="arena-room-layout">
      <section className="arena-play-panel">
        {room.status === 'lobby' ? <div className="arena-lobby"><span className="arena-large-icon"><Users size={32} /></span><div className="eyebrow">A LITTLE ANTICIPATION</div><h2>Good company. Good headspace.</h2><p>Share the room code. Everyone gets the same fresh puzzle after a shared countdown.</p><div className="arena-lobby-rules"><span><Check size={16} /> Notes and undo</span><span><Pause size={16} /> Shared pause, shared resume</span><span><Flag size={16} /> Fastest valid finish</span></div><button className={`primary-button ${own?.ready ? 'arena-ready' : ''}`} disabled={actionBusy || leaving} onClick={() => { void action(() => setReady(room.code, !own?.ready, room.round_id)); }}>{actionBusy ? <LoaderCircle className="spin" size={16} /> : own?.ready ? <Check size={16} /> : <Flag size={16} />}{own?.ready ? 'Ready. Let’s do this.' : 'I’m ready'}</button>{room.host_id === userId ? <><button className="secondary-button arena-start" disabled={!readyToStart || actionBusy || leaving} onClick={() => { void action(() => startRoom(room.code, room.round_id)); }}>Start the challenge</button><p className="arena-lobby-detail">{players.length < 2 ? 'Invite at least one more player to begin.' : !readyToStart ? 'Waiting for everyone to be ready.' : 'Everyone is ready. Start when you are.'}</p></> : <p className="arena-lobby-detail">{own?.ready ? 'Waiting for the host to start the challenge.' : 'Mark yourself ready when you’re settled in.'}</p>}</div>
          : roomTiming.paused ? <section className="arena-paused" aria-label="Competition paused" aria-live="polite"><span className="arena-large-icon"><Pause size={30} /></span><div className="eyebrow">A SHARED BREATHER</div><h2>{roomTiming.resuming ? 'Starting together again.' : 'The room is paused.'}</h2><p>The clock is stopped and everyone’s grid is hidden.</p><div className="arena-paused-time"><Clock3 size={17} />{own?.given_up_at ? 'Did not finish' : time(elapsed)}</div>{roomTiming.resuming ? <><strong className="arena-resume-countdown">{roomTiming.resumeSeconds}</strong><p>Everyone is ready. Play resumes together after three seconds.</p></> : <p>Every player still solving must be ready before the three-second countdown starts.</p>}<ul className="arena-resume-list" aria-label="Players ready to resume">{resumePlayers.map(player => <li key={player.user_id}><span>{player.nickname}{player.user_id === userId ? ' (you)' : ''}</span><span>{player.resume_ready ? <Check size={16} /> : <Clock3 size={16} />}{player.resume_ready ? 'Ready' : 'Waiting'}</span></li>)}</ul>{own?.active && !ownSpectator && !ownDone && room.pause_id && <button className={own.resume_ready ? 'secondary-button' : 'primary-button'} disabled={actionBusy || leaving} onClick={() => { void action(() => setResumeReady(room.code, room.round_id, room.pause_id!, !own.resume_ready)); }}>{actionBusy ? <LoaderCircle className="spin" size={17} /> : own.resume_ready ? <Pause size={17} /> : <Play size={17} />}{own.resume_ready ? 'Stay paused' : 'Ready to resume'}</button>}<small>{ownSpectator ? 'You’re watching this round. Only players still solving need to ready up.' : ownDone ? 'Your round is over. Only players still solving need to ready up.' : own?.resume_ready ? 'You can choose Stay paused if you need more time.' : 'Your entries and pencil notes are kept for you.'}</small></section>
          : ownSpectator ? <div className="arena-observer">
              <div className="arena-observer-heading"><span className="arena-large-icon"><Eye size={29} /></span><div><div className="eyebrow">WATCH THIS ROUND. PLAY THE NEXT.</div><h2>{spectatingPlayer ? `Watching ${spectatingPlayer.nickname}` : 'You’re in for the next game.'}</h2><p>You joined after this round started. Spectate a player while you wait, then join the next game in this room.</p></div></div>
              {countdown || !snapshot.puzzle ? <div className="arena-observer-wait" role="status"><Clock3 size={24} /><p>{countdown ? `The shared start is in ${Math.max(1, Math.ceil((startTime - serverNow) / 1000))} seconds.` : 'The room is opening the live grids.'} Spectating begins when the puzzle opens.</p></div> : spectatingPlayer ? <SpectatorBoard key={spectatingPlayer.user_id} roomCode={room.code} roomId={room.id} roundId={room.round_id} pauseVersion={room.pause_version} player={spectatingPlayer} puzzle={snapshot.puzzle} refreshKey={snapshot.server_now} onBack={() => setSpectatingId(null)} backLabel="Choose a player" onRoomUnavailable={onRoomUnavailable} /> : <div className="arena-observer-wait"><Eye size={27} /><h3>Choose a player to watch.</h3><p>Use Spectate beside a player to see their entries and pencil notes.</p></div>}
              <p className="arena-observer-next">{room.status === 'finished' ? 'This round is finished. Vote for the next grid above; you’ll be a player when the host creates the next game.' : 'You’re watching only this round. You’ll get your own grid when the host creates the next game.'}</p>
              {room.status === 'finished' && <button className="secondary-button arena-new-game" disabled={leaving || actionBusy} onClick={focusGridChoice}>Vote for next grid</button>}
            </div>
          : countdown || !puzzle || !game ? <div className="arena-countdown" aria-live="polite"><span className="eyebrow">SAME GRID. SAME START.</span><strong>{countdown ? Math.max(1, Math.ceil((startTime - serverNow) / 1000)) : <LoaderCircle className="spin" size={43} />}</strong><h2>{countdown ? 'A little focus…' : 'Opening your grid…'}</h2><p>{countdown ? 'Your puzzle appears when the countdown ends.' : 'Your official clock is running. The room is syncing your puzzle.'}</p></div>
            : <div className="arena-game"><div className="arena-game-top"><div><span className="eyebrow">{spectatingPlayer ? 'POST-FINISH SPECTATOR' : 'YOUR SIDE OF THE CHALLENGE'}</span><h2>{spectatingPlayer ? `Spectating ${spectatingPlayer.nickname}` : own?.nickname ?? 'Your grid'}</h2></div><div className="arena-clock-controls"><div className="arena-timer"><Clock3 size={17} /><span>{spectatingPlayer && <small className="arena-own-time-label">{own?.given_up_at ? 'Your result' : 'Your time'}</small>}{own?.given_up_at ? 'DNF' : time(elapsed)}</span></div>{!ownDone && own?.active && <button className="arena-pause-button" aria-label="Pause for everyone" disabled={actionBusy || leaving || submitBusy} onClick={() => { void action(() => pauseRoom(room.code, room.round_id, room.pause_version)); }}><Pause size={16} /><span>Pause</span></button>}</div></div>{spectatingPlayer && snapshot.puzzle ? <SpectatorBoard key={spectatingPlayer.user_id} roomCode={room.code} roomId={room.id} roundId={room.round_id} pauseVersion={room.pause_version} player={spectatingPlayer} puzzle={snapshot.puzzle} refreshKey={snapshot.server_now} onBack={() => setSpectatingId(null)} onRoomUnavailable={onRoomUnavailable} /> : <><div className={`puzzle-board arena-board ${own?.finished_at ? 'is-solved' : ''}`} ref={boardRef} style={{ '--size': puzzle.size } as React.CSSProperties} role="grid" aria-label={`${puzzle.size} by ${puzzle.size} competition grid`} aria-rowcount={puzzle.size} aria-colcount={puzzle.size}>{Array.from({ length: puzzle.size }, (_, row) => <div className="board-row" role="row" key={row}>{Array.from({ length: puzzle.size }, (_, column) => {
              const index = row * puzzle.size + column, given = Boolean(puzzle.givens[index]), value = game.values[index];
              const wrong = mistakes.has(index);
              const across = segments.rows.find(run => run.includes(index))!, down = segments.columns.find(run => run.includes(index))!;
              return <button key={index} role="gridcell" aria-selected={selected === index} aria-readonly={given} aria-invalid={wrong || undefined} aria-label={`Row ${row + 1}, column ${column + 1}, ${value || 'empty'}${given ? ', fixed clue' : ''}${!value && game.notes[index].length ? `, notes ${game.notes[index].join(', ')}` : ''}${wrong ? ', rule conflict' : ''}. Across length ${across.length}, down length ${down.length}.`} className={`cell ${given ? 'given' : ''} ${selected === index ? 'selected' : ''} ${peers.has(index) ? 'peer' : ''} ${wrong ? 'incorrect' : ''}`} data-race-cell={index} tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)} disabled={!canPlay} style={{ borderRightWidth: column === puzzle.size - 1 ? 0 : puzzle.rightWalls[index] ? 3 : 1, borderBottomWidth: row === puzzle.size - 1 ? 0 : puzzle.bottomWalls[index] ? 3 : 1, borderRightColor: puzzle.rightWalls[index] ? 'var(--grid)' : 'var(--cell-line)', borderBottomColor: puzzle.bottomWalls[index] ? 'var(--grid)' : 'var(--cell-line)' }}>{value ? <span className="cell-value">{value}</span> : <span className="cell-notes" aria-hidden="true">{Array.from({ length: Math.max(6, puzzle.size) }, (_, n) => <span key={n}>{game.notes[index].includes(n + 1) ? n + 1 : ''}</span>)}</span>}{wrong && <svg className="cell-mistake-cross" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="M0 0 100 100M100 0 0 100" vectorEffect="non-scaling-stroke" /></svg>}</button>;
            })}</div>)}</div><div className="board-caption"><span><span className="clue-sample">1</span> Fixed clue</span><span>No hints. Your own deductions.</span></div></>}{ownDone ? <div className="arena-finish">{own?.given_up_at ? <Flag size={25} /> : <Trophy size={25} />}<div><h3>{own?.given_up_at ? 'You gave it a go.' : 'Beautifully solved.'}</h3>{own?.given_up_at ? <p>Did not finish this round.</p> : <p>Official time: {time(own?.elapsed_ms ?? 0)}.{String(Math.round((own?.elapsed_ms ?? 0) % 1000)).padStart(3, '0')}</p>}<span>{room.status === 'finished' ? 'The results are in.' : own?.given_up_at ? 'You can spectate while the others finish.' : 'Your time is locked. Cheer the others on.'}</span>{room.host_id === userId ? <><button className="primary-button arena-new-game" disabled={room.status !== 'finished' || leaving || actionBusy || submitBusy} onClick={focusGridChoice}><Sparkles size={17} />Choose next grid</button><span>{room.status === 'finished' ? 'Vote above, then the host picks the next grid. Everyone will ready up again.' : 'Waiting for everyone to finish or give up before the next round.'}</span></> : <>{room.status === 'finished' && <button className="secondary-button arena-new-game" disabled={leaving || actionBusy} onClick={focusGridChoice}>Vote for next grid</button>}<span>{room.status === 'finished' ? 'Vote above. The host has the final say on the next grid.' : 'The host can create the next game after everyone finishes or gives up.'}</span></>}</div></div> : <><div className="number-pad" style={{ '--numbers': puzzle.size } as React.CSSProperties} aria-label="Competition number pad">{Array.from({ length: puzzle.size }, (_, index) => index + 1).map(value => <button key={value} disabled={!canPlay || Boolean(puzzle.givens[selected])} className={effectiveNotes ? 'note-key' : ''} aria-label={`${effectiveNotes ? 'Toggle note' : 'Enter'} ${value}`} onClick={event => enterNumber(value, notesMode || event.shiftKey)}>{value}</button>)}</div><div className="game-tools arena-tools"><button disabled={!canPlay || !game.history.length} onClick={() => edit({ type: 'undo' })}><Undo2 size={19} /><span>Undo</span></button><button disabled={!canPlay || !game.future.length} onClick={() => edit({ type: 'redo' })}><Redo2 size={19} /><span>Redo</span></button><button disabled={!canPlay || Boolean(puzzle.givens[selected])} onClick={() => edit({ type: 'clear-cell', index: selected, puzzle })}><Eraser size={19} /><span>Erase</span></button><button disabled={!canPlay} className={effectiveNotes ? 'tool-active' : ''} aria-pressed={effectiveNotes} onClick={() => setNotesMode(value => !value)} title="Pencil notes (N, or hold Shift)"><Pencil size={19} /><span>Notes <small>{effectiveNotes ? 'ON' : 'OFF'}</small></span></button></div><button className="primary-button arena-submit" disabled={!canPlay || !game.values.every(Boolean)} onClick={() => { void submit(); }}>{submitBusy ? <LoaderCircle className="spin" size={17} /> : <Flag size={17} />}{submitBusy ? 'Checking your finish…' : 'Submit solution'}</button><p className="arena-save-status" role="status">{saveStatus === 'saved' ? 'Your progress is synced with the room.' : saveStatus === 'pending' ? 'Saving your progress…' : draftAvailable ? 'Progress saved on this device. Retrying room sync…' : 'Room sync is disconnected and device storage is unavailable. Keep this tab open.'}</p></>}</div>}
        {canGiveUp && <div className="arena-give-up">{confirmGiveUp ? <section aria-label="Confirm giving up" aria-live="polite"><h3>Give up this round?</h3><p>You’ll be marked “Did not finish”. You can still spectate and join the next game.</p><div><button className="secondary-button" disabled={actionBusy || leaving || submitBusy} onClick={() => setConfirmGiveUp(false)}>Keep playing</button><button className="primary-button" disabled={actionBusy || leaving || submitBusy} onClick={() => { void action(() => giveUpRoom(room.code, room.round_id)); }}>{actionBusy ? <LoaderCircle className="spin" size={16} /> : <Flag size={16} />}{actionBusy ? 'Giving up…' : 'Give up round'}</button></div></section> : <button className="arena-give-up-button" disabled={actionBusy || leaving || submitBusy} onClick={() => setConfirmGiveUp(true)}><Flag size={15} />Give up</button>}</div>}
        {error && !gridPhase && <p className="arena-error" role="alert">{error}</p>}
      </section>
      <aside className="arena-players" aria-label="Players and results"><div className="arena-players-heading"><span className="eyebrow">{room.status === 'lobby' ? 'THE COMPANY' : room.status === 'finished' ? 'THE RESULTS' : 'THE CHALLENGE'}</span><span>{players.length} / 8</span></div><h2>{room.status === 'lobby' ? 'Make yourself at home.' : 'One number at a time.'}</h2><div className="arena-player-list">{rankedPlayers.map(player => {
        const finished = player.finished_at !== null;
        const rank = finished ? 1 + allFinishedPlayers.filter(other => (other.elapsed_ms ?? Infinity) < (player.elapsed_ms ?? Infinity)).length : null;
        const online = presence === null ? null : player.user_id === userId || presence.includes(player.user_id);
        const away = player.is_away || !player.active;
        const canKick = room.host_id === userId && own?.active && player.user_id !== userId && away;
        const percent = Math.min(100, Math.round(player.progress_count / Math.max(1, editableCount) * 100));
        return <div className={`arena-player ${player.user_id === userId ? 'is-you' : ''}`} key={player.user_id}>
          <div className="arena-player-line"><span className={`arena-player-avatar ${rank === 1 ? 'winner' : ''}`}>{player.is_spectator ? <Eye size={17} /> : rank === 1 ? <Trophy size={18} /> : rank ?? player.nickname.slice(0, 1).toUpperCase()}</span><span className="arena-player-name"><strong>{player.nickname}{player.user_id === userId && <small>you</small>}</strong><span>{player.is_spectator ? 'Spectating · plays next round' : room.status === 'lobby' ? player.ready ? 'Ready to go' : 'Getting settled' : finished ? `Finished in ${time(player.elapsed_ms ?? 0)}` : player.given_up_at ? 'Did not finish' : roomTiming.paused ? player.resume_ready ? 'Ready to resume' : player.active ? 'Paused' : 'Left room' : countdown ? 'Starting together' : `${percent}% filled`}{player.user_id === room.host_id && <span className="arena-host-label"> · host</span>}</span></span><span className="arena-player-status">{finished ? <span className="arena-rank">#{rank}</span> : room.status === 'lobby' && player.ready ? <Check className="arena-ready-check" size={18} /> : null}{away ? <span className="arena-away">away</span> : online === false ? <span className="arena-away">reconnecting</span> : null}</span></div>
          {!player.is_spectator && room.status !== 'lobby' && !countdown && <div className="progress-track" role="progressbar" aria-label={`${player.nickname} progress`} aria-valuenow={finished ? 100 : percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${finished ? 100 : percent}%` }} /></div>}
          {canSpectate && !player.is_spectator && player.user_id !== userId && <button className="arena-spectate-button" aria-pressed={spectatingPlayer?.user_id === player.user_id} disabled={leaving || roomTiming.paused || countdown || !snapshot.puzzle} onClick={() => { setSpectatingId(player.user_id); setError(''); }}><Eye size={15} /><span>Spectate {player.nickname}</span></button>}
          {canKick && (kickTarget === player.user_id ? <section className="arena-kick-confirm" aria-label={`Confirm removing ${player.nickname}`}><p>Remove {player.nickname} from this room? They can’t rejoin this room. Their recorded result is kept.</p><div><button className="secondary-button" disabled={actionBusy || leaving} onClick={() => setKickTarget(null)}>Keep player</button><button className="secondary-button" disabled={actionBusy || leaving} onClick={() => { void action(() => kickRoomPlayer(room.code, player.user_id, room.round_id)); }}><UserMinus size={14} />Remove player</button></div></section> : <button className="arena-kick-button" disabled={actionBusy || leaving || submitBusy} aria-label={`Remove ${player.nickname} from room`} onClick={() => setKickTarget(player.user_id)}><UserMinus size={14} />Remove away player</button>)}
        </div>;
      })}</div>
      {(snapshot.removed_results ?? []).length > 0 && <section className="arena-removed-results" aria-label="Removed players’ results"><h3>Removed this round</h3>{snapshot.removed_results.map(player => {
        const rank = player.finished_at ? 1 + allFinishedPlayers.filter(other => (other.elapsed_ms ?? Infinity) < (player.elapsed_ms ?? Infinity)).length : null;
        return <div key={player.user_id}><strong>{player.nickname}</strong><span>{rank ? `#${rank} · Finished in ${time(player.elapsed_ms ?? 0)}` : 'Did not finish'} · removed</span></div>;
      })}</section>}
      <div className="arena-fair-play"><Flag size={17} /><p>Same puzzle. Shared start.<br /><span>Only players still solving ready up after a pause. Midgame arrivals watch this round and play the next. The host can remove players who leave or are away for a minute.</span></p></div><button className="arena-leave" disabled={leaving || actionBusy || submitBusy} onClick={onLeave}><LogOut size={15} />{leaving ? 'Leaving…' : 'Leave room'}</button></aside>
    </div>
  </main>;
}

interface SpectatorBoardProps {
  roomCode: string;
  roomId: string;
  roundId: string;
  pauseVersion: number;
  player: RoomPlayer;
  puzzle: PublicPuzzle;
  refreshKey: string;
  onBack: () => void;
  backLabel?: string;
  onRoomUnavailable: (cause: unknown) => boolean;
}

/** Opponent progress stays inside this mounted, server-authorized read-only view. */
function SpectatorBoard({ roomCode, roomId, roundId, pauseVersion, player, puzzle, refreshKey, onBack, backLabel = 'Back to my grid', onRoomUnavailable }: SpectatorBoardProps) {
  const [progress, setProgress] = useState<SpectatorState | null>(null);
  const mistakes = useMemo(() => progress ? getMistakes({ ...puzzle, solution: [] }, progress.values) : new Set<number>(), [puzzle, progress?.values]);
  const [error, setError] = useState('');
  const [fetching, setFetching] = useState(false);
  const [lastSynced, setLastSynced] = useState<number | null>(null);
  const requestRefresh = useRef<(force?: boolean) => void>(() => {});

  useLayoutEffect(() => {
    let stopped = false, inFlight = false, lastRequested = 0, lastAccepted = 0;
    let controller: AbortController | null = null;
    const refresh = async (force = false) => {
      if (stopped || inFlight || (!force && Date.now() - lastRequested < 500)) return;
      inFlight = true;
      lastRequested = Date.now();
      const pending = new AbortController();
      controller = pending;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; pending.abort(); }, 12_000);
      setFetching(true);
      try {
        const next = await getSpectatorState(roomCode, player.user_id, puzzle, pending.signal, roundId, pauseVersion);
        if (stopped) return;
        if (next.room_id !== roomId || next.player_id !== player.user_id) {
          throw new Error('This live view no longer matches the selected player.');
        }
        const responseTime = Date.parse(next.server_now);
        if (!Number.isFinite(responseTime) || responseTime < lastAccepted) return;
        lastAccepted = responseTime;
        setProgress(next);
        setLastSynced(Date.now());
        setError('');
      } catch (cause) {
        if (!stopped && !onRoomUnavailable(cause)) setError(timedOut ? 'The live view lost its connection. We’ll keep trying to reconnect.' : explainError(cause));
      } finally {
        clearTimeout(timeout);
        inFlight = false;
        if (controller === pending) controller = null;
        if (!stopped) setFetching(false);
      }
    };
    requestRefresh.current = force => { void refresh(force); };
    void refresh(true);
    const poll = setInterval(() => { void refresh(); }, 1000);
    return () => {
      stopped = true;
      clearInterval(poll);
      controller?.abort();
      requestRefresh.current = () => {};
    };
  }, [roomCode, roomId, roundId, pauseVersion, player.user_id, puzzle.id]);

  // Room broadcasts prompt a refresh too, without overlapping the regular poll.
  useEffect(() => { requestRefresh.current(); }, [refreshKey]);

  const stale = lastSynced !== null && Date.now() - lastSynced >= 5000;
  const live = progress !== null && !error && !stale;
  const reconnecting = progress !== null && !live;
  const lastSyncText = lastSynced === null ? '' : new Date(lastSynced).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return <section className="arena-spectator" aria-label={`Spectating ${player.nickname}`}>
    <div className="arena-spectator-toolbar"><div className="arena-spectator-badges"><span className={`arena-live-badge ${live ? 'is-live' : ''}`}><span />{live ? 'Live' : reconnecting ? 'Reconnecting' : fetching ? 'Connecting' : 'Disconnected'}</span><span className="arena-readonly-badge"><Eye size={13} /> Read-only</span></div><button className="secondary-button arena-back-to-grid" onClick={onBack}>{backLabel}</button></div>
    <p className="arena-spectator-caption">{player.finished_at ? `${player.nickname} finished in ${time(player.elapsed_ms ?? 0)}.` : player.given_up_at ? `${player.nickname} gave up this round.` : `${player.nickname} is working through the grid.`} Their entries and pencil notes appear here.</p>
    {progress ? <><div className={`puzzle-board arena-board arena-spectator-board ${reconnecting ? 'is-reconnecting' : ''}`} style={{ '--size': puzzle.size } as React.CSSProperties} role="grid" aria-label={`${player.nickname}’s ${puzzle.size} by ${puzzle.size} grid, read-only`} aria-readonly="true" aria-rowcount={puzzle.size} aria-colcount={puzzle.size}>
      {Array.from({ length: puzzle.size }, (_, row) => <div className="board-row" role="row" key={row}>{Array.from({ length: puzzle.size }, (_, column) => {
        const index = row * puzzle.size + column, value = progress.values[index], given = Boolean(puzzle.givens[index]);
        const notes = progress.notes[index];
        const wrong = mistakes.has(index);
        return <div key={index} role="gridcell" aria-readonly="true" aria-invalid={wrong || undefined} aria-rowindex={row + 1} aria-colindex={column + 1} aria-label={`Row ${row + 1}, column ${column + 1}, ${value || 'empty'}${given ? ', fixed clue' : ''}${!value && notes.length ? `, notes ${notes.join(', ')}` : ''}${wrong ? ', rule conflict' : ''}, read-only`} data-spectator-cell={index} className={`cell ${given ? 'given' : ''} ${wrong ? 'incorrect' : ''}`} style={{ borderRightWidth: column === puzzle.size - 1 ? 0 : puzzle.rightWalls[index] ? 3 : 1, borderBottomWidth: row === puzzle.size - 1 ? 0 : puzzle.bottomWalls[index] ? 3 : 1, borderRightColor: puzzle.rightWalls[index] ? 'var(--grid)' : 'var(--cell-line)', borderBottomColor: puzzle.bottomWalls[index] ? 'var(--grid)' : 'var(--cell-line)' }}>{value ? <span className="cell-value">{value}</span> : <span className="cell-notes" aria-hidden="true">{Array.from({ length: Math.max(6, puzzle.size) }, (_, n) => <span key={n}>{notes.includes(n + 1) ? n + 1 : ''}</span>)}</span>}{wrong && <svg className="cell-mistake-cross" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="M0 0 100 100M100 0 0 100" vectorEffect="non-scaling-stroke" /></svg>}</div>;
      })}</div>)}
    </div><div className="board-caption"><span><span className="clue-sample">1</span> Fixed clue</span><span>{live ? 'Updates as they play' : 'Last received grid'}</span></div></>
      : <div className="arena-spectator-placeholder" role="status">{error ? <><Eye size={30} /><h3>Live view unavailable.</h3><p>We couldn’t load this player’s grid yet.</p></> : <><LoaderCircle className="spin" size={31} /><h3>Opening their grid…</h3><p>Connecting to {player.nickname}’s progress.</p></>}</div>}
    {(error || stale) && <div className="arena-spectator-error" role="status"><p>{error || 'Waiting for the latest update. This is the last grid we received.'}</p><button className="secondary-button" disabled={fetching} onClick={() => requestRefresh.current(true)}>{fetching ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}{fetching ? 'Reconnecting…' : 'Retry live view'}</button></div>}
    {lastSyncText && <p className="arena-spectator-sync">Last synced {lastSyncText}. {live ? 'This view is live.' : 'New updates will appear when the connection returns.'}</p>}
  </section>;
}
