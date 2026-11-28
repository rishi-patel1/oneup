import { Check, CheckCheck, Clock3, Grid2X2, Lightbulb, Pause, Pencil, Play, Undo2 } from 'lucide-react';
import type { Puzzle } from '../game/engine';
import type { GeneratedPuzzle } from '../game/generator';
import type { Session } from '../game/session';
import './learn.css';

interface LearnPageProps {
  library: { puzzle: Puzzle; saved: Session | null }[];
  currentPuzzleId?: string;
  generatedPuzzle?: GeneratedPuzzle | null;
  onSelectPuzzle: (puzzle: Puzzle) => void;
  onPlay: () => void;
}

export default function LearnPage({ library, currentPuzzleId, generatedPuzzle, onSelectPuzzle, onPlay }: LearnPageProps) {
  const completed = library.filter(({ saved }) => saved?.status === 'completed').length;
  const rating = generatedPuzzle?.generation.rating;

  return <main className="learn-page">
    <section className="learn-intro" aria-labelledby="learn-title">
      <div><div className="eyebrow">A LITTLE LOGIC. A LITTLE PRACTICE.</div><h1 id="learn-title">Find your footing.</h1><p>Learn the rule, try a starter puzzle, and make a little space for discovery.</p></div>
      <button className="primary-button" onClick={onPlay}><Play size={17} />Back to Solo play</button>
    </section>

    <div className="learn-rule-layout">
      <section className="learn-rule-card" aria-labelledby="learn-rule-title">
        <div className="learn-section-icon"><Grid2X2 size={23} /></div>
        <div className="eyebrow">THE LITTLE RULE</div><h2 id="learn-rule-title">Count the spaces.<br />Find the numbers.</h2>
        <p>Between two thick walls, use every number from <strong>1 to the number of spaces</strong>, exactly once. That stretch of cells is a segment.</p>
        <div className="learn-examples">
          <figure><div className="learn-run learn-single" role="img" aria-label="A one-cell segment must contain one"><span>1</span></div><figcaption>One space. Only 1.</figcaption></figure>
          <figure><div className="learn-run" role="img" aria-label="A three-cell segment contains two, one, and three"><span>2</span><span>1</span><span>3</span></div><figcaption>Three spaces. 1, 2, 3 in any order.</figcaption></figure>
        </div>
        <p>The same rule works <strong>across and down</strong>. A thick wall starts a new segment, so a number can appear again on the other side.</p>
      </section>

      <section className="learn-tips-card" aria-labelledby="learn-tips-title">
        <div className="eyebrow">A GOOD PLACE TO BEGIN</div><h2 id="learn-tips-title">Let the walls guide you.</h2>
        <div className="learn-tip"><Lightbulb size={20} /><div><h3>Start small.</h3><p>Look for short segments first. A single cell between walls must be 1.</p></div></div>
        <div className="learn-tip"><Grid2X2 size={20} /><div><h3>Look both ways.</h3><p>Every cell belongs to an across segment and a down segment. Its number must fit both.</p></div></div>
        <div className="learn-tip"><span className="learn-fixed-clue" aria-hidden="true">1</span><div><h3>Keep the clues.</h3><p>Underlined numbers are fixed clues. Use them to narrow down the empty cells.</p></div></div>
        <div className="learn-tip"><Pencil size={20} /><div><h3>Leave room for possibilities.</h3><p>Pencil notes help you keep track until only one number fits.</p></div></div>
      </section>
    </div>

    <section className="learn-collection" aria-labelledby="learn-collection-title">
      <div className="learn-section-heading"><div><div className="eyebrow">THE STARTER COLLECTION</div><h2 id="learn-collection-title">A good place to practice.</h2><p>Six little challenges. A bit more possibility in each.</p></div><span className="learn-completed"><Check size={17} />{completed} of {library.length} completed</span></div>
      <div className="learn-puzzle-list">
        {library.map(({ puzzle, saved }) => {
          const solved = saved?.status === 'completed';
          const inProgress = !solved && Boolean(saved && (saved.elapsedMs > 0 || saved.values.some((value, index) => value && !puzzle.givens[index]) || saved.notes.some(notes => notes.length)));
          const action = solved ? 'View puzzle' : inProgress ? 'Continue puzzle' : 'Try this puzzle';
          return <button className="learn-puzzle-card" key={puzzle.id} onClick={() => onSelectPuzzle(puzzle)} aria-label={`${action}: ${puzzle.title}, ${puzzle.size} by ${puzzle.size}, ${puzzle.difficulty}`}>
            <span className="learn-puzzle-meta"><span>{puzzle.size} × {puzzle.size}</span><span className={`difficulty difficulty-${puzzle.difficulty.toLowerCase()}`}>{puzzle.difficulty}</span></span>
            <h3>{puzzle.title}</h3><p>{puzzle.description}</p>
            <span className="learn-puzzle-footer"><span>{solved ? <><Check size={15} />Completed</> : inProgress ? <><Clock3 size={15} />In progress</> : puzzle.id === currentPuzzleId ? 'Selected puzzle' : 'Ready when you are'}</span><strong>{action}</strong></span>
          </button>;
        })}
      </div>
      <p className="learn-local-note">Starter progress is saved on this device. Open a puzzle to play it in Solo.</p>
    </section>

    {generatedPuzzle && rating && <section className="learn-puzzle-insight" aria-labelledby="learn-insight-title">
      <Lightbulb size={23} />
      <div><div className="eyebrow">YOUR CURRENT PUZZLE</div><h2 id="learn-insight-title">A little insight for your next move.</h2><p className="learn-insight-meta">{generatedPuzzle.size} × {generatedPuzzle.size}<span>·</span>Difficulty estimate: <strong>{rating.difficulty}</strong></p><p>{rating.guesses ? 'This solver needed branching after its logical deductions.' : rating.nakedPairs ? 'Solving needs pairs as well as single placements.' : rating.hiddenSingles ? 'Look for numbers with only one possible home in a segment.' : 'Direct placements can lead you all the way through.'}</p></div>
    </section>}

    <section className="learn-controls" aria-labelledby="learn-controls-title">
      <div className="learn-section-heading"><div><div className="eyebrow">MAKE YOURSELF AT HOME</div><h2 id="learn-controls-title">A few handy controls.</h2><p>Arrow keys wrap at board edges and skip fixed clues. Use the on-screen buttons or keep your hands on the keyboard.</p></div></div>
      <div className="learn-controls-grid">
        <dl className="learn-shortcuts"><div><dt>Move between cells</dt><dd><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd></dd></div><div><dt>Place a number</dt><dd><kbd>1–8</kbd><span>up to the board size</span></dd></div><div><dt>Add or remove a note</dt><dd><kbd>Shift</kbd><span>+</span><kbd>number</kbd></dd></div><div><dt>Switch notes mode</dt><dd><kbd>N</kbd></dd></div><div><dt>Clear a cell</dt><dd><kbd>Backspace</kbd><span>or</span><kbd>Delete</kbd></dd></div><div><dt>Undo / redo</dt><dd><kbd>⌘ / Ctrl Z</kbd><span>add Shift to redo</span></dd></div></dl>
        <div className="learn-assistance"><div className="learn-tip"><Lightbulb size={20} /><div><h3>A little nudge.</h3><p>In Solo, <strong>Hint</strong> fills one cell when you need a hand.</p></div></div><div className="learn-tip"><CheckCheck size={20} /><div><h3>Check the visible rules.</h3><p><strong>Check</strong> crosses repeated numbers and numbers outside a segment’s allowed range. Legal guesses stay unmarked.</p></div></div><div className="learn-tip"><Pause size={20} /><div><h3>Take your time.</h3><p>The Solo clock starts on your first entry. <strong>Pause</strong> hides the board and stops the clock. Leaving Solo or switching browser tabs pauses it too.</p></div></div><div className="learn-tip"><Undo2 size={20} /><div><h3>Try another possibility.</h3><p><strong>Undo</strong> and <strong>Redo</strong> let you revisit your entries and notes.</p></div></div></div>
      </div>
    </section>
  </main>;
}
