import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../utils/supabase';
import type { Difficulty } from '../game/engine';
import {
  CompetitionInputError, RoomDataError, isUuid, normalizeChatMessage, normalizeNickname, normalizeProgress,
  normalizeRoomCode, parseRoomChat, parseRoomState, parseSpectatorState, type GridVotePhase, type PublicPuzzle, type RoomChatState, type RoomState, type SpectatorState,
} from './model';

export type { ChatMessage, GridChoice, GridVotePhase, PublicPuzzle, RoomChatState, RoomPlayer, RoomResult, RoomState, SpectatorState } from './model';
export { isPlayerDone, normalizeChatMessage } from './model';
export { isSupabaseConfigured };

class CompetitionError extends Error {}
const ROOM_REMOVED_MESSAGE = 'You were removed from this room by the host.';
const ROOM_EXPIRED_MESSAGE = 'This room has expired. Create or join another room.';
class RoomRemovedError extends CompetitionError {
  readonly code = 'ROOM_REMOVED';
  constructor() { super(ROOM_REMOVED_MESSAGE); }
}
class RoomExpiredError extends CompetitionError {
  readonly code = 'ROOM_EXPIRED';
  constructor() { super(ROOM_EXPIRED_MESSAGE); }
}

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

/** Preserve removal as a distinct state so room polling can stop and leave cleanly. */
export function isRoomRemovedError(error: unknown): boolean {
  if (error instanceof RoomRemovedError) return true;
  const { message, code } = errorDetails(error);
  return code === 'ROOM_REMOVED' || message.trim() === ROOM_REMOVED_MESSAGE;
}

export function isRoomExpiredError(error: unknown): boolean {
  if (error instanceof RoomExpiredError) return true;
  const { message, code } = errorDetails(error);
  return code === 'ROOM_EXPIRED' || message.trim() === ROOM_EXPIRED_MESSAGE;
}

export function isRoomUnavailableError(error: unknown): boolean {
  return isRoomRemovedError(error) || isRoomExpiredError(error);
}

function competitionError(error: unknown): CompetitionError {
  return isRoomRemovedError(error) ? new RoomRemovedError() : isRoomExpiredError(error) ? new RoomExpiredError() : new CompetitionError(explainError(error));
}

/** Product-safe feedback: SQL names, stack traces, and request details stay out of the UI. */
export function explainError(error: unknown): string {
  if (isRoomRemovedError(error)) return ROOM_REMOVED_MESSAGE;
  if (isRoomExpiredError(error)) return ROOM_EXPIRED_MESSAGE;
  if (error instanceof CompetitionError || error instanceof CompetitionInputError || error instanceof RoomDataError) return error.message;
  const { message, code, status } = errorDetails(error);
  const text = `${code} ${message}`.toLowerCase();
  if (/rejoin.*chat|join.*before.*(?:chat|messag)/.test(text)) return 'Rejoin this room to use its chat.';
  if (/(?:message|nonce).*(?:different|changed|already used|does not match the original)/.test(text)) return 'This message changed. Send it again as a new message.';
  if (/chat.*(?:body|text|character|empty|control)|message.*(?:character|empty|control)/.test(text)) return 'Write a message between 1 and 500 characters without control characters.';
  if (/only.*host.*(?:kick|remove)/.test(text)) return 'Only the room host can remove away players.';
  if (/(?:kick|remove).*(?:yourself|themselves|own player)/.test(text)) return 'You can’t remove yourself from the room.';
  if (/player has already left this room/.test(text)) return 'That player has already left this room.';
  if (/not away|still connected|recently seen|only away|away.*(?:minute|seconds)/.test(text)) return 'This player is still connected. Only away players can be removed.';
  if (/spectator.*(?:play|solve|save|submit|pause|resume|give up)|(?:play|solve|save|submit|pause|resume|give up).*spectator/.test(text)) return 'You’re spectating this round. You can play in the next game.';
  if (/choose a player who is solving/.test(text)) return 'Choose a player who is solving this round.';
  if (/anonymous.*(disabled|not enabled)|anonymous_provider_disabled/.test(text)) return 'Guest joining is not available yet. Please try again later.';
  if (/pgrst20[25]|42p01|42883|function.*not found|relation.*does not exist/.test(text) || status === 404) return 'Competition setup is not ready yet. You can keep playing solo.';
  if (/failed to fetch|fetch failed|network|load failed|timed? out|timeout|functionsfetcherror/.test(text)) return 'Couldn’t reach the room. Check your connection and try again.';
  if (status === 429 || /rate.limit|too many|room creation limit/.test(text)) return 'Too many attempts. Please wait a moment and try again.';
  if (status === 401 || /jwt|refresh token|session.*(expired|missing)|not authenticated|sign in/.test(text)) return 'Your connection expired. Refresh the page and reconnect.';
  if (/pause.*(?:changed|version)|timing.*changed|stale.*pause/.test(text)) return 'The pause state has changed. Reconnect to continue.';
  if (/paused|resume countdown/.test(text)) return 'The room is paused. Players still solving must be ready before play resumes.';
  if (/round.*(?:changed|stale)|stale.*round|moved.*round/.test(text)) return 'This room has moved to a new round. Reconnect to continue.';
  if (/phase|voting.*(?:closed|available|lobby|finished)|grid choice.*changed/.test(text)) return 'Grid voting has changed. Reconnect to see the current choice.';
  if (/only.*host.*grid/.test(text)) return 'Only the room host can apply the grid choice.';
  if (/join.*before voting/.test(text)) return 'Rejoin this room before voting for a grid.';
  if (/grid vote|grid size|grid difficulty/.test(text)) return 'Choose a grid size from 5 through 8 and a difficulty.';
  if (/only.*host.*(?:next|new|rematch|round|game)/.test(text)) return 'Only the room host can create the next game.';
  if (/(?:everyone|every player).*finish|finish.*(?:everyone|every player)|round.*(?:not finished|still running)/.test(text)) return 'Wait for everyone to finish or give up before creating the next game.';
  if (/spectat.*(?:finish|complet)|(?:finish|complet).*spectat|finish(?: or give up)? your (?:puzzle|race) before watch/.test(text)) return 'Finish or give up your race before watching another player.';
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
      return competitionError({ message, code: body.code, status: context.status });
    } catch { return new CompetitionError(explainError({ status: context.status })); }
  }
  return competitionError(error);
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

  async function requestRpc(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ data: unknown; userId: string }> {
    const service = requireClient();
    const userId = await getUserId();
    const request = service.rpc(name, args);
    const { data, error } = await (signal ? request.abortSignal(signal) : request);
    if (error) throw competitionError(error);
    // Expected join failures return data so Postgres can commit the attempt counter.
    if (data && typeof data === 'object' && typeof data.error === 'string') {
      throw competitionError({ message: data.error, code: data.code });
    }
    return { data, userId };
  }

  async function rpc(name: string, args: Record<string, unknown>): Promise<RoomState> {
    const { data, userId } = await requestRpc(name, args);
    return parseRoomState(data, userId);
  }

  const getRoom = (code: string) => rpc('numora_get_room', { p_code: normalizeRoomCode(code) });

  function chatArguments(code: string, roomId: string) {
    const roomCode = normalizeRoomCode(code), id = typeof roomId === 'string' ? roomId.trim().toLowerCase() : '';
    if (!isUuid(id)) throw new CompetitionInputError('Reconnect to this room to open its chat.');
    return { p_code: roomCode, p_room_id: id };
  }

  const getRoomChat = (code: string, roomId: string, signal?: AbortSignal): Promise<RoomChatState> => {
    const args = chatArguments(code, roomId);
    return requestRpc('numora_get_room_chat', args, signal).then(({ data }) => parseRoomChat(data, args.p_room_id));
  };

  const sendRoomMessage = (code: string, roomId: string, clientId: string, body: string): Promise<RoomChatState> => {
    const args = chatArguments(code, roomId), nonce = typeof clientId === 'string' ? clientId.trim().toLowerCase() : '';
    if (!isUuid(nonce)) throw new CompetitionInputError('Start a new message and try sending again.');
    const text = normalizeChatMessage(body);
    return requestRpc('numora_send_room_message', { ...args, p_client_id: nonce, p_body: text }).then(({ data }) => parseRoomChat(data, args.p_room_id));
  };

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

  const giveUpRoom = (code: string, roundId: string) => {
    const roomCode = normalizeRoomCode(code);
    const round = roundArguments(roundId);
    if (!round.p_round_id) throw new CompetitionInputError('Reconnect to this room to load the current round.');
    return rpc('numora_give_up_room', { p_code: roomCode, ...round });
  };

  const kickRoomPlayer = (code: string, playerId: string, roundId: string) => {
    const roomCode = normalizeRoomCode(code), round = roundArguments(roundId);
    const target = typeof playerId === 'string' ? playerId.trim().toLowerCase() : '';
    if (!isUuid(target)) throw new CompetitionInputError('Choose a player in this room to remove.');
    if (!round.p_round_id) throw new CompetitionInputError('Reconnect to this room to load the current round.');
    return rpc('numora_kick_player', { p_code: roomCode, p_player_id: target, ...round });
  };

  function gridSettings(choice: { size: number; difficulty: Difficulty }) {
    if (!choice || ![5, 6, 7, 8].includes(choice.size) || !['Easy', 'Medium', 'Hard'].includes(choice.difficulty)) {
      throw new CompetitionInputError('Choose a grid size from 5 through 8 and a difficulty.');
    }
    return { size: choice.size, difficulty: choice.difficulty };
  }
  function gridPhase(phase: GridVotePhase): GridVotePhase {
    if (phase !== 'lobby' && phase !== 'finished') throw new CompetitionInputError('Reconnect to see when grid voting is open.');
    return phase;
  }
  const voteRoomGrid = (code: string, roundId: string, phase: GridVotePhase, choice: { size: number; difficulty: Difficulty } | null) => {
    const roomCode = normalizeRoomCode(code), round = roundArguments(roundId), currentPhase = gridPhase(phase);
    if (!round.p_round_id) throw new CompetitionInputError('Reconnect to this room to load the current round.');
    const settings = choice === null ? null : gridSettings(choice);
    return rpc('numora_vote_grid', { p_code: roomCode, ...round, p_phase: currentPhase, p_size: settings?.size ?? null, p_difficulty: settings?.difficulty ?? null });
  };

  const pauseRoom = (code: string, roundId: string, version: number) => rpc('numora_pause_room', {
    p_code: normalizeRoomCode(code), ...roundArguments(roundId), ...pauseArguments(version),
  });
  const setResumeReady = (code: string, roundId: string, pauseId: string, ready: boolean) => {
    if (!isUuid(pauseId) || typeof ready !== 'boolean') throw new CompetitionInputError('Reconnect to load the current pause state.');
    return rpc('numora_set_resume_ready', { p_code: normalizeRoomCode(code), ...roundArguments(roundId), p_pause_id: pauseId.toLowerCase(), p_ready: ready });
  };

  async function rematchRoom(code: string, roundId: string, options?: { size: number; difficulty: Difficulty; phase: GridVotePhase }): Promise<RoomState> {
    const roomCode = normalizeRoomCode(code);
    const { p_round_id } = roundArguments(roundId);
    if (!p_round_id) throw new CompetitionInputError('Reconnect to this room to load the current round.');
    const settings = options === undefined ? {} : { ...gridSettings(options), phase: gridPhase(options.phase) };
    const service = requireClient();
    await getUserId();
    const { data, error } = await service.functions.invoke('numora-rematch-room', { body: { code: roomCode, round_id: p_round_id, ...settings } });
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
    // The RPC verifies the viewer’s spectator/outcome eligibility and both memberships on every request.
    const { data } = await requestRpc('numora_spectate_player', { p_code: roomCode, p_player_id: target, ...roundArguments(roundId), ...pauseArguments(pauseVersion) }, signal);
    return parseSpectatorState(data, target, puzzle);
  }
  async function leaveRoom(code: string, roundId?: string): Promise<void> {
    const args = { p_code: normalizeRoomCode(code), ...roundArguments(roundId) };
    const service = requireClient();
    await getUserId();
    const { error } = await service.rpc('numora_leave_room', args);
    if (error) throw competitionError(error);
  }

  function watchRoom(roomId: string, onChange: () => void, onPresence: (ids: string[]) => void, onChatChange?: () => void): () => void {
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
        .on('broadcast', { event: 'room-chat' }, () => { if (!disposed) onChatChange?.(); })
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

  return { getUserId, createRoom, rematchRoom, voteRoomGrid, joinRoom, getRoom, getRoomChat, sendRoomMessage, giveUpRoom, kickRoomPlayer, setReady, startRoom, pauseRoom, setResumeReady, saveProgress, submitSolution, getSpectatorState, leaveRoom, watchRoom };
}

const api = createCompetitionApi(supabase);
export const { getUserId, createRoom, rematchRoom, voteRoomGrid, joinRoom, getRoom, getRoomChat, sendRoomMessage, giveUpRoom, kickRoomPlayer, setReady, startRoom, pauseRoom, setResumeReady, saveProgress, submitSolution, getSpectatorState, leaveRoom, watchRoom } = api;
