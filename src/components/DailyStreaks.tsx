import { useEffect, useRef, useState } from 'react';
import { Flame, RefreshCw, Trophy } from 'lucide-react';
import { getDailyStreaks, type DailyStreaks as Streaks } from '../daily/api';
import './daily-streaks.css';

interface Props {
  date: string | null;
  completion: string | null;
  isGoogle: boolean;
  onSignIn: () => void;
}

export default function DailyStreaks({ date, completion, isGoogle, onSignIn }: Props) {
  const [streaks, setStreaks] = useState<Streaks | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    if (!date || !isGoogle) { setStreaks(null); setLoading(false); return; }
    let stopped = false, inFlight = false;
    let pending: AbortController | null = null;
    const load = async () => {
      if (stopped || inFlight) return;
      inFlight = true; setLoading(true); setFailed(false);
      const controller = new AbortController(); pending = controller;
      const timeout = setTimeout(() => controller.abort(), 12_000);
      try {
        const next = await getDailyStreaks(date, controller.signal);
        if (!stopped) setStreaks(next);
      } catch { if (!stopped) setFailed(true); }
      finally {
        clearTimeout(timeout); inFlight = false;
        if (pending === controller) pending = null;
        if (!stopped) setLoading(false);
      }
    };
    refresh.current = () => { void load(); };
    void load();
    return () => { stopped = true; pending?.abort(); refresh.current = () => {}; };
  }, [date, completion, isGoogle]);

  const current = isGoogle && streaks ? streaks.current : null;
  const longest = isGoogle && streaks ? streaks.max : null;
  const value = (count: number | null) => count === null ? (isGoogle && loading ? '…' : '—') : count;
  const caption = !isGoogle ? 'Sign in to build a streak across days.'
    : streaks?.completed_today ? 'Today’s done. See you tomorrow.'
      : streaks && streaks.current > 0 ? 'Finish today’s ranked puzzle to keep it going.'
        : 'Finish a ranked daily to start your streak.';

  return <section className="daily-streak-card" aria-label="Your daily streaks" aria-busy={loading}>
    <div className="daily-streak-heading"><span className="eyebrow">A LITTLE EVERY DAY</span><h2>Your daily streaks.</h2></div>
    <div className="daily-streak-numbers">
      <div><span className="daily-streak-label"><Flame size={16} /> Current streak</span><strong>{value(current)}<small>{current === 1 ? 'day' : 'days'}</small></strong></div>
      <div><span className="daily-streak-label"><Trophy size={16} /> Longest streak</span><strong>{value(longest)}<small>{longest === 1 ? 'day' : 'days'}</small></strong></div>
    </div>
    <p className="daily-streak-caption">{caption}</p>
    {!isGoogle && <button className="daily-streak-signin" onClick={onSignIn}>Sign in with Google</button>}
    {isGoogle && failed && <p className="daily-streak-error" role="status">Couldn’t update your streaks. <button disabled={loading} onClick={() => refresh.current()}><RefreshCw size={12} />{loading ? 'Retrying…' : 'Retry'}</button></p>}
    <p className="daily-streak-rule">Ranked daily finishes · UTC days</p>
  </section>;
}
