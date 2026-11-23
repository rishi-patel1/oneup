import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../utils/supabase';
import type { Difficulty } from '../game/engine';
import {
  CompetitionInputError, RoomDataError, isUuid, normalizeNickname, normalizeProgress,
  normalizeRoomCode, parseRoomState, parseSpectatorState, type PublicPuzzle, type RoomState, type SpectatorState,
} from './model';

export type { PublicPuzzle, RoomPlayer, RoomState, SpectatorState } from './model';
export { isSupabaseConfigured };

class CompetitionError extends Error {}

function errorDetails(error: unknown): { message: string; code: string; status: number } {
  if (typeof error === 'string') return { message: error, code: '', status: 0 };
  if (!error || typeof error !== 'object') return { message: '', code: '', status: 0 };
  const source = error as { message?: unknown; code?: unknown; status?: unknown };
  return {
    message: typeof source.message === 'string' ? source.message : '',
    code: typeof source.code === 'string' ? source.code : '',
    status: typeof source.status === 'number' ? source.status : 0,
  };
}

/** Product-safe feedback: SQL names, stack traces, and request details stay out of the UI. */
export function explainError(error: unknown): string {
  if (error instanceof CompetitionError || error instanceof CompetitionInputError || error instanceof RoomDataError) return error.message;
  const { message, code, status } = errorDetails(error);
  const text = `${code} ${message}`.toLowerCase();
  if (/anonymous.*(disabled|not enabled)|anonymous_provider_disabled/.test(text)) return 'Guest joining is not available yet. Please try again later.';
  if (/pgrst20[25]|42p01|42883|function.*not found|relation.*does not exist/.test(text) || status === 404) return 'Competition setup is not ready yet. You can keep playing solo.';
  if (/failed to fetch|fetch failed|network|load failed|timed? out|timeout|functionsfetcherror/.test(text)) return 'Couldn’t reach the room. Check your connection and try again.';
  if (status === 429 || /rate.limit|too many|room creation limit/.test(text)) return 'Too many attempts. Please wait a moment and try again.';
  if (status === 401 || /jwt|refresh token|session.*(expired|missing)|not authenticated|sign in/.test(text)) return 'Your connection expired. Refresh the page and reconnect.';
  if (/pause.*(?:changed|version)|timing.*changed|stale.*pause/.test(text)) return 'The pause state has changed. Reconnect to continue.';
  if (/paused|resume countdown/.test(text)) return 'The room is paused. Everyone must be ready before play resumes.';
  if (/round.*(?:changed|stale)|stale.*round|moved.*round/.test(text)) return 'This room has moved to a new round. Reconnect to continue.';
  if (/only.*host.*(?:next|new|rematch|round|game)/.test(text)) return 'Only the room host can create the next game.';
  if (/everyone.*finish|finish.*everyone|round.*(?:not finished|still running)/.test(text)) return 'Wait for everyone to finish before creating the next game.';
  if (/spectat.*(?:finish|complet)|(?:finish|complet).*spectat|finish your (?:puzzle|race) before watch/.test(text)) return 'Finish your race before watching another player.';
  if (/spectat.*(?:yourself|own)|(?:yourself|own).*spectat|choose another player.*watch/.test(text)) return 'Choose another player to watch.';
  if (/spectat.*(?:unavailable|not found)|target.*(?:not.*member|not found|same room)|player is not in this room/.test(text)) return 'That player is not available to watch in this room.';
  if (/room.*(not found|does not exist)|invalid room code|unknown room/.test(text)) return 'That room wasn’t found. Check the code and try again.';
  if (/nickname.*(already|taken|in use)/.test(text)) return 'That nickname is already taken in this room. Choose another.';
  if (/room.*full|capacity|eight players|8 players/.test(text)) return 'This room is full. Try another room.';
  if (/already started|join.*before.*start|late join/.test(text)) return 'This race has already started. Join a new room.';
  if (/not started|countdown/.test(text)) return 'The race hasn’t started yet. Wait for the countdown.';
  if (/only.*host|not.*host/.test(text)) return 'Only the room host can start this race.';
  if (/ready|two players|2 players|at least two|invite at least one/.test(text)) return 'At least two players must be ready before starting.';
  if (/board|grid|solution|givens|segment|incomplete/.test(text)) return 'The grid isn’t complete or breaks a rule. Take another look and submit again.';
  if (code === '42501' || /not.*member|not.*participant|access denied/.test(text)) return 'You don’t have access to this room. Join again with its code.';
  if (/finished|closed|ended/.test(text)) return 'This race has ended. Create or join another room.';
  return 'Something went wrong with this room. Please try again.';
}

async function functionError(error: unknown): Promise<CompetitionError> {
  const context = error && typeof error === 'object' && 'context' in error ? error.context : null;
  if (context instanceof Response) {
    try {
      const body = await context.clone().json() as { error?: unknown; message?: unknown; code?: unknown };
      const message = typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : '';
      return new CompetitionError(explainError({ message, code: body.code, status: context.status }));
    } catch { return new CompetitionError(explainError({ status: context.status })); }
  }
  return new CompetitionError(explainError(error));
}

/** A factory keeps guest sign-up single-flight and makes network behavior testable. */
export function createCompetitionApi(client: SupabaseClient | null) {
  let guestRequest: Promise<string> | null = null;

  function requireClient() {
    if (!client) throw new CompetitionError('Competition is not configured yet. You can keep playing solo.');
    return client;
  }

  async function getUserId(): Promise<string> {
    const service = requireClient();
    if (!guestRequest) {
      guestRequest = (async () => {
        const existing = await service.auth.getSession();
        if (existing.error) throw new CompetitionError(explainError(existing.error));
        if (existing.data.session?.user.id) return existing.data.session.user.id;
        const created = await service.auth.signInAnonymously();
        if (created.error) throw new CompetitionError(explainError(created.error));
        if (!created.data.user?.id) throw new CompetitionError('Guest joining couldn’t finish. Please try again.');
        return created.data.user.id;
      })().finally(() => { guestRequest = null; });
    }
    return guestRequest;
  }

  async function requestRpc(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const service = requireClient();
    await getUserId();
    const request = service.rpc(name, args);
    const { data, error } = await (signal ? request.abortSignal(signal) : request);
    if (error) throw new CompetitionError(explainError(error));
    // Expected join failures return data so Postgres can commit the attempt counter.
    if (data && typeof data === 'object' && typeof data.error === 'string') {
      throw new CompetitionError(explainError({ message: data.error, code: data.code }));
    }
    return data;
  }

  async function rpc(name: string, args: Record<string, unknown>): Promise<RoomState> {
    return parseRoomState(await requestRpc(name, args));
  }

  const getRoom = (code: string) => rpc('numora_get_room', { p_code: normalizeRoomCode(code) });

  function roundArguments(roundId?: string): Record<string, string> {
    if (roundId === undefined) return {};
    if (!isUuid(roundId)) throw new CompetitionInputError('Reconnect to this room to load the current round.');
    return { p_round_id: roundId.toLowerCase() };
  }

  function pauseArguments(version?: number): Record<string, number> {
    if (version === undefined) return {};
    if (!Number.isSafeInteger(version) || version < 0) throw new CompetitionInputError('Reconnect to load the current pause state.');
    return { p_pause_version: version };
  }

  const pauseRoom = (code: string, roundId: string, version: number) => rpc('numora_pause_room', {
    p_code: normalizeRoomCode(code), ...roundArguments(roundId), ...pauseArguments(version),
  });
  const setResumeReady = (code: string, roundId: string, pauseId: string, ready: boolean) => {
    if (!isUuid(pauseId) || typeof ready !== 'boolean') throw new CompetitionInputError('Reconnect to load the current pause state.');
    return rpc('numora_set_resume_ready', { p_code: normalizeRoomCode(code), ...roundArguments(roundId), p_pause_id: pauseId.toLowerCase(), p_ready: ready });
  };

  async function rematchRoom(code: string, roundId: string): Promise<RoomState> {
    const roomCode = normalizeRoomCode(code);
    const { p_round_id } = roundArguments(roundId);
    if (!p_round_id) throw new CompetitionInputError('Reconnect to this room to load the current round.');
    const service = requireClient();
    await getUserId();
    const { data, error } = await service.functions.invoke('numora-rematch-room', { body: { code: roomCode, round_id: p_round_id } });
    if (error) throw await functionError(error);
    if (!data || data.code !== roomCode) throw new RoomDataError();
    return getRoom(roomCode);
  }

  async function createRoom(options: { nickname: string; size: number; difficulty: Difficulty }): Promise<RoomState> {
    const nickname = normalizeNickname(options.nickname);
    if (![5, 6, 7, 8].includes(options.size) || !['Easy', 'Medium', 'Hard'].includes(options.difficulty)) {
      throw new CompetitionInputError('Choose a board size from 5 through 8 and a difficulty.');
    }
    const service = requireClient();
    await getUserId();
    const { data, error } = await service.functions.invoke('numora-create-room', { body: { nickname, size: options.size, difficulty: options.difficulty } });
    if (error) throw await functionError(error);
    if (!data || typeof data.code !== 'string') throw new RoomDataError();
    return getRoom(normalizeRoomCode(data.code));
  }

  const joinRoom = (code: string, nickname: string) => rpc('numora_join_room', { p_code: normalizeRoomCode(code), p_nickname: normalizeNickname(nickname) });
  const setReady = (code: string, ready: boolean, roundId?: string) => rpc('numora_set_ready', { p_code: normalizeRoomCode(code), p_ready: ready, ...roundArguments(roundId) });
  const startRoom = (code: string, roundId?: string) => rpc('numora_start_room', { p_code: normalizeRoomCode(code), ...roundArguments(roundId) });
  const saveProgress = (code: string, values: number[], notes: number[][], roundId?: string, pauseVersion?: number) => {
    const board = normalizeProgress(values, notes);
    return rpc('numora_save_progress', { p_code: normalizeRoomCode(code), p_values: board.values, p_notes: board.notes, ...roundArguments(roundId), ...pauseArguments(pauseVersion) });
  };
  const submitSolution = (code: string, values: number[], notes: number[][], roundId?: string, pauseVersion?: number) => {
    const board = normalizeProgress(values, notes);
    return rpc('numora_submit_solution', { p_code: normalizeRoomCode(code), p_values: board.values, p_notes: board.notes, ...roundArguments(roundId), ...pauseArguments(pauseVersion) });
  };
  async function getSpectatorState(code: string, playerId: string, puzzle: PublicPuzzle, signal?: AbortSignal, roundId?: string, pauseVersion?: number): Promise<SpectatorState> {
    const roomCode = normalizeRoomCode(code);
    const target = playerId.trim().toLowerCase();
    if (!isUuid(target)) throw new CompetitionInputError('Choose another player in this room to watch.');
    // The RPC verifies the viewer's finish and both memberships on every request.
    const data = await requestRpc('numora_spectate_player', { p_code: roomCode, p_player_id: target, ...roundArguments(roundId), ...pauseArguments(pauseVersion) }, signal);
    return parseSpectatorState(data, target, puzzle);
  }
  async function leaveRoom(code: string, roundId?: string): Promise<void> {
    const args = { p_code: normalizeRoomCode(code), ...roundArguments(roundId) };
    const service = requireClient();
    await getUserId();
    const { error } = await service.rpc('numora_leave_room', args);
    if (error) throw new CompetitionError(explainError(error));
  }

  function watchRoom(roomId: string, onChange: () => void, onPresence: (ids: string[]) => void): () => void {
    const service = requireClient();
    if (!isUuid(roomId)) throw new CompetitionInputError('Reconnect to this room to restore live updates.');
    let disposed = false;
    let channel: ReturnType<SupabaseClient['channel']> | null = null;
    void getUserId().then(userId => {
      if (disposed) return;
      channel = service.channel(`numora-room:${roomId}`, { config: { private: true, presence: { key: userId } } });
      const activeChannel = channel;
      activeChannel
        .on('postgres_changes', { event: '*', schema: 'public', table: 'numora_rooms', filter: `id=eq.${roomId}` }, () => { if (!disposed) onChange(); })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'numora_players', filter: `room_id=eq.${roomId}` }, () => { if (!disposed) onChange(); })
        .on('presence', { event: 'sync' }, () => {
          if (disposed) return;
          const users = Object.values(activeChannel.presenceState<{ user_id: string }>()).flatMap(entries => entries.map(entry => entry.user_id)).filter(isUuid);
          onPresence([...new Set(users)]);
        })
        .subscribe(status => {
          if (disposed) return;
          if (status === 'SUBSCRIBED') {
            void activeChannel.track({ user_id: userId }).catch(() => {});
            onChange();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            onPresence([]);
          }
        });
    }).catch(() => { if (!disposed) onPresence([]); });
    return () => {
      disposed = true;
      if (channel) void service.removeChannel(channel).catch(() => {});
    };
  }

  return { getUserId, createRoom, rematchRoom, joinRoom, getRoom, setReady, startRoom, pauseRoom, setResumeReady, saveProgress, submitSolution, getSpectatorState, leaveRoom, watchRoom };
}

const api = createCompetitionApi(supabase);
export const { getUserId, createRoom, rematchRoom, joinRoom, getRoom, setReady, startRoom, pauseRoom, setResumeReady, saveProgress, submitSolution, getSpectatorState, leaveRoom, watchRoom } = api;
