import { useId, useMemo, useState } from 'react';
import { Check, Crown, Grid2X2, Vote } from 'lucide-react';
import type { Difficulty } from '../game/engine';
import type { RoomPlayer, RoomState } from '../multiplayer/model';
import './grid-choice.css';

export interface GridChoice {
  size: number;
  difficulty: Difficulty;
}

interface GridChoicePanelProps {
  snapshot: RoomState;
  userId: string;
  busy: boolean;
  onVote: (choice: GridChoice | null) => void;
  onApply: (choice: GridChoice) => void;
}

const SIZES = [5, 6, 7, 8] as const;
const LEVELS: Difficulty[] = ['Easy', 'Medium', 'Hard'];

function playerVote(player?: RoomPlayer): GridChoice | null {
  return (player as (RoomPlayer & { grid_vote?: GridChoice | null }) | undefined)?.grid_vote ?? null;
}

function sameChoice(left: GridChoice | null, right: GridChoice | null) {
  return left?.size === right?.size && left?.difficulty === right?.difficulty;
}

function choiceName(choice: GridChoice) {
  return `${choice.size} × ${choice.size} · ${choice.difficulty}`;
}

/** Key by round and phase in the parent so room polls keep unsent choices intact. */
export default function GridChoicePanel({ snapshot, userId, busy, onVote, onApply }: GridChoicePanelProps) {
  const { room, players } = snapshot;
  const own = players.find(player => player.user_id === userId);
  const submitted = playerVote(own);
  const current = { size: room.size, difficulty: room.difficulty };
  const [draft, setDraft] = useState<GridChoice>(() => submitted ?? current);
  const [hostChoice, setHostChoice] = useState<GridChoice>(current);
  const id = useId();
  const isHost = room.host_id === userId;
  const canVote = Boolean(own?.active);
  const host = players.find(player => player.user_id === room.host_id);
  const active = players.filter(player => player.active);
  const tallies = useMemo(() => {
    const choices = new Map<string, { choice: GridChoice; names: string[] }>();
    for (const player of players) {
      const choice = player.active ? playerVote(player) : null;
      if (!choice) continue;
      const key = `${choice.size}:${choice.difficulty}`;
      const tally = choices.get(key);
      if (tally) tally.names.push(player.nickname);
      else choices.set(key, { choice, names: [player.nickname] });
    }
    return [...choices.values()].sort((a, b) => b.names.length - a.names.length || a.choice.size - b.choice.size || LEVELS.indexOf(a.choice.difficulty) - LEVELS.indexOf(b.choice.difficulty));
  }, [players]);
  const voteCount = tallies.reduce((count, tally) => count + tally.names.length, 0);
  const leadingCount = tallies[0]?.names.length ?? 0;
  const tied = leadingCount > 0 && tallies.filter(tally => tally.names.length === leadingCount).length > 1;
  const unchanged = sameChoice(hostChoice, current);

  if (room.status !== 'lobby') return null;

  return <section id="room-grid-choice" className="grid-choice-panel" aria-labelledby={`${id}-title`} aria-busy={busy} tabIndex={-1}>
    <div className="grid-choice-heading">
      <div><span className="eyebrow"><Vote size={15} /> A SHARED CHOICE</span><h2 id={`${id}-title`}>Choose your shared grid.</h2><p>Vote for a size and difficulty. The host has the final say.</p></div>
      <div className="grid-choice-current"><span>Current grid</span><strong><Grid2X2 size={17} />{choiceName(current)}</strong></div>
    </div>

    <div className="grid-choice-columns">
      <form className="grid-choice-ballot" onSubmit={event => { event.preventDefault(); if (canVote && !busy && !sameChoice(draft, submitted)) onVote({ ...draft }); }}>
        <h3>Your vote</h3>
        <fieldset disabled={busy || !canVote}><legend>Your preferred board size</legend><div className="grid-choice-sizes">{SIZES.map(size => <label className="grid-choice-option" key={size}><input type="radio" name={`${id}-vote-size`} value={size} checked={draft.size === size} onChange={() => setDraft(choice => ({ ...choice, size }))} /><span>{size} × {size}</span></label>)}</div></fieldset>
        <fieldset disabled={busy || !canVote}><legend>Your preferred difficulty</legend><div className="grid-choice-levels">{LEVELS.map(difficulty => <label className="grid-choice-option" key={difficulty}><input type="radio" name={`${id}-vote-level`} value={difficulty} checked={draft.difficulty === difficulty} onChange={() => setDraft(choice => ({ ...choice, difficulty }))} /><span>{difficulty}</span></label>)}</div></fieldset>
        <div className="grid-choice-vote-actions"><button className="secondary-button" type="submit" disabled={busy || !canVote || sameChoice(draft, submitted)}><Vote size={16} />{sameChoice(draft, submitted) ? 'Vote submitted' : submitted ? 'Update vote' : 'Submit vote'}</button>{submitted && <button className="grid-choice-clear" type="button" disabled={busy || !canVote} onClick={() => onVote(null)}>Clear vote</button>}</div>
        <p className="grid-choice-note" role="status">{!canVote ? 'Rejoin the room to vote.' : submitted ? `Your submitted vote: ${choiceName(submitted)}.` : 'Your vote is a suggestion. It won’t change the current grid.'}</p>
      </form>

      <div className="grid-choice-results" aria-labelledby={`${id}-votes`}>
        <div className="grid-choice-results-heading"><h3 id={`${id}-votes`}>Room votes</h3><span>{voteCount} of {active.length} voted</span></div>
        {tallies.length ? <ul className="grid-choice-tallies">{tallies.map(({ choice, names }) => <li key={`${choice.size}:${choice.difficulty}`}><div className="grid-choice-tally-top"><strong>{choiceName(choice)}</strong><span>{names.length} {names.length === 1 ? 'vote' : 'votes'}</span></div><p>{names.join(', ')}</p><div className="grid-choice-tally-bottom">{names.length === leadingCount ? <span className="grid-choice-leading">{tied ? 'Joint lead' : 'Most votes'}</span> : <span />}{isHost && <button className="grid-choice-use" type="button" aria-label={`Use ${choiceName(choice)} as host choice`} aria-pressed={sameChoice(hostChoice, choice)} disabled={busy || sameChoice(hostChoice, choice)} onClick={() => setHostChoice({ ...choice })}>{sameChoice(hostChoice, choice) ? <><Check size={14} />Host choice</> : 'Use choice'}</button>}</div></li>)}</ul> : <div className="grid-choice-empty"><Vote size={25} /><p>No votes yet.</p><span>Choose your preference to get things started.</span></div>}
        {tied && <p className="grid-choice-note">The leading choices are tied. The host can choose either, or pick another grid.</p>}
      </div>
    </div>

    {isHost ? <form className="grid-choice-host" onSubmit={event => { event.preventDefault(); if (!busy && !unchanged) onApply({ ...hostChoice }); }}>
      <div className="grid-choice-host-heading"><span><Crown size={19} /><strong>Your final choice</strong></span><p>Use a room suggestion or choose any grid.</p></div>
      <fieldset disabled={busy}><legend>Host board size</legend><div className="grid-choice-sizes">{SIZES.map(size => <label className="grid-choice-option" key={size}><input type="radio" name={`${id}-host-size`} value={size} checked={hostChoice.size === size} onChange={() => setHostChoice(choice => ({ ...choice, size }))} /><span>{size} × {size}</span></label>)}</div></fieldset>
      <fieldset disabled={busy}><legend>Host difficulty</legend><div className="grid-choice-levels">{LEVELS.map(difficulty => <label className="grid-choice-option" key={difficulty}><input type="radio" name={`${id}-host-level`} value={difficulty} checked={hostChoice.difficulty === difficulty} onChange={() => setHostChoice(choice => ({ ...choice, difficulty }))} /><span>{difficulty}</span></label>)}</div></fieldset>
      <div className="grid-choice-apply"><button className="primary-button" type="submit" disabled={busy || unchanged}><Grid2X2 size={17} />Apply grid</button><p>{unchanged ? 'This grid is selected. Everyone can ready up to start.' : 'Changing the grid clears everyone’s ready status.'}</p></div>
    </form> : <p className="grid-choice-host-note"><Crown size={17} /><span>{host?.nickname ?? 'The host'} chooses the final grid. You’ll stay in this room for the next game.</span></p>}
    {busy && <p className="grid-choice-busy" role="status">Updating the room…</p>}
  </section>;
}
