import { useLayoutEffect, useRef, useState } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import type { Difficulty } from '../game/engine';
import { normalizeSeed, type GeneratedPuzzle, type GenerationOptions } from '../game/generator';
import { isPuzzleCode, parsePuzzleCode, randomSeed, readGeneratedPuzzles } from '../game/generatedLibrary';
import type { GenerationRequest, GenerationResponse } from '../game/generationProtocol';

interface Props {
  initialSize: number;
  initialDifficulty: Difficulty;
  onGenerated: (puzzle: GeneratedPuzzle) => void;
  onCancel?: () => void;
  variant?: 'dialog' | 'inline';
}

const LEVELS: { value: Difficulty; description: string }[] = [
  { value: 'Easy', description: 'Find your rhythm' },
  { value: 'Medium', description: 'Connect the clues' },
  { value: 'Hard', description: 'Go a little deeper' },
];

export default function NewPuzzleForm({ initialSize, initialDifficulty, onGenerated, onCancel, variant = 'dialog' }: Props) {
  const [size, setSize] = useState(initialSize as GenerationOptions['size']);
  const [difficulty, setDifficulty] = useState(initialDifficulty);
  const [seed, setSeed] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const worker = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopWorker = () => {
    worker.current?.terminate();
    worker.current = null;
    if (deadline.current) clearTimeout(deadline.current);
    deadline.current = null;
  };

  useLayoutEffect(() => () => { requestId.current++; stopWorker(); }, []);

  const cancel = () => {
    requestId.current++;
    stopWorker();
    setGenerating(false);
    onCancel?.();
  };

  const generate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (generating) return;
    setError('');
    let options: GenerationOptions;
    try {
      const text = seed.trim();
      if (isPuzzleCode(text)) {
        const parsed = parsePuzzleCode(text);
        if (!parsed) throw new Error('That puzzle code is invalid or uses a different generator version.');
        options = parsed;
        setSize(options.size);
        setDifficulty(options.difficulty);
      } else {
        options = { size, difficulty, seed: text ? normalizeSeed(text) : randomSeed() };
        if (text) setSeed(options.seed);
      }
      stopWorker();
      const id = ++requestId.current;
      const task = new Worker(new URL('../game/generator.worker.ts', import.meta.url), { type: 'module' });
      worker.current = task;
      setGenerating(true);
      const fail = (message: string) => {
        if (requestId.current !== id) return;
        requestId.current++;
        stopWorker();
        setGenerating(false);
        setError(message);
      };
      task.onmessage = ({ data }: MessageEvent<GenerationResponse>) => {
        if (data.requestId !== id || requestId.current !== id) return;
        if (!data.ok) { fail(data.error); return; }
        const puzzle = readGeneratedPuzzles([data.puzzle])[0];
        if (!puzzle) { fail('The puzzle did not pass its final checks. Try another seed.'); return; }
        requestId.current++;
        stopWorker();
        setGenerating(false);
        onGenerated(puzzle);
      };
      task.onerror = event => {
        event.preventDefault();
        fail('Generation couldn’t finish. Please try again with a different seed.');
      };
      deadline.current = setTimeout(() => fail('This puzzle is taking too long. Try a different seed or difficulty.'), 30_000);
      task.postMessage({ requestId: id, options } satisfies GenerationRequest);
    } catch (cause) {
      requestId.current++;
      stopWorker();
      setGenerating(false);
      setError(cause instanceof Error ? cause.message : 'Please check the puzzle settings.');
    }
  };

  return <form className="new-puzzle-form" onSubmit={generate} aria-busy={generating}>
    <span className="modal-symbol"><Sparkles size={27} /></span>
    <div className="eyebrow">A FRESH LITTLE CHALLENGE</div>
    <h2>Something new to solve.</h2>
    <p>Pick your pace. We’ll make a new puzzle with exactly one solution.</p>
    <fieldset disabled={generating}><legend>Board size</legend><div className="size-options">
      {([5, 6, 7, 8] as const).map(value => <label className="generation-choice" key={value}><input type="radio" name="size" value={value} checked={size === value} onChange={() => setSize(value)} /><span>{value} × {value}</span></label>)}
    </div></fieldset>
    <fieldset disabled={generating}><legend>Difficulty</legend><div className="difficulty-options">
      {LEVELS.map(level => <label className="generation-choice" key={level.value}><input type="radio" name="difficulty" value={level.value} checked={difficulty === level.value} onChange={() => setDifficulty(level.value)} /><span><strong>{level.value}</strong><small>{level.description}</small></span></label>)}
    </div><p className="generation-help">Estimated from solving techniques, not just grid size.</p></fieldset>
    <label className="seed-label" htmlFor="puzzle-seed">Seed or puzzle code <span>optional</span></label>
    <input className="seed-input" id="puzzle-seed" name="seed" value={seed} disabled={generating} maxLength={1024} placeholder="Try: sunday-coffee" autoComplete="off" spellCheck={false} onChange={event => {
      const text = event.target.value;
      setSeed(text);
      const options = parsePuzzleCode(text);
      if (options) { setSize(options.size); setDifficulty(options.difficulty); }
    }} aria-describedby="seed-help generation-error" />
    <p className="generation-help" id="seed-help">Leave blank for a fresh puzzle. The same seed, size, and difficulty recreate the same board. Existing progress is kept.</p>
    {error && <p className="generation-error" role="alert" id="generation-error">{error}</p>}
    {generating && <div className="generation-status" role="status"><LoaderCircle size={20} /><div><strong>Making a little possibility.</strong><span>Checking the solution and matching your difficulty…</span></div></div>}
    <div className="modal-actions">{(variant === 'dialog' || generating) && <button className="secondary-button" type="button" onClick={cancel}>{generating ? 'Cancel generation' : 'Maybe later'}</button>}<button className="primary-button" type="submit" disabled={generating}>{generating ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}{generating ? 'Generating…' : 'Generate puzzle'}</button></div>
  </form>;
}
