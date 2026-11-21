import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, CheckCheck, ChevronDown,
  ChevronRight, CircleHelp, Clock3, Copy, Eraser, Grid2X2, Lightbulb, Moon,
  Pause, Pencil, Play, Redo2, RotateCcw, Sparkles, Sun, Trophy, Undo2, X,
} from 'lucide-react';
import { getMistakes, getSegments, isSolved } from './game/engine';
import { PUZZLES } from './game/puzzles';
import { createSession, restoreSession, serializeSession, sessionReducer } from './game/session';
import type { Puzzle } from './game/engine';
import type { Session, SessionAction } from './game/session';
import type { GeneratedPuzzle } from './game/generator';
import { addGeneratedPuzzle, formatPuzzleCode, persistGeneratedLibrary, readGeneratedPuzzles } from './game/generatedLibrary';
import NewPuzzleForm from './components/NewPuzzleForm';
import BrandMark from './components/BrandMark';
import { APP_NAME, STORAGE_PREFIX } from './branding';
import CompetitionPage from './components/CompetitionPage';
import DailyPage from './components/DailyPage';
import AccountButton from './components/AccountButton';
import { useAccount } from './account/AccountProvider';

const STORAGE = STORAGE_PREFIX;
type Preferences = { theme: 'light' | 'dark'; autoCheck: boolean; notesMode: boolean };
type Modal = 'help' | 'reset' | 'new' | null;

function readStorage(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(STORAGE + key) ?? 'null'); }
  catch { return null; }
}

function saveStorage(key: string, value: unknown) {
  try { localStorage.setItem(STORAGE + key, JSON.stringify(value)); return true; }
  catch { return false; }
}

function loadSession(puzzle: Puzzle) {
  return restoreSession(puzzle, readStorage(`puzzle:${puzzle.id}`)) ?? createSession(puzzle);
}

function initialPuzzle() {
  const id = readStorage('selected');
  return [...PUZZLES, ...readGeneratedPuzzles(readStorage('generated'))].find(p => p.id === id) ?? PUZZLES[0];
}

function initialPreferences(): Preferences {
  const stored = readStorage('preferences') as Partial<Preferences> | null;
  return {
    theme: stored?.theme === 'dark' ? 'dark' : 'light',
    autoCheck: stored?.autoCheck === true,
    notesMode: stored?.notesMode === true,
  };
}

function formatTime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function firstOpen(puzzle: Puzzle, values: number[]) {
  const index = values.findIndex((value, i) => !puzzle.givens[i] && !value);
  return index < 0 ? 0 : index;
}

export default function App() {
  const account = useAccount();
  const [view, setView] = useState<'solo' | 'compete' | 'daily'>(() => {
    const query = new URLSearchParams(window.location.search);
    return query.get('view') === 'daily' ? 'daily' : query.has('room') || query.get('view') === 'compete' ? 'compete' : 'solo';
  });
  const [puzzle, setPuzzle] = useState(initialPuzzle);
  const [session, setSession] = useState<Session>(() => loadSession(initialPuzzle()));
  const [selected, setSelected] = useState(() => firstOpen(puzzle, session.values));
  const [preferences, setPreferences] = useState(initialPreferences);
  const [generatedPuzzles, setGeneratedPuzzles] = useState(() => readGeneratedPuzzles(readStorage('generated')));
  const [generatedStorageAvailable, setGeneratedStorageAvailable] = useState(true);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [message, setMessage] = useState('');
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const boardRef = useRef<HTMLDivElement>(null);
  const collectionRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const resumeAfterDialog = useRef(false);
  const previousGeneratedIds = useRef(generatedPuzzles.map(p => p.id));
  const dispatch = useCallback((action: SessionAction) => setSession(s => sessionReducer(s, action)), []);

  const segments = useMemo(() => getSegments(puzzle), [puzzle]);
  const peers = useMemo(() => new Set([
    ...(segments.rows.find(row => row.includes(selected)) ?? []),
    ...(segments.columns.find(column => column.includes(selected)) ?? []),
  ]), [segments, selected]);
  const mistakes = useMemo(() => getMistakes(puzzle, session.values), [puzzle, session.values]);
  const filled = session.values.filter(Boolean).length;
  const editable = puzzle.givens.filter(v => !v).length;
  const entered = session.values.filter((value, i) => value && !puzzle.givens[i]).length;
  const progress = editable ? Math.round(entered / editable * 100) : 100;
  const isPlaying = session.status === 'playing' && view === 'solo';
  const notesMode = preferences.notesMode || shiftHeld;
  const hasStarted = session.elapsedMs > 0 || session.history.length > 0 || session.future.length > 0;
  const currentIndex = PUZZLES.findIndex(p => p.id === puzzle.id);
  const generated = 'generation' in puzzle ? puzzle as GeneratedPuzzle : null;
  const allStorageAvailable = storageAvailable && generatedStorageAvailable;
  const library = useMemo(() => PUZZLES.map(p => ({
    puzzle: p,
    saved: p.id === puzzle.id ? session : restoreSession(p, readStorage(`puzzle:${p.id}`)),
  })), [puzzle.id, session.status, session.values, libraryRevision]);
  const generatedLibrary = useMemo(() => generatedPuzzles.map(p => ({
    puzzle: p,
    saved: p.id === puzzle.id ? session : restoreSession(p, readStorage(`puzzle:${p.id}`)),
  })), [generatedPuzzles, puzzle.id, session.status, session.values, libraryRevision]);
  const completed = library.filter(p => p.saved?.status === 'completed').length;

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
    saveStorage('preferences', preferences);
  }, [preferences]);

  useEffect(() => {
    const updateShift = (event: KeyboardEvent) => setShiftHeld(event.shiftKey);
    const releaseShift = () => setShiftHeld(false);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') releaseShift();
    };
    window.addEventListener('keydown', updateShift);
    window.addEventListener('keyup', updateShift);
    window.addEventListener('blur', releaseShift);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', updateShift);
      window.removeEventListener('keyup', updateShift);
      window.removeEventListener('blur', releaseShift);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    try {
      setGeneratedStorageAvailable(persistGeneratedLibrary(localStorage, generatedPuzzles, previousGeneratedIds.current, STORAGE));
    } catch { setGeneratedStorageAvailable(false); }
    previousGeneratedIds.current = generatedPuzzles.map(p => p.id);
  }, [generatedPuzzles]);

  useEffect(() => {
    const ok = saveStorage(`puzzle:${puzzle.id}`, serializeSession(session));
    saveStorage('selected', puzzle.id);
    setStorageAvailable(ok);
  }, [session, puzzle.id]);

  useEffect(() => {
    if (!isPlaying || !hasStarted) return;
    let previous = performance.now();
    const tick = window.setInterval(() => {
      const now = performance.now();
      dispatch({ type: 'tick', deltaMs: now - previous });
      previous = now;
    }, 250);
    return () => window.clearInterval(tick);
  }, [isPlaying, hasStarted, puzzle.id, dispatch]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') dispatch({ type: 'pause' });
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [dispatch]);

  useEffect(() => {
    if (session.status === 'playing' && isSolved(puzzle, session.values)) {
      dispatch({ type: 'complete' });
      setMessage('Beautifully solved. Every segment is complete!');
    }
  }, [session.values, session.status, puzzle, dispatch]);

  useEffect(() => { setChecked(false); }, [session.values, puzzle.id]);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(''), 5000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useEffect(() => {
    if (modal) {
      lastFocused.current = document.activeElement as HTMLElement;
      resumeAfterDialog.current = session.status === 'playing';
      dispatch({ type: 'pause' });
      dialogRef.current?.showModal();
    } else if (dialogRef.current?.open) {
      dialogRef.current.close();
      if (resumeAfterDialog.current && document.visibilityState !== 'hidden') dispatch({ type: 'resume' });
      lastFocused.current?.focus();
    }
    // Only opening/closing the dialog controls its automatic pause.
  }, [modal]);

  useEffect(() => {
    if (!collectionOpen) return;
    const previousFocus = document.activeElement as HTMLElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const buttons = () => Array.from(collectionRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    buttons()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setCollectionOpen(false); }
      if (event.key !== 'Tab') return;
      const items = buttons();
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previousFocus.focus();
    };
  }, [collectionOpen]);

  const notify = useCallback((text: string) => setMessage(text), []);
  const setPreference = <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
    setPreferences(p => ({ ...p, [key]: value }));

  const selectPuzzle = (next: Puzzle) => {
    if (next.id !== puzzle.id) {
      const nextSession = loadSession(next);
      setSession(nextSession);
      setPuzzle(next);
      setSelected(firstOpen(next, nextSession.values));
      setLibraryRevision(r => r + 1);
      setMessage('');
    }
    setCollectionOpen(false);
  };

  const startGeneratedPuzzle = (next: GeneratedPuzzle) => {
    const recent = addGeneratedPuzzle(generatedPuzzles, next);
    setGeneratedPuzzles(recent);
    selectPuzzle(next);
    if (document.visibilityState === 'hidden') dispatch({ type: 'pause' });
    setModal(null);
    notify('A new puzzle, with exactly one solution. Make yourself at home.');
  };

  const copyPuzzleCode = async () => {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(formatPuzzleCode(generated));
      notify('Puzzle code copied. Paste it in New puzzle to recreate this board.');
    } catch { notify('Select the puzzle code below the grid, then copy it with ⌘/Ctrl C.'); }
  };

  const enterNumber = useCallback((value: number, asNote = notesMode) => {
    if (!isPlaying || puzzle.givens[selected]) return;
    if (value > puzzle.size) {
      notify(`This board uses numbers 1–${puzzle.size}.`);
      return;
    }
    if (asNote) dispatch({ type: 'toggle-note', puzzle, index: selected, value });
    else dispatch({ type: 'set-value', puzzle, index: selected, value: session.values[selected] === value ? 0 : value });
  }, [isPlaying, puzzle, selected, notesMode, session.values, dispatch, notify]);

  const hint = useCallback(() => {
    if (!isPlaying) return;
    let index = selected;
    if (puzzle.givens[index] || session.values[index] === puzzle.solution[index]) {
      index = session.values.findIndex((value, i) => !puzzle.givens[i] && value !== puzzle.solution[i]);
    }
    if (index < 0) return;
    dispatch({ type: 'hint', index, puzzle });
    setSelected(index);
    notify(`A little nudge: row ${Math.floor(index / puzzle.size) + 1}, column ${index % puzzle.size + 1} is ${puzzle.solution[index]}.`);
  }, [isPlaying, selected, puzzle, session.values, dispatch, notify]);

  const check = () => {
    if (!isPlaying) return;
    dispatch({ type: 'check' });
    setChecked(true);
    notify(mistakes.size
      ? `${mistakes.size} ${mistakes.size === 1 ? 'cell has' : 'cells have'} a rule conflict. They’re crossed on the board.`
      : `No rule conflicts found so far.${filled < puzzle.size ** 2 ? ' Keep exploring.' : ''}`);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (view !== 'solo' || modal || collectionOpen || event.isComposing) return;
      const target = event.target as HTMLElement;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable) return;
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === 'z') {
          event.preventDefault();
          dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
        }
        return;
      }
      if (event.altKey) return;
      // Shift changes top-row digits into symbols (for example, 1 becomes !).
      const shiftedDigit = event.shiftKey ? /^(?:Digit|Numpad)([1-8])$/.exec(event.code) : null;
      const digit = shiftedDigit ? Number(shiftedDigit[1]) : /^[1-8]$/.test(event.key) ? Number(event.key) : null;
      if (digit !== null) {
        event.preventDefault();
        if (!event.repeat) enterNumber(digit, preferences.notesMode || event.shiftKey);
      }
      else if (event.key === 'Backspace' || event.key === 'Delete' || event.key === '0') {
        event.preventDefault(); dispatch({ type: 'clear-cell', index: selected, puzzle });
      } else if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        if (!event.repeat) setPreferences(p => ({ ...p, notesMode: !p.notesMode }));
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && isPlaying) {
        event.preventDefault();
        const row = Math.floor(selected / puzzle.size), col = selected % puzzle.size;
        const next = event.key === 'ArrowLeft' ? row * puzzle.size + Math.max(0, col - 1)
          : event.key === 'ArrowRight' ? row * puzzle.size + Math.min(puzzle.size - 1, col + 1)
          : event.key === 'ArrowUp' ? Math.max(0, row - 1) * puzzle.size + col
          : Math.min(puzzle.size - 1, row + 1) * puzzle.size + col;
        setSelected(next);
        boardRef.current?.querySelector<HTMLButtonElement>(`[data-cell="${next}"]`)?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, modal, collectionOpen, dispatch, enterNumber, selected, puzzle, isPlaying, preferences.notesMode]);

  const reset = () => {
    dispatch({ type: 'reset', puzzle });
    setSelected(firstOpen(puzzle, puzzle.givens));
    setModal(null);
    notify('A fresh start. You’ve got this.');
  };

  const navigate = (next: 'solo' | 'compete' | 'daily') => {
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    if (next === 'solo') url.searchParams.delete('view');
    else url.searchParams.set('view', next);
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    if (next !== 'solo') dispatch({ type: 'pause' });
    setView(next);
  };
  const accountKey = account.user && !account.user.is_anonymous ? account.user.id : 'guest';
  if (view === 'daily') return <DailyPage key={accountKey} onSolo={() => navigate('solo')} onCompete={() => navigate('compete')} />;
  if (view === 'compete') return <CompetitionPage key={accountKey} onSolo={() => navigate('solo')} onDaily={() => navigate('daily')} />;

  return (
    <div className="app-shell">
      <header className="site-header with-account" inert={collectionOpen}>
        <a className="brand" href="#" aria-label={`${APP_NAME} home`} onClick={e => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
          <span className="brand-mark"><BrandMark /></span>
          <span>{APP_NAME}<span className="brand-period">.</span></span>
        </a>
        <nav aria-label="Main navigation">
          <button className="nav-link active" onClick={() => boardRef.current?.querySelector<HTMLButtonElement>(`[data-cell="${selected}"]`)?.focus()}>Solo</button>
          <button className="nav-link" onClick={() => navigate('daily')}>Daily</button>
          <button className="nav-link" onClick={() => navigate('compete')}>Compete</button>
          <button className="nav-link howto-nav" aria-label="How to play" onClick={() => setModal('help')}><CircleHelp className="nav-help-icon" size={20} /><span>How to play</span></button>
        </nav>
        <div className="header-actions">
          <AccountButton />
          <button className="icon-button theme-button" aria-label={`Switch to ${preferences.theme === 'light' ? 'dark' : 'light'} mode`} onClick={() => setPreference('theme', preferences.theme === 'light' ? 'dark' : 'light')}>
            {preferences.theme === 'light' ? <Moon size={19} /> : <Sun size={19} />}
          </button>
        </div>
      </header>

      <main>
        <section className="page-intro" aria-label="Welcome" inert={collectionOpen}>
          <div><div className="eyebrow"><span /> A LITTLE LOGIC. A LITTLE FOCUS.</div><h1>A moment of <em>clarity.</em></h1><p>Fill the spaces. Find your rhythm. One number at a time.</p></div>
          <div className="intro-actions"><button className="primary-button new-puzzle-launch" onClick={() => setModal('new')}><Sparkles size={17} /> New puzzle</button><div className="collection-count"><span className="count-icon"><Trophy size={22} /></span><div><strong>{completed}<span> / {PUZZLES.length}</span></strong><span>starter puzzles completed</span></div></div></div>
        </section>

        <div className="play-layout">
          <aside ref={collectionRef} className={`collection-panel ${collectionOpen ? 'is-open' : ''}`} aria-label="Puzzle collection" role={collectionOpen ? 'dialog' : undefined} aria-modal={collectionOpen || undefined}>
            <div className="collection-heading"><div className="eyebrow">THE COLLECTION</div><button className="icon-button mobile-close" aria-label="Close collection" onClick={() => setCollectionOpen(false)}><X size={20} /></button></div>
            <h2>A good place to start.</h2><p className="muted collection-description">Six little challenges.<br />A bit more possibility in each.</p>
            <div className="puzzle-list">
              {library.map(({ puzzle: item, saved }, index) => (
                <button key={item.id} className={`puzzle-item ${item.id === puzzle.id ? 'is-selected' : ''}`} onClick={() => selectPuzzle(item)} aria-current={item.id === puzzle.id ? 'true' : undefined}>
                  <span className={`puzzle-number ${saved?.status === 'completed' ? 'is-completed' : ''}`}>{saved?.status === 'completed' ? <Check size={18} /> : String(index + 1).padStart(2, '0')}</span>
                  <span className="puzzle-item-info"><strong>{item.title}</strong><span>{item.size} × {item.size}<span className="text-dot">·</span>{item.difficulty}</span></span>
                  {item.id === puzzle.id ? <span className="selected-dot" /> : saved && saved.values.some((v, i) => v && !item.givens[i]) && saved.status !== 'completed' ? <span className="in-progress-dot" title="In progress" /> : <ChevronRight size={15} className="puzzle-chevron" />}
                </button>
              ))}
            </div>
            {generatedLibrary.length > 0 && <section className="generated-collection" aria-label="Recent generated puzzles"><div className="eyebrow">YOUR RECENT PUZZLES</div><p>The last 12, saved on this device.</p><div className="generated-list">{generatedLibrary.map(({ puzzle: item, saved }) => <button key={item.id} className={`puzzle-item generated-item ${item.id === puzzle.id ? 'is-selected' : ''}`} onClick={() => selectPuzzle(item)} aria-current={item.id === puzzle.id ? 'true' : undefined} aria-label={`Generated ${item.size} by ${item.size} ${item.difficulty}, seed ${item.generation.seed}${saved?.status === 'completed' ? ', completed' : ''}`}><span className={`puzzle-number ${saved?.status === 'completed' ? 'is-completed' : ''}`}>{saved?.status === 'completed' ? <Check size={17} /> : <Sparkles size={16} />}</span><span className="puzzle-item-info"><strong>{item.size} × {item.size}<span className="text-dot">·</span>{item.difficulty}</strong><span title={item.generation.seed}>{item.generation.seed}</span></span>{item.id === puzzle.id && <span className="selected-dot" />}</button>)}</div></section>}
            <div className="collection-footnote"><Sparkles size={17} /><p>Made for the moment.<br /><span>No rush. Just you and the grid.</span></p></div>
          </aside>
          {collectionOpen && <button className="collection-backdrop" aria-label="Close collection" onClick={() => setCollectionOpen(false)} />}

          <section className="game-card" aria-label={`${puzzle.title} puzzle`} inert={collectionOpen}>
            <div className="game-heading">
              <div><button className="mobile-collection" onClick={() => setCollectionOpen(true)}>{generated ? 'Your puzzle' : `Puzzle ${String(currentIndex + 1).padStart(2, '0')}`} <ChevronDown size={14} /></button><div className="eyebrow desktop-puzzle-label">{generated ? 'YOUR GENERATED PUZZLE' : `PUZZLE ${String(currentIndex + 1).padStart(2, '0')}`}</div><h2>{puzzle.title}<span className={`difficulty difficulty-${puzzle.difficulty.toLowerCase()}`}>{puzzle.difficulty}</span></h2></div>
              <div className="timer"><Clock3 size={16} /><span aria-label={`Elapsed time ${formatTime(session.elapsedMs)}`}>{formatTime(session.elapsedMs)}</span><button className="icon-button pause-button" aria-label={session.status === 'paused' ? 'Resume puzzle' : 'Pause puzzle'} disabled={session.status === 'completed'} onClick={() => dispatch({ type: session.status === 'paused' ? 'resume' : 'pause' })}>{session.status === 'paused' ? <Play size={15} /> : <Pause size={15} />}</button></div>
            </div>

            <div className="board-wrap">
              <div ref={boardRef} className={`puzzle-board ${session.status === 'paused' ? 'is-paused' : ''} ${session.status === 'completed' ? 'is-solved' : ''}`} style={{ '--size': puzzle.size } as React.CSSProperties} role="grid" aria-label={`${puzzle.size} by ${puzzle.size} puzzle. Use arrow keys to move and number keys to enter.`} aria-rowcount={puzzle.size} aria-colcount={puzzle.size}>
                {Array.from({ length: puzzle.size }, (_, row) => (
                  <div role="row" className="board-row" key={row}>
                    {Array.from({ length: puzzle.size }, (_, col) => {
                      const index = row * puzzle.size + col;
                      const value = session.values[index];
                      const given = Boolean(puzzle.givens[index]);
                      const wrong = !given && (preferences.autoCheck || checked) && mistakes.has(index);
                      const across = segments.rows.find(run => run.includes(index))!;
                      const down = segments.columns.find(run => run.includes(index))!;
                      const segmentLabel = `Across segment: columns ${across[0] % puzzle.size + 1} to ${across[across.length - 1] % puzzle.size + 1}, use 1 through ${across.length}. Down segment: rows ${Math.floor(down[0] / puzzle.size) + 1} to ${Math.floor(down[down.length - 1] / puzzle.size) + 1}, use 1 through ${down.length}.`;
                      return <button key={index} role="gridcell" data-cell={index} aria-rowindex={row + 1} aria-colindex={col + 1} aria-selected={selected === index} aria-readonly={given} aria-invalid={wrong || undefined} aria-label={`Row ${row + 1}, column ${col + 1}, ${value || 'empty'}${given ? ', fixed clue' : ''}${session.notes[index].length && !value ? `, notes ${session.notes[index].join(', ')}` : ''}${wrong ? ', rule conflict' : ''}. ${segmentLabel}`} tabIndex={selected === index ? 0 : -1} disabled={session.status === 'paused'} onClick={() => setSelected(index)} className={`cell ${given ? 'given' : ''} ${peers.has(index) ? 'peer' : ''} ${selected === index ? 'selected' : ''} ${wrong ? 'incorrect' : ''} ${value && value === session.values[selected] ? 'same-value' : ''}`} style={{ borderRightWidth: col === puzzle.size - 1 ? 0 : puzzle.rightWalls[index] ? 3 : 1, borderBottomWidth: row === puzzle.size - 1 ? 0 : puzzle.bottomWalls[index] ? 3 : 1, borderRightColor: puzzle.rightWalls[index] ? 'var(--grid)' : 'var(--cell-line)', borderBottomColor: puzzle.bottomWalls[index] ? 'var(--grid)' : 'var(--cell-line)' }}>
                        {value ? <span className="cell-value">{value}</span> : <span className="cell-notes" aria-hidden="true">{Array.from({ length: Math.max(6, puzzle.size) }, (_, n) => <span key={n}>{session.notes[index].includes(n + 1) ? n + 1 : ''}</span>)}</span>}
                        {wrong && <svg className="cell-mistake-cross" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="M0 0 100 100M100 0 0 100" vectorEffect="non-scaling-stroke" /></svg>}
                      </button>;
                    })}
                  </div>
                ))}
              </div>
              {session.status === 'paused' && <div className="pause-overlay"><span className="pause-illustration"><Pause size={26} /></span><h3>A little breather.</h3><p>Your puzzle will be right here.</p><button className="primary-button" onClick={() => dispatch({ type: 'resume' })}><Play size={16} /> Back to the grid</button></div>}
            </div>

            <div className="board-caption"><span><span className="clue-sample">1</span> Fixed clue</span><span>{puzzle.size} × {puzzle.size} grid<span className="text-dot">·</span>One solution</span></div>
            {generated && <div className="generated-code"><label htmlFor="puzzle-code">Puzzle code</label><div><input id="puzzle-code" value={formatPuzzleCode(generated)} readOnly onFocus={event => event.currentTarget.select()} aria-label="Puzzle code" /><button className="icon-button" onClick={copyPuzzleCode} aria-label="Copy puzzle code" title="Copy puzzle code"><Copy size={16} /></button></div></div>}

            {session.status === 'completed' ? <div className="completion-panel"><div className="completion-title"><span><Trophy size={22} /></span><div><h3>A lovely bit of logic.</h3><p>Solved in {formatTime(session.elapsedMs)} · {session.hintsUsed} {session.hintsUsed === 1 ? 'hint' : 'hints'} · {session.checksUsed} {session.checksUsed === 1 ? 'check' : 'checks'}</p></div></div><button className="primary-button" onClick={() => generated ? setModal('new') : currentIndex < PUZZLES.length - 1 ? selectPuzzle(PUZZLES[currentIndex + 1]) : setModal('reset')}>{generated ? 'Create another puzzle' : currentIndex < PUZZLES.length - 1 ? 'Try the next puzzle' : 'Play this one again'}<ChevronRight size={17} /></button></div>
              : <>
                <div className="number-pad" style={{ '--numbers': puzzle.size } as React.CSSProperties} aria-label="Number pad">
                  {Array.from({ length: puzzle.size }, (_, i) => i + 1).map(n => <button key={n} onClick={event => enterNumber(n, preferences.notesMode || event.shiftKey)} disabled={!isPlaying || Boolean(puzzle.givens[selected])} className={notesMode ? 'note-key' : ''} aria-label={`${notesMode ? 'Toggle note' : 'Enter'} ${n}`}>{n}</button>)}
                </div>
                <div className="game-tools" aria-label="Puzzle tools">
                  <button disabled={!isPlaying || !session.history.length} title="Undo (⌘/Ctrl Z)" onClick={() => dispatch({ type: 'undo' })}><Undo2 size={19} /><span>Undo</span></button>
                  <button disabled={!isPlaying || !session.future.length} title="Redo (⌘/Ctrl Shift Z)" onClick={() => dispatch({ type: 'redo' })}><Redo2 size={19} /><span>Redo</span></button>
                  <button disabled={!isPlaying || Boolean(puzzle.givens[selected])} title="Erase (Backspace)" onClick={() => dispatch({ type: 'clear-cell', index: selected, puzzle })}><Eraser size={19} /><span>Erase</span></button>
                  <span className="tool-divider" />
                  <button disabled={!isPlaying} className={notesMode ? 'tool-active' : ''} aria-pressed={notesMode} title="Pencil notes (N, or hold Shift)" onClick={() => setPreference('notesMode', !preferences.notesMode)}><Pencil size={19} /><span>Notes <small>{notesMode ? 'ON' : 'OFF'}</small></span></button>
                  <button disabled={!isPlaying} onClick={hint}><Lightbulb size={19} /><span>Hint</span></button>
                  <button disabled={!isPlaying} onClick={check}><CheckCheck size={19} /><span>Check</span></button>
                </div>
              </>}
            <div className="game-bottom"><span className={allStorageAvailable ? '' : 'storage-warning'}><span className={`save-dot ${allStorageAvailable ? '' : 'warning'}`} />{allStorageAvailable ? 'Progress saved on this device' : 'Storage unavailable — keep this tab open'}</span><button onClick={() => setModal('reset')}><RotateCcw size={13} /> Restart</button></div>
          </section>

          <aside className="info-column" inert={collectionOpen}>
            <section className="session-card">
              <div className="eyebrow">ONE CELL AT A TIME</div><h2>{session.status === 'completed' ? 'Nicely done.' : 'You’re making space.'}</h2><p>{puzzle.description}</p>
              <div className="progress-label"><span>Your progress</span><strong>{progress}%</strong></div><div className="progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Puzzle progress"><span style={{ width: `${progress}%` }} /></div><p className="progress-detail">{entered} of {editable} empty cells filled</p>
              <div className="session-divider" />
              <label className="switch-label"><span><strong>Show mistakes</strong><span>Repeats and segment limits</span></span><input type="checkbox" checked={preferences.autoCheck} onChange={e => setPreference('autoCheck', e.target.checked)} /><span className="switch" aria-hidden="true" /></label>
              {generated && <div className="generated-rating"><span className="eyebrow">DIFFICULTY ESTIMATE</span><strong>{generated.generation.rating.difficulty}</strong><p>{generated.generation.rating.guesses ? 'This solver needed branching after its logical deductions.' : generated.generation.rating.nakedPairs ? 'Solving needs pairs as well as single placements.' : generated.generation.rating.hiddenSingles ? 'Look for numbers with only one possible home in a segment.' : 'Direct placements can lead you all the way through.'}</p></div>}
            </section>

            <section className="rules-card"><div className="rules-card-heading"><span className="rules-icon"><Lightbulb size={18} /></span><h2>The little rule.</h2></div><p>Between two thick walls, use every number from <strong>1 to the number of spaces.</strong></p><div className="rule-example" aria-label="A three-cell segment contains one, two, and three in any order"><span>2</span><span>1</span><span>3</span></div><p className="rule-example-caption">3 spaces. 1, 2, 3. Any order.</p><p>It works <strong>across and down.</strong><br />No repeats in a segment.</p><button className="text-button" onClick={() => setModal('help')}>Show me how <CircleHelp size={14} /></button></section>

            <div className="keyboard-hint"><span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> to move</span><span><kbd>1–{puzzle.size}</kbd> to fill <span className="keyboard-separator">/</span> <kbd>N</kbd> or <kbd>Shift</kbd> for notes</span></div>
          </aside>
        </div>
      </main>

      <footer className="site-footer" inert={collectionOpen}><span>Small grids. Good headspace.</span><span>Inspired by One Up, created by Rodolfo Kurchan.<span className="footer-separator">·</span><a href="https://oneuppuzzle.com/" target="_blank" rel="noreferrer">The original game</a></span></footer>

      <div className={`toast ${message ? 'show' : ''}`} role="status" aria-live="polite">{message && <><span className="toast-icon"><Lightbulb size={17} /></span><span>{message}</span><button aria-label="Dismiss message" onClick={() => setMessage('')}><X size={16} /></button></>}</div>

      <dialog ref={dialogRef} className="modal" aria-label={modal === 'new' ? 'New puzzle' : modal === 'reset' ? 'Restart puzzle' : `How to play ${APP_NAME}`} onCancel={() => setModal(null)} onClick={e => { if (e.target === e.currentTarget) setModal(null); }}>
        <div className="modal-inner"><button className="icon-button modal-close" aria-label="Close dialog" onClick={() => setModal(null)}><X size={21} /></button>
          {modal === 'new' ? <NewPuzzleForm initialSize={puzzle.size} initialDifficulty={puzzle.difficulty} onGenerated={startGeneratedPuzzle} onCancel={() => setModal(null)} /> : modal === 'reset' ? <><span className="modal-symbol"><RotateCcw size={26} /></span><div className="eyebrow">A CLEAN SLATE</div><h2>Start this one again?</h2><p>This clears your entries, notes, and time for <strong>{puzzle.title}</strong>. Your other puzzles stay saved.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setModal(null)}>Keep playing</button><button className="primary-button" onClick={reset}>Restart puzzle</button></div></>
            : <><span className="modal-symbol"><Grid2X2 size={27} /></span><div className="eyebrow">SIMPLE RULES. HAPPY BRAIN.</div><h2>A little guide to {APP_NAME}.</h2><p>Fill every cell. Each horizontal and vertical segment between thick walls must contain every number from <strong>1 through its length</strong>, exactly once.</p><div className="help-examples"><div><div className="rule-example single"><span>1</span></div><span>One space</span></div><div><div className="rule-example"><span>2</span><span>1</span><span>3</span></div><span>Three spaces</span></div></div><p>Every cell belongs to an across segment <em>and</em> a down segment. Its number must work in both. Underlined numbers are fixed clues.</p><div className="help-shortcuts"><h3>Make yourself at home.</h3><p><Pencil size={17} /><span><strong>Notes</strong> let you pencil in possibilities. Tap N to switch, or hold Shift while pressing a number to add or remove a note.</span></p><p><Lightbulb size={17} /><span><strong>Hint</strong> fills one cell. <strong>Check</strong> marks repeated numbers and numbers that don’t fit their segment. Legal guesses stay unmarked.</span></p><p><Pause size={17} /><span>The clock starts on your first entry. <strong>Pause</strong> hides the board and stops the clock. Switching tabs pauses too.</span></p><p><span className="arrow-icons"><ArrowLeft size={12} /><ArrowUp size={12} /><ArrowDown size={12} /><ArrowRight size={12} /></span><span><strong>Arrow keys</strong> move. Numbers fill. Backspace clears. ⌘/Ctrl Z undoes.</span></p></div><button className="primary-button full-width" onClick={() => setModal(null)}>Got it. Let’s play.</button></>}
        </div>
      </dialog>
    </div>
  );
}
