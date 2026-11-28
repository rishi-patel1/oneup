import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, ChevronDown, Clock3, Copy, Eraser, Flag, LoaderCircle, Pause, Pencil, Play, Redo2, RefreshCw, Sparkles, Trophy, Undo2, UserPlus, Users, X } from 'lucide-react';
import { APP_NAME } from '../branding';
import BrandMark from './BrandMark';
import AccountButton from './AccountButton';
import DailyStreaks from './DailyStreaks';
import { useAccount } from '../account/AccountProvider';
import type { Puzzle } from '../game/engine';
import { getMistakes, getSegments, isSolved } from '../game/engine';
import { isArrowKey, nextEditableCell } from '../game/board-navigation';
import { createSession, restoreSession, serializeSession, sessionReducer, type Session, type SessionAction } from '../game/session';
import { cancelFriendRequest, explainDailyError, getDailyLeaderboard, getDailyState, getFriends, removeFriend, requestFriend, respondFriend, saveDaily, setDailyPaused, startDaily, submitDaily, updateProfile, type DailyLeaderboard, type DailyState, type FriendsState, type LeaderboardEntry, type Profile } from '../daily/api';
import { getDailyElapsed, isCurrentDailySnapshot } from '../daily/model';
import './daily.css';

type Scope = 'global' | 'friends';
function time(ms: number, precise = false) {
  const value = Math.max(0, Math.floor(ms));
  const seconds = Math.floor(value / 1000);
  const basic = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return precise ? `${basic}.${String(value % 1000).padStart(3, '0')}` : basic;
}
function countdown(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 3600)).padStart(2, '0')}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function resetTimeLabel(timestamp: string) {
  return `${new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(timestamp))} IST`;
}
function dayLabel(date: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}
function read(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function forget(key: string) { try { localStorage.removeItem(key); } catch { /* Optional browser cache. */ } }
function cache(key: string, value: string) { try { localStorage.setItem(key, value); return true; } catch { return false; } }

export default function DailyPage({ onSolo, onCompete, onLearn }: { onSolo: () => void; onCompete: () => void; onLearn: () => void }) {
  const account = useAccount();
  const [state, setState] = useState<DailyState | null>(null);
  const resetLabel = state ? resetTimeLabel(state.resets_at) : '9:30 AM IST';
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [rollover, setRollover] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [offset, setOffset] = useState(0);
  const [scope, setScope] = useState<Scope>('global');
  const [leaderboardRevision, setLeaderboardRevision] = useState(0);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const mounted = useRef(true);
  const requestVersion = useRef(0);
  const stateRef = useRef<DailyState | null>(state);
  stateRef.current = state;
  const lastServerTime = useRef(0);
  const refreshRef = useRef<() => void>(() => {});

  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; requestVersion.current++; }; }, []);
  const accept = useCallback((next: DailyState) => {
    if (!mounted.current) return;
    const previous = stateRef.current;
    const serverTime = Date.parse(next.server_now);
    if (!isCurrentDailySnapshot(previous, next, lastServerTime.current)) return;
    if (previous?.attempt?.finished_at !== next.attempt?.finished_at || previous?.date !== next.date) setLeaderboardRevision(value => value + 1);
    lastServerTime.current = serverTime;
    stateRef.current = next;
    setState(next); setOffset(serverTime - Date.now()); setNow(Date.now()); setError('');
    // Every accepted snapshot has a live server deadline. A schedule change
    // can extend that deadline without changing the puzzle's date key.
    setRollover(false);
  }, []);

  useEffect(() => {
    if (account.loading) return;
    const version = ++requestVersion.current;
    let stopped = false, inFlight = false, lastPoll = 0;
    let pending: AbortController | null = null;
    const refresh = async (initial = false) => {
      if (stopped || inFlight) return;
      inFlight = true; lastPoll = Date.now();
      const controller = new AbortController(); pending = controller;
      if (initial) setLoading(true);
      try { const next = await getDailyState(controller.signal); if (!stopped && version === requestVersion.current) accept(next); }
      catch (cause) { if (!stopped && version === requestVersion.current) setError(explainDailyError(cause)); }
      finally { inFlight = false; if (pending === controller) pending = null; if (!stopped && version === requestVersion.current) setLoading(false); }
    };
    refreshRef.current = () => { void refresh(); };
    void refresh(true);
    const poll = window.setInterval(() => { if ((stateRef.current?.attempt && !stateRef.current.attempt.finished_at) || Date.now() - lastPoll >= 15_000) void refresh(); }, 3000);
    return () => { stopped = true; pending?.abort(); window.clearInterval(poll); refreshRef.current = () => {}; };
  }, [account.loading, account.user?.id, account.isGoogle, accept]);

  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(timer); }, []);
  const serverNow = now + offset;
  const expired = state !== null && serverNow >= Date.parse(state.resets_at);
  useEffect(() => {
    if (!expired) return;
    setRollover(true);
    refreshRef.current();
    const timer = window.setInterval(() => refreshRef.current(), 3000);
    return () => window.clearInterval(timer);
  }, [expired, state?.date]);

  const begin = async () => {
    if (starting || account.busy || account.loading || !state || expired) return;
    const date = state.date;
    setStarting(true); setError('');
    try { const next = await startDaily(); if (mounted.current && next.date >= date) accept(next); }
    catch (cause) { if (mounted.current) setError(explainDailyError(cause)); }
    finally { if (mounted.current) setStarting(false); }
  };
  const signIn = async () => {
    setError('');
    try { await account.signInGoogle(); }
    catch { if (mounted.current) setError('Google sign-in couldn’t start. Please try again from your account menu.'); }
  };
  const profileChanged = (profile: Profile) => {
    setState(current => current ? { ...current, profile } : current);
    setLeaderboardRevision(value => value + 1);
  };

  return <div className="app-shell daily-shell">
    <header className="site-header daily-header with-account"><a className="brand" href="#" aria-label={`${APP_NAME} solo play`} onClick={event => { event.preventDefault(); onSolo(); }}><span className="brand-mark"><BrandMark /></span><span>{APP_NAME}<span className="brand-period">.</span></span></a><nav aria-label="Main navigation"><button className="nav-link" onClick={onSolo}>Solo play</button><button className="nav-link active" aria-current="page">Daily</button><button className="nav-link" onClick={onCompete}>Compete</button><button className="nav-link" onClick={onLearn}>Learn</button></nav><AccountButton /></header>
    <main className="daily-main">
      <section className="daily-intro"><div><div className="eyebrow"><CalendarDays size={13} /> THE DAILY MOMENT{state && <span> · {dayLabel(state.date)}</span>}</div><h1>A fresh day.<em> A shared puzzle.</em></h1><p>The same 6 × 6 challenge for everyone. Find your own way through.</p></div>{state && <div className="daily-reset"><span>Next puzzle in</span><strong>{countdown(Date.parse(state.resets_at) - serverNow)}</strong><small>Resets at {resetLabel}</small></div>}</section>
      {error && <div className="daily-error daily-page-error" role="alert"><span>{error}</span><button className="secondary-button" onClick={() => refreshRef.current()}><RefreshCw size={15} /> Retry</button></div>}
      <div className="daily-layout">
        <section className="daily-play-panel" aria-label="Daily puzzle">
          {(loading || account.loading) && !state ? <div className="daily-waiting" role="status"><LoaderCircle className="spin" size={33} /><h2>Finding today’s little challenge.</h2><p>One fresh grid, shared with everyone.</p></div>
            : expired || rollover ? <div className="daily-waiting" role="status"><CalendarDays size={34} /><h2>A fresh day is arriving.</h2><p>Closing the previous grid and checking today’s challenge.</p><button className="secondary-button" onClick={() => refreshRef.current()}>Check for today’s puzzle</button></div>
              : state?.attempt && state.puzzle ? <DailyGame key={`${state.date}:${state.attempt.id}`} state={state} serverNow={serverNow} expired={expired} isGoogle={account.isGoogle} onSnapshot={accept} onRefresh={() => refreshRef.current()} onFriends={() => setScope('friends')} onSignIn={() => { void signIn(); }} />
                : state?.attempt ? <div className="daily-waiting" role="status"><LoaderCircle className="spin" size={33} /><h2>Opening your daily grid.</h2><p>Your clock is running. We’re reconnecting to your saved attempt.</p><button className="secondary-button" onClick={() => refreshRef.current()}>Reconnect</button></div>
                  : <div className="daily-start"><span className="daily-large-icon"><CalendarDays size={34} /></span><div className="eyebrow">ONE GRID. ONE DAY.</div><h2>Today’s moment is waiting.</h2><p>A 6 × 6 Medium puzzle, made fresh for everyone. Your official clock starts when you begin.</p><div className="daily-start-rules"><span><Check size={16} /> Notes and undo are welcome</span><span><Clock3 size={16} /> Finish before {resetLabel}</span><span><Pause size={16} /> Pause when you need a break</span></div>{account.isGoogle ? <><span className="daily-mode-pill ranked"><Trophy size={14} /> Ranked daily</span><button className="primary-button daily-begin" disabled={starting || account.busy || account.loading || !state?.daily || loading} onClick={() => { void begin(); }}>{starting ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}{starting ? 'Opening your challenge…' : 'Start today’s challenge'}</button><p className="daily-start-note">Your verified finish will appear on today’s rankings.</p></> : <><button className="primary-button daily-begin" disabled={starting || account.busy || account.loading} onClick={() => { void signIn(); }}>Sign in with Google for ranked play</button><button className="secondary-button daily-practice" disabled={starting || account.busy || account.loading || !state?.daily || loading} onClick={() => { void begin(); }}>{starting ? <LoaderCircle className="spin" size={16} /> : <CalendarDays size={16} />}{starting ? 'Opening your challenge…' : 'Start a practice attempt'}</button><p className="daily-start-note">Practice is unranked. Sign in before starting to enter the leaderboard; signing in later keeps today’s attempt as practice.</p></>}</div>}
        </section>
        <aside className="daily-sidebar"><DailyStreaks key={`${state?.date ?? 'loading'}:${account.user?.id ?? 'guest'}`} date={state?.date ?? null} completion={state?.attempt?.finished_at ?? null} isGoogle={account.isGoogle} onSignIn={() => { void signIn(); }} /><DailyRankings date={state?.date ?? null} scope={scope} onScope={setScope} isGoogle={account.isGoogle} ownId={account.user?.id ?? null} revision={leaderboardRevision} onSignIn={() => { void signIn(); }} /><section className="daily-friends-section"><button className="daily-friends-toggle" aria-expanded={friendsOpen} onClick={() => setFriendsOpen(value => !value)}><span><Users size={18} /> Friends & profile</span><ChevronDown size={17} className={friendsOpen ? 'is-open' : ''} /></button>{friendsOpen && (account.isGoogle ? <FriendsPanel initialProfile={state?.profile ?? null} onProfile={profileChanged} onFriendsChanged={() => setLeaderboardRevision(value => value + 1)} /> : <div className="daily-friends-signin"><p>Connect with friends and compare your daily finishes.</p><button className="secondary-button" onClick={() => { void signIn(); }}>Sign in with Google</button></div>)}</section><div className="daily-fair-play"><Flag size={17} /><p>A shared grid. Your own deductions.<span>Hints are unavailable. Segment conflicts are crossed automatically. Pauses stop the clock and hide the grid. Times are verified by the server.</span></p></div></aside>
      </div>
    </main><footer className="site-footer daily-footer"><span>A little clarity, every day.</span><span>New daily puzzle at {resetLabel}.</span></footer>
  </div>;
}

interface DailyGameProps {
  state: DailyState;
  serverNow: number;
  expired: boolean;
  isGoogle: boolean;
  onSnapshot: (next: DailyState) => void;
  onRefresh: () => void;
  onFriends: () => void;
  onSignIn: () => void;
}
function DailyGame({ state, serverNow, expired, isGoogle, onSnapshot, onRefresh, onFriends, onSignIn }: DailyGameProps) {
  const attempt = state.attempt!;
  const puzzle = useMemo<Puzzle>(() => ({ ...state.puzzle!, solution: [] }), [state.puzzle!.id]);
  const draftKey = `numora:daily:draft:${state.date}:${attempt.id}`;
  const [boot] = useState(() => {
    let session = restoreSession(puzzle, { ...createSession(puzzle), values: attempt.values, notes: attempt.notes }) ?? createSession(puzzle);
    let dirty = false;
    try { const draft = JSON.parse(read(draftKey) || 'null') as { session?: unknown; dirty?: boolean } | null; const restored = draft?.dirty ? restoreSession(puzzle, draft.session) : null; if (restored && !attempt.finished_at) { session = restored; dirty = true; } } catch { /* Use the server copy when a local draft is damaged. */ }
    if (attempt.finished_at) session.status = 'completed';
    return { session, dirty };
  });
  const [game, setGame] = useState(boot.session);
  const [selected, setSelected] = useState(() => { const first = boot.session.values.findIndex((value, index) => !value && !puzzle.givens[index]); return first >= 0 ? first : 0; });
  const [notesMode, setNotesMode] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'pending' | 'retrying'>(boot.dirty ? 'pending' : 'saved');
  const [draftAvailable, setDraftAvailable] = useState(true);
  const gameRef = useRef(game);
  const mounted = useRef(true);
  const dirty = useRef(boot.dirty);
  const revision = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const pauseRequest = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submittedSignature = useRef('');
  const boardRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ state, expired, onSnapshot }); latest.current = { state, expired, onSnapshot };
  const paused = attempt.paused_at !== null;
  const canPlay = !expired && !attempt.finished_at && !submitting && !paused && !pauseBusy;
  const effectiveNotes = notesMode || shiftHeld;
  const segments = useMemo(() => getSegments(puzzle), [puzzle]);
  const mistakes = useMemo(() => getMistakes(puzzle, game.values), [puzzle, game.values]);
  const peers = useMemo(() => new Set([...(segments.rows.find(run => run.includes(selected)) ?? []), ...(segments.columns.find(run => run.includes(selected)) ?? [])]), [segments, selected]);
  const elapsed = getDailyElapsed(attempt, serverNow);
  const persist = useCallback((session: Session, isDirty: boolean) => {
    if (isDirty) setDraftAvailable(cache(draftKey, JSON.stringify({ session: serializeSession(session), dirty: true })));
    else forget(draftKey);
  }, [draftKey]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; if (retryTimer.current) clearTimeout(retryTimer.current); }; }, []);
  useEffect(() => {
    if (!attempt.finished_at) return;
    const verified = restoreSession(puzzle, { ...createSession(puzzle), values: attempt.values, notes: attempt.notes }) ?? createSession(puzzle);
    const complete = { ...verified, status: 'completed' as const };
    gameRef.current = complete; setGame(complete); dirty.current = false; persist(complete, false); setSaveStatus('saved');
  }, [attempt.finished_at, puzzle, persist]);

  const flush = useCallback((beforePause = false): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const current = latest.current;
    if (!mounted.current || !dirty.current || current.expired || current.state.attempt?.finished_at || current.state.attempt?.paused_at || (pauseRequest.current && !beforePause)) return Promise.resolve();
    const sentRevision = revision.current, session = gameRef.current;
    const sentVersion = current.state.attempt!.timing_version;
    const pending = (async () => {
      let failed = false;
      try {
        const next = await saveDaily(state.date, session.values, session.notes, sentVersion);
        if (!mounted.current || latest.current.expired || next.date !== state.date) return;
        current.onSnapshot(next);
        if (revision.current === sentRevision) { dirty.current = false; setSaveStatus('saved'); persist(gameRef.current, false); }
      } catch { failed = true; if (mounted.current && !latest.current.expired) setSaveStatus('retrying'); }
      finally {
        inFlight.current = null;
        if (mounted.current && dirty.current && !latest.current.expired && !latest.current.state.attempt?.paused_at && !pauseRequest.current) retryTimer.current = setTimeout(() => { void flush(); }, failed ? 2000 : 200);
      }
    })();
    inFlight.current = pending;
    return pending;
  }, [state.date, persist]);
  useEffect(() => {
    if (!dirty.current || expired || paused || pauseBusy) return;
    const timer = setTimeout(() => { void flush(); }, 600);
    return () => clearTimeout(timer);
  }, [game.values, game.notes, expired, paused, pauseBusy, attempt.timing_version, flush]);

  const togglePause = async () => {
    if (pauseRequest.current || submitting || expired || attempt.finished_at) return;
    const desired = !paused, version = attempt.timing_version;
    pauseRequest.current = true; setPauseBusy(true); setShiftHeld(false); setError('');
    try {
      // Finish a pending save before changing the timer; local drafts survive failures.
      if (desired) await flush(true);
      if (!mounted.current || latest.current.expired || latest.current.state.attempt?.finished_at) return;
      const next = await setDailyPaused(state.date, attempt.id, desired, version);
      if (!mounted.current || latest.current.expired || next.date !== state.date) return;
      onSnapshot(next);
    } catch (cause) {
      if (mounted.current && !latest.current.expired) { setError(explainDailyError(cause)); onRefresh(); }
    } finally {
      pauseRequest.current = false;
      if (mounted.current) setPauseBusy(false);
    }
  };

  const edit = useCallback((action: SessionAction) => {
    if (!canPlay || pauseRequest.current) return;
    const next = sessionReducer(gameRef.current, action);
    if (next === gameRef.current) return;
    revision.current++; dirty.current = true; gameRef.current = next;
    setGame(next); setSaveStatus('pending'); setError(''); persist(next, true);
  }, [canPlay, persist]);
  const enter = useCallback((value: number, asNote = effectiveNotes) => {
    if (value > puzzle.size) return;
    edit({ type: asNote ? 'toggle-note' : 'set-value', index: selected, puzzle, value: !asNote && gameRef.current.values[selected] === value ? 0 : value });
  }, [puzzle, selected, effectiveNotes, edit]);
  useEffect(() => {
    const release = () => setShiftHeld(false);
    const keyUp = (event: KeyboardEvent) => setShiftHeld(event.shiftKey);
    const keyDown = (event: KeyboardEvent) => {
      setShiftHeld(event.shiftKey);
      const target = event.target as HTMLElement;
      if (!canPlay || event.isComposing || target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      if (event.ctrlKey || event.metaKey) { if (event.key.toLowerCase() === 'z') { event.preventDefault(); edit({ type: event.shiftKey ? 'redo' : 'undo' }); } return; }
      if (event.altKey) return;
      const shifted = event.shiftKey ? /^(?:Digit|Numpad)([1-8])$/.exec(event.code) : null;
      const value = shifted ? Number(shifted[1]) : /^[1-8]$/.test(event.key) ? Number(event.key) : null;
      if (value !== null) { event.preventDefault(); if (!event.repeat) enter(value, notesMode || event.shiftKey); }
      else if (['Backspace', 'Delete', '0'].includes(event.key)) { event.preventDefault(); edit({ type: 'clear-cell', index: selected, puzzle }); }
      else if (event.key.toLowerCase() === 'n') { event.preventDefault(); if (!event.repeat) setNotesMode(mode => !mode); }
      else if (isArrowKey(event.key)) {
        event.preventDefault();
        const next = nextEditableCell(puzzle, selected, event.key);
        setSelected(next); boardRef.current?.querySelector<HTMLButtonElement>(`[data-daily-cell="${next}"]`)?.focus();
      }
    };
    const visibility = () => { if (document.visibilityState === 'hidden') release(); };
    window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp); window.addEventListener('blur', release); document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', visibility); };
  }, [canPlay, puzzle, selected, notesMode, enter, edit]);
  const submit = useCallback(async () => {
    if (!canPlay || submitting || pauseRequest.current) return;
    const session = gameRef.current;
    submittedSignature.current = JSON.stringify(session.values); setSubmitting(true); setError('');
    try { const next = await submitDaily(state.date, session.values, session.notes, attempt.timing_version); if (!mounted.current || latest.current.expired || next.date !== state.date) return; dirty.current = false; setSaveStatus('saved'); onSnapshot(next); }
    catch (cause) { if (mounted.current && !latest.current.expired) setError(explainDailyError(cause)); }
    finally { if (mounted.current) setSubmitting(false); }
  }, [canPlay, submitting, state.date, attempt.timing_version, onSnapshot]);
  // A rejected pre-pause finish may be retried automatically after resuming.
  useEffect(() => { submittedSignature.current = ''; }, [attempt.timing_version]);
  useEffect(() => { if (!canPlay || !isSolved(puzzle, game.values) || submittedSignature.current === JSON.stringify(game.values)) return; void submit(); }, [game.values, puzzle, canPlay, submit]);

  return <div className="daily-game">
    <div className="daily-game-heading"><div><div className="eyebrow">{dayLabel(state.date)} · DAILY 6 × 6</div><h2>Your daily moment.</h2></div><div className="daily-time-controls"><div className="daily-timer" aria-label={paused ? "Paused daily timer" : "Daily timer"}><Clock3 size={17} /><span>{time(elapsed)}</span></div>{!attempt.finished_at && !paused && <button className="secondary-button daily-pause-button" disabled={pauseBusy || submitting || expired} onClick={() => { void togglePause(); }}>{pauseBusy ? <LoaderCircle className="spin" size={15} /> : <Pause size={15} />}{pauseBusy ? 'Pausing…' : 'Pause'}</button>}{paused && <span className="daily-paused-label">Paused</span>}</div></div>
    <div className={`daily-attempt-mode ${attempt.ranked ? 'ranked' : ''}`}><span className="daily-mode-pill"><Trophy size={13} />{attempt.ranked ? 'Ranked attempt' : 'Practice attempt'}</span>{!attempt.ranked && <p>{isGoogle ? 'Today stays unranked. Your next daily can be ranked.' : <>Sign in before starting a future daily to join the rankings. <button onClick={onSignIn}>Sign in with Google</button></>}</p>}</div>
    {paused ? <section className="daily-pause-panel" aria-label="Daily puzzle paused"><span className="daily-large-icon"><Pause size={31} /></span><h3>A little breathing room.</h3><p>Your clock is paused. Resume when you’re ready. Today’s puzzle still closes at {resetTimeLabel(state.resets_at)}.</p><button className="primary-button" disabled={pauseBusy || expired} onClick={() => { void togglePause(); }}>{pauseBusy ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}{pauseBusy ? 'Resuming…' : 'Resume daily puzzle'}</button></section> : <><div className={`puzzle-board daily-board ${attempt.finished_at ? 'is-solved' : ''}`} ref={boardRef} role="grid" aria-label="6 by 6 daily puzzle. Use arrows to move and numbers to enter." aria-rowcount={puzzle.size} aria-colcount={puzzle.size} style={{ '--size': puzzle.size } as React.CSSProperties}>{Array.from({ length: puzzle.size }, (_, row) => <div className="board-row" role="row" key={row}>{Array.from({ length: puzzle.size }, (_, column) => {
      const index = row * puzzle.size + column, value = game.values[index], given = Boolean(puzzle.givens[index]), wrong = mistakes.has(index);
      const across = segments.rows.find(run => run.includes(index))!, down = segments.columns.find(run => run.includes(index))!;
      return <button key={index} role="gridcell" data-daily-cell={index} aria-selected={selected === index} aria-readonly={given || Boolean(attempt.finished_at)} aria-invalid={wrong || undefined} aria-rowindex={row + 1} aria-colindex={column + 1} aria-label={`Row ${row + 1}, column ${column + 1}, ${value || 'empty'}${given ? ', fixed clue' : ''}${!value && game.notes[index].length ? `, notes ${game.notes[index].join(', ')}` : ''}${wrong ? ', rule conflict' : ''}. Across length ${across.length}, down length ${down.length}.`} tabIndex={selected === index ? 0 : -1} disabled={!canPlay} onClick={() => setSelected(index)} className={`cell ${given ? 'given' : ''} ${selected === index ? 'selected' : ''} ${peers.has(index) ? 'peer' : ''} ${wrong ? 'incorrect' : ''}`} style={{ borderRightWidth: column === puzzle.size - 1 ? 0 : puzzle.rightWalls[index] ? 3 : 1, borderBottomWidth: row === puzzle.size - 1 ? 0 : puzzle.bottomWalls[index] ? 3 : 1, borderRightColor: puzzle.rightWalls[index] ? 'var(--grid)' : 'var(--cell-line)', borderBottomColor: puzzle.bottomWalls[index] ? 'var(--grid)' : 'var(--cell-line)' }}>{value ? <span className="cell-value">{value}</span> : <span className="cell-notes" aria-hidden="true">{Array.from({ length: Math.max(6, puzzle.size) }, (_, n) => <span key={n}>{game.notes[index].includes(n + 1) ? n + 1 : ''}</span>)}</span>}{wrong && <svg className="cell-mistake-cross" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="M0 0 100 100M100 0 0 100" vectorEffect="non-scaling-stroke" /></svg>}</button>;
    })}</div>)}</div><div className="board-caption"><span><span className="clue-sample">1</span> Fixed clue</span><span>{attempt.ranked ? 'Your own deductions. Pauses stop the clock.' : 'Practice · no ranking'}</span></div>
    {attempt.finished_at ? <div className="daily-finish"><Trophy size={28} /><div><h3>A lovely moment of clarity.</h3><p>{attempt.ranked ? 'Official finish' : 'Practice finish'} <strong>{time(attempt.elapsed_ms ?? 0, true)}</strong></p><span>{attempt.ranked ? 'Your verified time is on today’s leaderboard.' : 'This practice time does not enter the rankings.'}</span>{attempt.ranked && <button className="text-button" onClick={onFriends}><Users size={14} /> See friends’ standings</button>}</div></div>
      : <><div className="number-pad" style={{ '--numbers': puzzle.size } as React.CSSProperties} aria-label="Daily number pad">{Array.from({ length: puzzle.size }, (_, n) => n + 1).map(value => <button key={value} className={effectiveNotes ? 'note-key' : ''} disabled={!canPlay || Boolean(puzzle.givens[selected])} aria-label={`${effectiveNotes ? 'Toggle note' : 'Enter'} ${value}`} onClick={event => enter(value, notesMode || event.shiftKey)}>{value}</button>)}</div><div className="game-tools daily-tools"><button disabled={!canPlay || !game.history.length} onClick={() => edit({ type: 'undo' })}><Undo2 size={19} /><span>Undo</span></button><button disabled={!canPlay || !game.future.length} onClick={() => edit({ type: 'redo' })}><Redo2 size={19} /><span>Redo</span></button><button disabled={!canPlay || Boolean(puzzle.givens[selected])} onClick={() => edit({ type: 'clear-cell', index: selected, puzzle })}><Eraser size={19} /><span>Erase</span></button><button disabled={!canPlay} aria-pressed={effectiveNotes} className={effectiveNotes ? 'tool-active' : ''} title="Pencil notes (N, or hold Shift)" onClick={() => setNotesMode(mode => !mode)}><Pencil size={19} /><span>Notes <small>{effectiveNotes ? 'ON' : 'OFF'}</small></span></button></div><button className="primary-button daily-submit" disabled={!canPlay || !game.values.every(Boolean)} onClick={() => { void submit(); }}>{submitting ? <LoaderCircle className="spin" size={16} /> : <Flag size={16} />}{submitting ? 'Verifying your finish…' : 'Submit today’s solution'}</button><div className="daily-save-status" role="status"><span>{saveStatus === 'saved' ? 'Progress synced with your daily attempt.' : saveStatus === 'pending' ? 'Saving your progress…' : draftAvailable ? 'Saved on this device. Retrying sync…' : 'Device storage and sync are unavailable. Keep this tab open.'}</span>{saveStatus === 'retrying' && <button disabled={Boolean(inFlight.current)} onClick={() => { void flush(); }}>Retry sync</button>}</div></>}
    </>}{error && <p className="daily-error" role="alert">{error}</p>}
  </div>;
}

interface RankingsProps { date: string | null; scope: Scope; onScope: (scope: Scope) => void; isGoogle: boolean; ownId: string | null; revision: number; onSignIn: () => void }
function DailyRankings({ date, scope, onScope, isGoogle, ownId, revision, onSignIn }: RankingsProps) {
  const [data, setData] = useState<DailyLeaderboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!date || (scope === 'friends' && !isGoogle)) { setLoading(false); return; }
    let stopped = false, inFlight = false;
    let pending: AbortController | null = null;
    const refresh = async () => {
      if (stopped || inFlight) return;
      inFlight = true; setLoading(true);
      const controller = new AbortController(); pending = controller;
      try { const next = await getDailyLeaderboard(date, scope, controller.signal); if (!stopped) { setData(next); setError(''); } }
      catch (cause) { if (!stopped) setError(explainDailyError(cause)); }
      finally { inFlight = false; if (pending === controller) pending = null; if (!stopped) setLoading(false); }
    };
    refreshRef.current = () => { void refresh(); };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => { stopped = true; pending?.abort(); window.clearInterval(timer); refreshRef.current = () => {}; };
  }, [date, scope, isGoogle, revision]);
  const current = data?.date === date && data.scope === scope ? data : null;
  const row = (entry: LeaderboardEntry, extra = false) => <div className={`daily-rank-row ${entry.user_id === ownId ? 'is-you' : ''} ${extra ? 'is-self-extra' : ''}`} key={entry.user_id}><span className={`daily-place ${entry.rank === 1 ? 'is-first' : ''}`}>{entry.rank === 1 ? <Trophy size={17} /> : entry.rank}</span><span className="daily-rank-name"><strong>{entry.display_name}{entry.user_id === ownId && <small>you</small>}</strong>{extra && <span>Your result</span>}</span><span className="daily-rank-time">{time(entry.elapsed_ms, true)}</span></div>;
  return <section className="daily-rankings" aria-label="Daily leaderboard"><div className="daily-section-heading"><div className="eyebrow">TODAY’S MOMENTS</div><button className="icon-button" disabled={!date || loading || (scope === 'friends' && !isGoogle)} aria-label="Refresh daily leaderboard" onClick={() => refreshRef.current()}><RefreshCw className={loading ? 'spin' : ''} size={16} /></button></div><h2>A little friendly perspective.</h2><div className="daily-ranking-tabs"><button aria-pressed={scope === 'global'} className={scope === 'global' ? 'selected' : ''} onClick={() => onScope('global')}>All players</button><button aria-pressed={scope === 'friends'} className={scope === 'friends' ? 'selected' : ''} onClick={() => onScope('friends')}>Friends</button></div>{scope === 'friends' && !isGoogle ? <div className="daily-ranking-empty"><Users size={28} /><p>See how your friends found their way through today’s grid.</p><button className="secondary-button" onClick={onSignIn}>Sign in with Google</button></div> : !current ? <div className="daily-ranking-empty" role="status">{loading ? <><LoaderCircle className="spin" size={25} /><p>Finding today’s finishes…</p></> : <><Trophy size={27} /><p>{error ? 'The rankings couldn’t load yet.' : 'Today’s results are taking shape.'}</p></>}</div> : <><div className="daily-rank-list">{current.entries.length ? current.entries.map(entry => row(entry)) : <div className="daily-ranking-empty"><Trophy size={27} /><p>{scope === 'friends' ? 'Your circle’s first finish is still to come.' : 'Today’s first ranked finish is still to come.'}</p></div>}{current.self && !current.entries.some(entry => entry.user_id === current.self!.user_id) && row(current.self, true)}</div><p className="daily-ranking-caption">{current.total ? `${current.total} ranked ${current.total === 1 ? 'finish' : 'finishes'}${current.total > 50 ? ' · top 50 shown' : ''}` : 'Ranked finishes appear here after server verification.'}</p></>}{error && !(scope === 'friends' && !isGoogle) && <div className="daily-ranking-error" role="status"><span>{error}</span><button disabled={loading} onClick={() => refreshRef.current()}>Retry</button></div>}</section>;
}

function FriendsPanel({ initialProfile, onProfile, onFriendsChanged }: { initialProfile: Profile | null; onProfile: (profile: Profile) => void; onFriendsChanged: () => void }) {
  const [data, setData] = useState<FriendsState | null>(null);
  const [name, setName] = useState(initialProfile?.display_name ?? '');
  const [friendCode, setFriendCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const version = useRef(0);
  const dataRef = useRef(data); dataRef.current = data;
  const nameEdited = useRef(false);
  const busyRef = useRef(busy); busyRef.current = busy;
  const friendsChangedRef = useRef(onFriendsChanged); friendsChangedRef.current = onFriendsChanged;
  const loadRef = useRef<() => void>(() => {});
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++; }; }, []);
  useEffect(() => {
    let stopped = false, inFlight = false;
    const load = async () => {
      if (stopped || inFlight || busyRef.current) return;
      inFlight = true; setLoading(true);
      const token = ++version.current;
      try { const next = await getFriends(); if (!stopped && token === version.current) { if (dataRef.current && JSON.stringify(dataRef.current.friends) !== JSON.stringify(next.friends)) friendsChangedRef.current(); dataRef.current = next; setData(next); if (!nameEdited.current) setName(next.profile.display_name); setError(''); } }
      catch (cause) { if (!stopped && token === version.current) setError(explainDailyError(cause)); }
      finally { inFlight = false; if (!stopped) setLoading(false); }
    };
    loadRef.current = () => { void load(); };
    void load();
    const poll = window.setInterval(() => { void load(); }, 25_000);
    return () => { stopped = true; window.clearInterval(poll); };
  }, []);
  const mutate = async (key: string, operation: () => Promise<FriendsState>, success: string) => {
    if (busy) return;
    const token = ++version.current;
    setBusy(key); setError(''); setNotice('');
    try { const next = await operation(); if (mounted.current && token === version.current) { setData(next); setNotice(success); onFriendsChanged(); if (key === 'request') setFriendCode(''); } }
    catch (cause) { if (mounted.current && token === version.current) setError(explainDailyError(cause)); }
    finally { if (mounted.current && token === version.current) setBusy(''); }
  };
  const saveName = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return;
    setBusy('profile'); setError(''); setNotice('');
    const token = ++version.current;
    try { const next = await updateProfile(name.trim()); if (mounted.current && token === version.current) { setData(current => current ? { ...current, profile: next } : current); setName(next.display_name); nameEdited.current = false; onProfile(next); setNotice('Your display name is saved.'); } }
    catch (cause) { if (mounted.current && token === version.current) setError(explainDailyError(cause)); }
    finally { if (mounted.current && token === version.current) setBusy(''); }
  };
  const copyCode = async () => {
    if (!data) return;
    try { await navigator.clipboard.writeText(data.profile.friend_code); setNotice('Friend code copied. Share it with someone you’d like to add.'); }
    catch { setNotice(`Your friend code is ${data.profile.friend_code}.`); }
  };
  return <div className="daily-friends-panel"><div className="daily-friends-refresh"><span>YOUR CIRCLE</span><button className="icon-button" disabled={loading || Boolean(busy)} aria-label="Refresh friends and requests" onClick={() => loadRef.current()}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div>{loading && !data ? <p className="daily-friends-loading" role="status"><LoaderCircle className="spin" size={18} /> Opening your circle…</p> : data ? <><form className="daily-profile-form" onSubmit={event => { void saveName(event); }}><label htmlFor="daily-profile-name">Leaderboard display name</label><div><input id="daily-profile-name" value={name} onChange={event => { nameEdited.current = true; setName(event.target.value); }} minLength={2} maxLength={24} required disabled={Boolean(busy)} /><button className="secondary-button" disabled={Boolean(busy) || name.trim() === data.profile.display_name}>{busy === 'profile' ? <LoaderCircle className="spin" size={15} /> : 'Save'}</button></div></form><div className="daily-friend-code"><span>Your friend code</span><div><strong>{data.profile.friend_code}</strong><button className="icon-button" aria-label="Copy friend code" onClick={() => { void copyCode(); }}><Copy size={16} /></button></div></div><form className="daily-add-friend" onSubmit={event => { event.preventDefault(); void mutate('request', () => requestFriend(friendCode), 'Friend request sent.'); }}><label htmlFor="daily-friend-code">Add a friend</label><div><input id="daily-friend-code" value={friendCode} onChange={event => setFriendCode(event.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="10-character code" minLength={10} maxLength={10} pattern="[A-Fa-f0-9]{10}" autoComplete="off" spellCheck={false} disabled={Boolean(busy)} required /><button className="secondary-button" disabled={Boolean(busy) || !friendCode.trim()} aria-label="Send friend request">{busy === 'request' ? <LoaderCircle className="spin" size={16} /> : <UserPlus size={16} />}</button></div><p>They’ll need to accept before you appear in each other’s friends rankings.</p></form>{data.incoming.length > 0 && <section className="daily-friend-list" aria-label="Incoming friend requests"><h3>Requests for you <span>{data.incoming.length}</span></h3>{data.incoming.map(request => <div className="daily-friend-row" key={request.id}><span><strong>{request.display_name}</strong><small>{request.friend_code}</small></span><div><button disabled={Boolean(busy)} onClick={() => { void mutate(request.id, () => respondFriend(request.id, true), 'Friend request accepted.'); }} aria-label={`Accept ${request.display_name}`}><Check size={16} /></button><button disabled={Boolean(busy)} onClick={() => { void mutate(request.id, () => respondFriend(request.id, false), 'Friend request declined.'); }} aria-label={`Decline ${request.display_name}`}><X size={16} /></button></div></div>)}</section>}<section className="daily-friend-list" aria-label="Friends"><h3>Your friends <span>{data.friends.length}</span></h3>{data.friends.length ? data.friends.map(friend => <div className="daily-friend-row" key={friend.user_id}><span><strong>{friend.display_name}</strong><small>{friend.friend_code}</small></span><button className="daily-friend-remove" disabled={Boolean(busy)} onClick={() => { void mutate(friend.user_id, () => removeFriend(friend.user_id), 'Friend removed from your circle.'); }} aria-label={`Remove ${friend.display_name}`}>Remove</button></div>) : <p className="daily-friends-empty">Share your code to start your circle.</p>}</section>{data.outgoing.length > 0 && <details className="daily-sent-requests"><summary>Sent requests <span>{data.outgoing.length}</span></summary>{data.outgoing.map(request => <div className="daily-friend-row" key={request.id}><span><strong>{request.display_name}</strong><small>Waiting for a reply</small></span><button className="daily-friend-remove" disabled={Boolean(busy)} onClick={() => { void mutate(request.id, () => cancelFriendRequest(request.id), 'Friend request cancelled.'); }}>Cancel</button></div>)}</details>}</> : null}{error && <div className="daily-friends-error" role="alert"><p>{error}</p>{!data && <button className="secondary-button" onClick={() => loadRef.current()}>Retry</button>}</div>}{notice && <p className="daily-friends-notice" role="status">{notice}</p>}</div>;
}
