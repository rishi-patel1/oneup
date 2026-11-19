import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Clock3, Copy, Eraser, Flag, LoaderCircle, LogOut, Pencil, Redo2, RotateCcw, Sparkles, Trophy, Undo2, Users } from 'lucide-react';
import { APP_NAME } from '../branding';
import BrandMark from './BrandMark';
import type { Difficulty, Puzzle } from '../game/engine';
import { getSegments, isSolved } from '../game/engine';
import { createSession, restoreSession, serializeSession, sessionReducer, type Session, type SessionAction } from '../game/session';
import { createRoom, explainError, getRoom, getUserId, isSupabaseConfigured, joinRoom, leaveRoom, saveProgress, setReady, startRoom, submitSolution, watchRoom, type RoomState } from '../multiplayer/api';
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

export default function CompetitionPage({ onSolo }: { onSolo: () => void }) {
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
  const [clockOffset, setClockOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const codeRef = useRef('');
  const lastServerTime = useRef(0);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const latestSnapshot = useRef<RoomState | null>(snapshot);
  latestSnapshot.current = snapshot;

  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  const accept = useCallback((next: RoomState) => {
    if (!mounted.current || next.room.code !== codeRef.current) return;
    const serverTime = Date.parse(next.server_now);
    if (!Number.isFinite(serverTime) || serverTime < lastServerTime.current) return;
    lastServerTime.current = serverTime;
    setClockOffset(serverTime - Date.now());
    setNow(Date.now());
    setSnapshot(next);
    setSyncWarning('');
  }, []);
  const enter = useCallback((next: RoomState) => {
    codeRef.current = next.room.code;
    lastServerTime.current = 0;
    setPresence(null);
    remember(ROOM_KEY, next.room.code);
    updateRoomUrl(next.room.code);
    accept(next);
  }, [accept]);

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
        setEntryMode('join'); setCode(pendingCode);
        setError(`Join this room to continue. ${explainError(cause)}`);
      } finally { if (mounted.current && token === epoch.current) setBusy(false); }
    })();
    return () => { epoch.current++; };
  }, [enter]);

  const roomId = snapshot?.room.id;
  const roomCode = snapshot?.room.code;
  useEffect(() => {
    if (!roomId || !roomCode) return;
    let stopped = false, inFlight = false, lastPoll = 0;
    const refresh = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      lastPoll = Date.now();
      try { const next = await getRoom(roomCode); if (!stopped) accept(next); }
      catch { if (!stopped) setSyncWarning('Room sync is reconnecting. Your entries stay on this device while we retry.'); }
      finally { inFlight = false; }
    };
    let stopWatching = () => {};
    try { stopWatching = watchRoom(roomId, () => { void refresh(); }, ids => { if (!stopped) setPresence(ids); }); }
    catch { setSyncWarning('Live updates are reconnecting. The room will keep checking for changes.'); }
    const interval = window.setInterval(() => {
      const current = latestSnapshot.current;
      const pace = current?.room.status === 'racing' && !current.puzzle ? 500 : 3000;
      if (Date.now() - lastPoll >= pace) void refresh();
    }, 500);
    void refresh();
    return () => { stopped = true; window.clearInterval(interval); stopWatching(); };
  }, [roomId, roomCode, accept]);

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
    } catch (cause) { if (mounted.current && token === epoch.current) setError(explainError(cause)); }
    finally { if (mounted.current && token === epoch.current) setBusy(false); }
  };

  const exitRoom = async () => {
    if (!snapshot || busy) return;
    setBusy(true); setError('');
    try {
      await leaveRoom(snapshot.room.code);
      epoch.current++; codeRef.current = ''; lastServerTime.current = 0;
      forget(ROOM_KEY); updateRoomUrl(); setSnapshot(null); setPresence(null); setSyncWarning('');
    } catch (cause) { setError(explainError(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };

  const retryRoomSync = async () => {
    if (!snapshot || syncRetrying) return;
    setSyncRetrying(true);
    try { const next = await getRoom(snapshot.room.code); accept(next); }
    catch (cause) { if (mounted.current) setSyncWarning(explainError(cause)); }
    finally { if (mounted.current) setSyncRetrying(false); }
  };

  return <div className="app-shell arena-shell">
    <header className="site-header arena-header">
      <a className="brand" href="#" aria-label={`${APP_NAME} solo play`} onClick={event => { event.preventDefault(); onSolo(); }}><span className="brand-mark"><BrandMark /></span><span>{APP_NAME}<span className="brand-period">.</span></span></a>
      <nav aria-label="Main navigation"><button className="nav-link" onClick={onSolo}>Solo play</button><button className="nav-link active" aria-current="page">Compete</button></nav>
      <span className="arena-header-note"><Users size={16} /> A little friendly rivalry</span>
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
        <p className="arena-entry-caption">Nicknames only. Notes and undo are welcome.<br />Hints, mistake checking, and pauses sit this one out.</p>
      </section>
    </main> : <RoomScreen key={snapshot.room.id} snapshot={snapshot} userId={userId} serverNow={now + clockOffset} presence={presence} onSnapshot={accept} onLeave={() => { void exitRoom(); }} leaving={busy} />}
    {snapshot && (error || syncWarning) && <div className={`arena-room-message ${error ? 'arena-error' : 'arena-notice'}`} role={error ? 'alert' : 'status'}><span>{error || syncWarning}</span>{syncWarning && !error && <button className="secondary-button arena-sync-retry" disabled={syncRetrying} onClick={() => { void retryRoomSync(); }}>{syncRetrying ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}{syncRetrying ? 'Reconnecting…' : 'Retry room sync'}</button>}</div>}
    <footer className="site-footer arena-footer"><span>Small grids. Shared headspace.</span><span>Your official time is measured by the room server.</span></footer>
  </div>;
}

interface RoomProps {
  snapshot: RoomState;
  userId: string;
  serverNow: number;
  presence: string[] | null;
  onSnapshot: (state: RoomState) => void;
  onLeave: () => void;
  leaving: boolean;
}

function RoomScreen({ snapshot, userId, serverNow, presence, onSnapshot, onLeave, leaving }: RoomProps) {
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
  const [error, setError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'pending' | 'retrying'>('saved');
  const [draftAvailable, setDraftAvailable] = useState(true);
  const mounted = useRef(true);
  const revision = useRef(0);
  const dirty = useRef(false);
  const inFlight = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const submittedSignature = useRef('');
  const latest = useRef({ snapshot, puzzle, own, onSnapshot });
  latest.current = { snapshot, puzzle, own, onSnapshot };
  const draftKey = `numora:competition:draft:${room.id}:${userId}`;
  const startTime = room.starts_at ? Date.parse(room.starts_at) : Infinity;
  const countdown = room.status === 'racing' && serverNow < startTime;
  const canPlay = Boolean(puzzle && game && room.status === 'racing' && !countdown && !own?.finished_at && !submitBusy);
  const effectiveNotes = notesMode || shiftHeld;
  const editableCount = puzzle?.givens.filter(value => !value).length ?? room.size ** 2;
  const segments = useMemo(() => puzzle ? getSegments(puzzle) : { rows: [], columns: [] }, [puzzle]);
  const peers = useMemo(() => new Set([...(segments.rows.find(run => run.includes(selected)) ?? []), ...(segments.columns.find(run => run.includes(selected)) ?? [])]), [segments, selected]);
  const finishedPlayers = [...players].filter(player => player.finished_at !== null).sort((a, b) => (a.elapsed_ms ?? Infinity) - (b.elapsed_ms ?? Infinity));
  const rankedPlayers = [...finishedPlayers, ...players.filter(player => player.finished_at === null).sort((a, b) => b.progress_count - a.progress_count)];

  const persistDraft = useCallback((session: Session, isDirty: boolean) => {
    if (isDirty) setDraftAvailable(remember(draftKey, JSON.stringify({ session: serializeSession(session), dirty: true })));
    else forget(draftKey);
  }, [draftKey]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; if (retryTimer.current) clearTimeout(retryTimer.current); }; }, []);

  useEffect(() => {
    if (!puzzle || gameRef.current) return;
    let initial = createSession(puzzle);
    if (snapshot.self) initial = restoreSession(puzzle, { ...initial, ...snapshot.self }) ?? initial;
    try {
      const draft = JSON.parse(stored(draftKey) || 'null') as { session?: unknown; dirty?: boolean } | null;
      const restored = draft?.dirty ? restoreSession(puzzle, draft.session) : null;
      if (restored && !own?.finished_at) { initial = restored; dirty.current = true; setSaveStatus('pending'); }
    } catch { /* Ignore damaged drafts and use the private server progress. */ }
    if (own?.finished_at) initial.status = 'completed';
    gameRef.current = initial; setGame(initial);
    const first = initial.values.findIndex((value, i) => !value && !puzzle.givens[i]);
    setSelected(first >= 0 ? first : 0);
  }, [puzzle, snapshot.self, draftKey, own?.finished_at]);

  useEffect(() => {
    if (!own?.finished_at || !gameRef.current) return;
    const completed = { ...gameRef.current, status: 'completed' as const };
    gameRef.current = completed; setGame(completed); dirty.current = false;
    persistDraft(completed, false); setSaveStatus('saved');
  }, [own?.finished_at, persistDraft]);

  const flushProgress = useCallback(async () => {
    const current = latest.current;
    const session = gameRef.current;
    if (!mounted.current || inFlight.current || !dirty.current || !session || !current.puzzle || current.own?.finished_at || current.snapshot.room.status !== 'racing') return;
    inFlight.current = true;
    const sentRevision = revision.current;
    let failed = false;
    try {
      const next = await saveProgress(room.code, [...session.values], session.notes.map(notes => [...notes]));
      if (!mounted.current) return;
      current.onSnapshot(next);
      if (sentRevision === revision.current) {
        dirty.current = false; setSaveStatus('saved');
        if (gameRef.current) persistDraft(gameRef.current, false);
      }
    } catch {
      failed = true;
      if (mounted.current) setSaveStatus('retrying');
    } finally {
      inFlight.current = false;
      if (mounted.current && dirty.current) retryTimer.current = setTimeout(() => { void flushProgress(); }, failed ? 2000 : 200);
    }
  }, [room.code, persistDraft]);

  useEffect(() => {
    if (!game || !dirty.current) return;
    const timer = setTimeout(() => { void flushProgress(); }, 600);
    return () => clearTimeout(timer);
  }, [game?.values, game?.notes, flushProgress]);

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
      const next = await submitSolution(room.code, session.values, session.notes);
      if (!mounted.current) return;
      dirty.current = false; setSaveStatus('saved'); onSnapshot(next);
    } catch (cause) { if (mounted.current) setError(explainError(cause)); }
    finally { if (mounted.current) setSubmitBusy(false); }
  }, [puzzle, canPlay, submitBusy, room.code, onSnapshot]);
  useEffect(() => {
    if (!puzzle || !game || !canPlay || !isSolved(puzzle, game.values)) return;
    if (submittedSignature.current === JSON.stringify(game.values)) return;
    void submit();
  }, [game?.values, puzzle, canPlay, submit]);

  const action = async (operation: () => Promise<RoomState>) => {
    if (actionBusy) return;
    setActionBusy(true); setError('');
    try { const next = await operation(); if (mounted.current) onSnapshot(next); }
    catch (cause) { if (mounted.current) setError(explainError(cause)); }
    finally { if (mounted.current) setActionBusy(false); }
  };
  const copyInvite = async () => {
    try { await navigator.clipboard.writeText(location.href); setCopyMessage('Invitation copied.'); }
    catch { setCopyMessage('Share the room code or this page’s address.'); }
  };
  const readyToStart = players.length >= 2 && players.every(player => player.ready);
  const elapsed = own?.elapsed_ms ?? (room.status === 'lobby' ? 0 : Math.max(0, serverNow - startTime));

  return <main className="arena-room">
    <section className="arena-room-top"><div><div className="eyebrow">YOUR SHARED LITTLE CHALLENGE</div><h1>{room.status === 'lobby' ? 'Room for some company.' : own?.finished_at ? 'A lovely finish.' : 'Find your moment.'}</h1><p>{room.size} × {room.size}<span className="text-dot">·</span>{room.difficulty}<span className="text-dot">·</span>{players.length} {players.length === 1 ? 'player' : 'players'}</p></div><div className="arena-room-code"><span>ROOM CODE</span><div><strong>{room.code}</strong><button className="icon-button" aria-label="Copy room invitation" onClick={() => { void copyInvite(); }}><Copy size={18} /></button></div><small role="status">{copyMessage || 'Invite someone into the grid.'}</small></div></section>
    <div className="arena-room-layout">
      <section className="arena-play-panel">
        {room.status === 'lobby' ? <div className="arena-lobby"><span className="arena-large-icon"><Users size={32} /></span><div className="eyebrow">A LITTLE ANTICIPATION</div><h2>Good company. Good headspace.</h2><p>Share the room code. Everyone gets the same fresh puzzle after a shared countdown.</p><div className="arena-lobby-rules"><span><Check size={16} /> Notes and undo</span><span><Clock3 size={16} /> One continuous clock</span><span><Flag size={16} /> Fastest valid finish</span></div><button className={`primary-button ${own?.ready ? 'arena-ready' : ''}`} disabled={actionBusy || leaving} onClick={() => { void action(() => setReady(room.code, !own?.ready)); }}>{actionBusy ? <LoaderCircle className="spin" size={16} /> : own?.ready ? <Check size={16} /> : <Flag size={16} />}{own?.ready ? 'Ready. Let’s do this.' : 'I’m ready'}</button>{room.host_id === userId ? <><button className="secondary-button arena-start" disabled={!readyToStart || actionBusy || leaving} onClick={() => { void action(() => startRoom(room.code)); }}>Start the challenge</button><p className="arena-lobby-detail">{players.length < 2 ? 'Invite at least one more player to begin.' : !readyToStart ? 'Waiting for everyone to be ready.' : 'Everyone is ready. Start when you are.'}</p></> : <p className="arena-lobby-detail">{own?.ready ? 'Waiting for the host to start the challenge.' : 'Mark yourself ready when you’re settled in.'}</p>}</div>
          : countdown || !puzzle || !game ? <div className="arena-countdown" aria-live="polite"><span className="eyebrow">SAME GRID. SAME START.</span><strong>{countdown ? Math.max(1, Math.ceil((startTime - serverNow) / 1000)) : <LoaderCircle className="spin" size={43} />}</strong><h2>{countdown ? 'A little focus…' : 'Opening your grid…'}</h2><p>{countdown ? 'Your puzzle appears when the countdown ends.' : 'Your official clock is running. The room is syncing your puzzle.'}</p></div>
            : <div className="arena-game"><div className="arena-game-top"><div><span className="eyebrow">YOUR SIDE OF THE CHALLENGE</span><h2>{own?.nickname ?? 'Your grid'}</h2></div><div className="arena-timer"><Clock3 size={17} /><span>{time(elapsed)}</span></div></div><div className={`puzzle-board arena-board ${own?.finished_at ? 'is-solved' : ''}`} ref={boardRef} style={{ '--size': puzzle.size } as React.CSSProperties} role="grid" aria-label={`${puzzle.size} by ${puzzle.size} competition grid`} aria-rowcount={puzzle.size} aria-colcount={puzzle.size}>{Array.from({ length: puzzle.size }, (_, row) => <div className="board-row" role="row" key={row}>{Array.from({ length: puzzle.size }, (_, column) => {
              const index = row * puzzle.size + column, given = Boolean(puzzle.givens[index]), value = game.values[index];
              const across = segments.rows.find(run => run.includes(index))!, down = segments.columns.find(run => run.includes(index))!;
              return <button key={index} role="gridcell" aria-selected={selected === index} aria-readonly={given} aria-label={`Row ${row + 1}, column ${column + 1}, ${value || 'empty'}${given ? ', fixed clue' : ''}${!value && game.notes[index].length ? `, notes ${game.notes[index].join(', ')}` : ''}. Across length ${across.length}, down length ${down.length}.`} className={`cell ${given ? 'given' : ''} ${selected === index ? 'selected' : ''} ${peers.has(index) ? 'peer' : ''}`} data-race-cell={index} tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)} disabled={!canPlay} style={{ borderRightWidth: column === puzzle.size - 1 ? 0 : puzzle.rightWalls[index] ? 3 : 1, borderBottomWidth: row === puzzle.size - 1 ? 0 : puzzle.bottomWalls[index] ? 3 : 1, borderRightColor: puzzle.rightWalls[index] ? 'var(--grid)' : 'var(--cell-line)', borderBottomColor: puzzle.bottomWalls[index] ? 'var(--grid)' : 'var(--cell-line)' }}>{value ? <span className="cell-value">{value}</span> : <span className="cell-notes" aria-hidden="true">{Array.from({ length: Math.max(6, puzzle.size) }, (_, n) => <span key={n}>{game.notes[index].includes(n + 1) ? n + 1 : ''}</span>)}</span>}</button>;
            })}</div>)}</div><div className="board-caption"><span><span className="clue-sample">1</span> Fixed clue</span><span>No hints. Your own deductions.</span></div>{own?.finished_at ? <div className="arena-finish"><Trophy size={25} /><div><h3>Beautifully solved.</h3><p>Official time: {time(own.elapsed_ms ?? 0)}.{String(Math.round((own.elapsed_ms ?? 0) % 1000)).padStart(3, '0')}</p><span>{room.status === 'finished' ? 'The results are in.' : 'Your time is locked. Cheer the others on.'}</span></div></div> : <><div className="number-pad" style={{ '--numbers': puzzle.size } as React.CSSProperties} aria-label="Competition number pad">{Array.from({ length: puzzle.size }, (_, index) => index + 1).map(value => <button key={value} disabled={!canPlay || Boolean(puzzle.givens[selected])} className={effectiveNotes ? 'note-key' : ''} aria-label={`${effectiveNotes ? 'Toggle note' : 'Enter'} ${value}`} onClick={event => enterNumber(value, notesMode || event.shiftKey)}>{value}</button>)}</div><div className="game-tools arena-tools"><button disabled={!canPlay || !game.history.length} onClick={() => edit({ type: 'undo' })}><Undo2 size={19} /><span>Undo</span></button><button disabled={!canPlay || !game.future.length} onClick={() => edit({ type: 'redo' })}><Redo2 size={19} /><span>Redo</span></button><button disabled={!canPlay || Boolean(puzzle.givens[selected])} onClick={() => edit({ type: 'clear-cell', index: selected, puzzle })}><Eraser size={19} /><span>Erase</span></button><button disabled={!canPlay} className={effectiveNotes ? 'tool-active' : ''} aria-pressed={effectiveNotes} onClick={() => setNotesMode(value => !value)} title="Pencil notes (N, or hold Shift)"><Pencil size={19} /><span>Notes <small>{effectiveNotes ? 'ON' : 'OFF'}</small></span></button></div><button className="primary-button arena-submit" disabled={!canPlay || !game.values.every(Boolean)} onClick={() => { void submit(); }}>{submitBusy ? <LoaderCircle className="spin" size={17} /> : <Flag size={17} />}{submitBusy ? 'Checking your finish…' : 'Submit solution'}</button><p className="arena-save-status" role="status">{saveStatus === 'saved' ? 'Your progress is synced with the room.' : saveStatus === 'pending' ? 'Saving your progress…' : draftAvailable ? 'Progress saved on this device. Retrying room sync…' : 'Room sync is disconnected and device storage is unavailable. Keep this tab open.'}</p></>}</div>}
        {error && <p className="arena-error" role="alert">{error}</p>}
      </section>
      <aside className="arena-players" aria-label="Players and results"><div className="arena-players-heading"><span className="eyebrow">{room.status === 'lobby' ? 'THE COMPANY' : room.status === 'finished' ? 'THE RESULTS' : 'THE CHALLENGE'}</span><span>{players.length} / 8</span></div><h2>{room.status === 'lobby' ? 'Make yourself at home.' : 'One number at a time.'}</h2><div className="arena-player-list">{rankedPlayers.map(player => {
        const finished = player.finished_at !== null;
        const rank = finished ? 1 + finishedPlayers.filter(other => (other.elapsed_ms ?? Infinity) < (player.elapsed_ms ?? Infinity)).length : null;
        const online = presence === null ? null : player.user_id === userId || presence.includes(player.user_id);
        const percent = Math.min(100, Math.round(player.progress_count / Math.max(1, editableCount) * 100));
        return <div className={`arena-player ${player.user_id === userId ? 'is-you' : ''}`} key={player.user_id}><div className="arena-player-line"><span className={`arena-player-avatar ${rank === 1 ? 'winner' : ''}`}>{rank === 1 ? <Trophy size={18} /> : rank ?? player.nickname.slice(0, 1).toUpperCase()}</span><span className="arena-player-name"><strong>{player.nickname}{player.user_id === userId && <small>you</small>}</strong><span>{room.status === 'lobby' ? player.ready ? 'Ready to go' : 'Getting settled' : finished ? `Finished in ${time(player.elapsed_ms ?? 0)}` : countdown ? 'Starting together' : `${percent}% filled`}{player.user_id === room.host_id && <span className="arena-host-label"> · host</span>}</span></span>{room.status === 'lobby' ? player.ready ? <Check className="arena-ready-check" size={18} /> : online === false ? <span className="arena-away">away</span> : null : finished ? <span className="arena-rank">#{rank}</span> : online === false ? <span className="arena-away">away</span> : null}</div>{room.status !== 'lobby' && !countdown && <div className="progress-track" role="progressbar" aria-label={`${player.nickname} progress`} aria-valuenow={finished ? 100 : percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${finished ? 100 : percent}%` }} /></div>}</div>;
      })}</div><div className="arena-fair-play"><Flag size={17} /><p>Same puzzle. Shared start.<br /><span>Notes and undo are allowed. The clock keeps running until your valid finish reaches the server.</span></p></div><button className="arena-leave" disabled={leaving || actionBusy || submitBusy} onClick={onLeave}><LogOut size={15} />{leaving ? 'Leaving…' : 'Leave room'}</button></aside>
    </div>
  </main>;
}
