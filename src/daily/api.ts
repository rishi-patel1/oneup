import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../utils/supabase';
import { getUserId } from '../multiplayer/api';
import { isUuid, normalizeProgress } from '../multiplayer/model';
import { DailyDataError, DailyInputError, normalizeDailyDate, normalizeDisplayName, normalizeFriendCode, parseDailyLeaderboard, parseDailyState, parseDailyStreaks, parseFriendsState, parseProfile, type DailyLeaderboard, type DailyState, type DailyStreaks, type FriendsState, type LeaderboardScope, type Profile } from './model';

export type { DailyState, DailyAttempt, DailyLeaderboard, DailyStreaks, FriendsState, Friend, FriendRequest, Profile, LeaderboardEntry, LeaderboardScope } from './model';
export { isSupabaseConfigured } from '../utils/supabase';
class DailyApiError extends Error {}

export function explainDailyError(error: unknown): string {
  if (error instanceof DailyApiError || error instanceof DailyInputError || error instanceof DailyDataError) return error.message;
  const source = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown; status?: unknown } : {};
  const text = `${typeof source.code === 'string' ? source.code : ''} ${typeof source.message === 'string' ? source.message : typeof error === 'string' ? error : ''}`.toLowerCase();
  if (/pgrst20[25]|42p01|42883|function.*not found|relation.*does not exist/.test(text) || source.status === 404) return 'Daily challenges are not ready yet. You can keep playing solo.';
  if (/failed to fetch|fetch failed|network|load failed|timeout|timed out/.test(text)) return 'Couldn’t connect. Check your connection and try again.';
  if (/google|permanent account|registered account/.test(text)) return 'Sign in with Google to use friends and ranked daily challenges.';
  if (/expired|current.*day/.test(text) && !/token|session/.test(text)) return 'A new daily challenge is here. Refresh to start today’s puzzle.';
  if (/being prepared/.test(text)) return 'Today’s daily challenge is being prepared. Please try again in a moment.';
  if (/future|daily date|invalid date/.test(text)) return 'Choose an available daily challenge date.';
  if (source.status === 429 || /rate.limit|too many/.test(text)) return 'Too many attempts. Please wait a moment and try again.';
  if (source.status === 401 || /jwt|refresh token|session.*(?:expired|missing)|sign in|not authenticated/.test(text)) return 'Your session expired. Refresh and sign in again.';
  if (/incoming_request|already sent you a request/.test(text)) return 'This player already sent you a request. Accept it from your incoming requests.';
  if (/already friends|already.*(?:request|pending)|request.*already/.test(text)) return 'You already have a friendship or pending request with this player.';
  if (/yourself|own friend code|self.*friend/.test(text)) return 'Use another player’s friend code.';
  if (/friend_not_found|friend.*not found|no.*profile|no player.*friend code|unknown.*friend|friend code.*(?:invalid|not found)/.test(text)) return 'That friend code wasn’t found. Check it and try again.';
  if (/request.*(?:not found|unavailable|no longer)|no.*request/.test(text)) return 'That friend request is no longer available. Refresh your friends list.';
  if (/display.name|nickname/.test(text)) return 'Choose a display name between 2 and 24 characters.';
  if (/board|grid|givens|segment|solution|fixed clues/.test(text)) return 'The grid isn’t complete or breaks a rule. Check it and try again.';
  if (/not started|start.*(?:first|before saving)/.test(text)) return 'Start the daily challenge before entering your answers.';
  if (source.code === '42501' || /permission denied|access denied/.test(text)) return 'You don’t have access to this action. Refresh and sign in again.';
  return 'Something went wrong. Please try again.';
}

/** Guest identity is shared with competitions; constructing this API never signs anyone in. */
export function createDailyApi(client: SupabaseClient | null, identify: () => Promise<string> = getUserId) {
  function service() { if (!client) throw new DailyApiError('Daily challenges are not configured yet. You can keep playing solo.'); return client; }
  async function unwrap(data: unknown, error: unknown): Promise<unknown> {
    if (error) {
      if (typeof error === 'object' && 'context' in error && error.context instanceof Response) {
        try {
          const body = await error.context.clone().json() as { error?: unknown; message?: unknown; code?: unknown };
          throw new DailyApiError(explainDailyError({ message: body.error ?? body.message, code: body.code, status: error.context.status }));
        } catch (decoded) {
          if (decoded instanceof DailyApiError) throw decoded;
          throw new DailyApiError(explainDailyError({ status: error.context.status }));
        }
      }
      throw new DailyApiError(explainDailyError(error));
    }
    if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') {
      throw new DailyApiError(explainDailyError({ message: data.error, code: 'code' in data ? data.code : undefined }));
    }
    return data;
  }
  async function rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const api = service(); await identify();
    const request = api.rpc(name, args);
    const { data, error } = await (signal ? request.abortSignal(signal) : request);
    return unwrap(data, error);
  }
  async function getDailyState(signal?: AbortSignal): Promise<DailyState> {
    const api = service(); await identify();
    const { data, error } = await api.functions.invoke('numora-daily', { body: {}, ...(signal ? { signal } : {}) });
    return parseDailyState(await unwrap(data, error));
  }
  async function startDaily(): Promise<DailyState> { return parseDailyState(await rpc('numora_start_daily', {})); }
  async function getDailyStreaks(date: string, signal?: AbortSignal): Promise<DailyStreaks> {
    const expectedDate = normalizeDailyDate(date);
    return parseDailyStreaks(await rpc('numora_daily_streaks', {}, signal), expectedDate);
  }
  function boardArgs(date: string, values: number[], notes: number[][]) {
    const day = normalizeDailyDate(date), progress = normalizeProgress(values, notes);
    if (progress.values.length !== 36) throw new DailyInputError('The daily grid must contain 36 cells. Refresh to restore it.');
    return { p_date: day, p_values: progress.values, p_notes: progress.notes };
  }
  async function saveDaily(date: string, values: number[], notes: number[][]): Promise<DailyState> { return parseDailyState(await rpc('numora_save_daily', boardArgs(date, values, notes))); }
  async function submitDaily(date: string, values: number[], notes: number[][]): Promise<DailyState> { return parseDailyState(await rpc('numora_submit_daily', boardArgs(date, values, notes))); }
  async function getDailyLeaderboard(date: string, scope: LeaderboardScope = 'global', signal?: AbortSignal): Promise<DailyLeaderboard> {
    const day = normalizeDailyDate(date);
    if (scope !== 'global' && scope !== 'friends') throw new DailyInputError('Choose the global or friends leaderboard.');
    return parseDailyLeaderboard(await rpc('numora_daily_leaderboard', { p_date: day, p_scope: scope }, signal), day, scope);
  }
  async function getFriends(): Promise<FriendsState> { return parseFriendsState(await rpc('numora_get_friends', {})); }
  async function requestFriend(code: string): Promise<FriendsState> { return parseFriendsState(await rpc('numora_request_friend', { p_friend_code: normalizeFriendCode(code) })); }
  function uuid(value: string) {
    const id = value.trim().toLowerCase();
    if (!isUuid(id)) throw new DailyInputError('Choose a player or request from your friends list.');
    return id;
  }
  async function respondFriend(id: string, accept: boolean): Promise<FriendsState> {
    if (typeof accept !== 'boolean') throw new DailyInputError('Choose whether to accept this friend request.');
    return parseFriendsState(await rpc('numora_respond_friend', { p_request_id: uuid(id), p_accept: accept }));
  }
  async function removeFriend(id: string): Promise<FriendsState> { return parseFriendsState(await rpc('numora_remove_friend', { p_user_id: uuid(id) })); }
  async function cancelFriendRequest(id: string): Promise<FriendsState> { return parseFriendsState(await rpc('numora_cancel_friend_request', { p_request_id: uuid(id) })); }
  async function updateProfile(name: string): Promise<Profile> { return parseProfile(await rpc('numora_update_profile', { p_display_name: normalizeDisplayName(name) })); }
  return { getDailyState, getDailyStreaks, startDaily, saveDaily, submitDaily, getDailyLeaderboard, getFriends, requestFriend, respondFriend, removeFriend, cancelFriendRequest, updateProfile };
}

export const { getDailyState, getDailyStreaks, startDaily, saveDaily, submitDaily, getDailyLeaderboard, getFriends, requestFriend, respondFriend, removeFriend, cancelFriendRequest, updateProfile } = createDailyApi(supabase);
