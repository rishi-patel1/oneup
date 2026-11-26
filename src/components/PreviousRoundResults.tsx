import { Trophy } from 'lucide-react';
import type { PreviousRound } from '../multiplayer/model';

function resultTime(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

export default function PreviousRoundResults({ round, userId }: { round: PreviousRound; userId: string }) {
  const results = [...round.results].sort((left, right) => {
    const leftTime = left.finished_at ? left.elapsed_ms ?? Infinity : Infinity;
    const rightTime = right.finished_at ? right.elapsed_ms ?? Infinity : Infinity;
    return leftTime - rightTime || left.nickname.localeCompare(right.nickname) || left.user_id.localeCompare(right.user_id);
  });
  return <details className="arena-previous-results" key={round.round_id}>
    <summary><Trophy size={19} /><strong>View previous results</strong><span>{round.size} × {round.size} · {round.difficulty}</span></summary>
    <div className="arena-previous-results-content">
      <p>The last round’s standings stay here while you choose the next grid.</p>
      <table aria-label="Previous round results">
        <thead><tr><th scope="col">Place</th><th scope="col">Player</th><th scope="col">Result</th></tr></thead>
        <tbody>{results.map(player => {
          const rank = player.finished_at ? 1 + results.filter(other => other.finished_at && (other.elapsed_ms ?? Infinity) < (player.elapsed_ms ?? Infinity)).length : null;
          return <tr key={player.user_id} className={player.user_id === userId ? 'is-you' : undefined}>
            <td>{rank === 1 ? <><Trophy size={16} /> 1</> : rank ?? '—'}</td>
            <th scope="row">{player.nickname}{player.user_id === userId && <small>you</small>}</th>
            <td>{player.finished_at && player.elapsed_ms !== null ? resultTime(player.elapsed_ms) : 'Did not finish'}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </details>;
}
