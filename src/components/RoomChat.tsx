import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { LoaderCircle, MessageCircle, Send, X } from 'lucide-react';
import { explainError, getRoomChat, normalizeChatMessage, sendRoomMessage, type ChatMessage, type RoomChatState } from '../multiplayer/api';
import './room-chat.css';

interface RoomChatProps {
  roomId: string;
  roomCode: string;
  userId: string;
  active: boolean;
  refreshKey: number;
  onRoomUnavailable: (cause: unknown) => boolean;
}

/** Keep sub-millisecond server ordering when a read overlaps a successful send. */
function snapshotTime(timestamp: string): bigint {
  const extra = (/\.(\d+)/.exec(timestamp)?.[1] ?? '').slice(3, 9).padEnd(6, '0');
  return BigInt(Date.parse(timestamp)) * 1_000_000n + BigInt(extra);
}

function messageTime(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function RoomChat({ roomId, roomCode, userId, active, refreshKey, onRoomUnavailable }: RoomChatProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [sendError, setSendError] = useState('');
  const launcher = useRef<HTMLButtonElement>(null);
  const closeControl = useRef<HTMLButtonElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const opened = useRef(false);
  const openRef = useRef(open); openRef.current = open;
  const draftRef = useRef(draft); draftRef.current = draft;
  const nearBottom = useRef(true);
  const scrollRequested = useRef(false);
  const initialized = useRef(false);
  const seen = useRef(new Set<string>());
  const acceptedTime = useRef<bigint | null>(null);
  const sendInFlight = useRef(false);
  const pendingSend = useRef<{ clientId: string; body: string } | null>(null);
  const refresh = useRef<(force?: boolean) => void>(() => {});
  const latest = useRef({ roomId, userId, active, onRoomUnavailable });
  latest.current = { roomId, userId, active, onRoomUnavailable };

  const scrollToLatest = useCallback(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
    nearBottom.current = true;
    scrollRequested.current = false;
    setUnread(0);
  }, []);

  const accept = useCallback((next: RoomChatState, ownSend = false) => {
    if (next.room_id !== roomId) return;
    const timestamp = snapshotTime(next.server_now);
    if (acceptedTime.current !== null && timestamp < acceptedTime.current) return;
    acceptedTime.current = timestamp;
    const incoming = initialized.current ? next.messages.filter(message => !seen.current.has(message.id) && message.user_id !== userId).length : 0;
    if (ownSend || (openRef.current && nearBottom.current)) {
      scrollRequested.current = true;
      setUnread(0);
    } else if (incoming) setUnread(count => count + incoming);
    initialized.current = true;
    seen.current = new Set(next.messages.map(message => message.id));
    setMessages(next.messages);
    setLoaded(true);
    setLoadError('');
  }, [roomId, userId]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);

  useEffect(() => {
    const scope = ++generation.current;
    let stopped = false, inFlight = false, lastRequested = 0;
    let controller: AbortController | null = null;
    initialized.current = false;
    acceptedTime.current = null;
    seen.current = new Set();
    nearBottom.current = true;
    setMessages([]); setUnread(0); setLoaded(false); setLoadError(''); setSendError(''); setSyncing(false);
    sendInFlight.current = false; setSending(false);
    const current = () => !stopped && mounted.current && scope === generation.current && latest.current.active;
    const fetchMessages = async (force = false) => {
      if (!active || !current() || inFlight || (!force && Date.now() - lastRequested < 500)) return;
      inFlight = true;
      lastRequested = Date.now();
      const request = new AbortController();
      controller = request;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; request.abort(); }, 12_000);
      setSyncing(true);
      try {
        const next = await getRoomChat(roomCode, roomId, request.signal);
        if (current()) accept(next);
      } catch (cause) {
        if (current() && !latest.current.onRoomUnavailable(cause)) {
          setLoadError(timedOut ? 'Chat lost its connection. We’ll keep trying.' : explainError(cause));
        }
      } finally {
        clearTimeout(timeout);
        if (controller === request) controller = null;
        inFlight = false;
        if (current()) setSyncing(false);
      }
    };
    refresh.current = force => { void fetchMessages(force); };
    void fetchMessages(true);
    const interval = active ? setInterval(() => { void fetchMessages(); }, 3000) : null;
    return () => {
      stopped = true;
      controller?.abort();
      if (interval) clearInterval(interval);
      refresh.current = () => {};
    };
  }, [active, roomId, roomCode, userId, accept]);

  useEffect(() => { refresh.current(); }, [refreshKey]);

  // A different room or account must never inherit an unsent message or retry nonce.
  useEffect(() => { setDraft(''); draftRef.current = ''; pendingSend.current = null; }, [roomId, userId]);

  useLayoutEffect(() => {
    if (open) {
      if (!opened.current) {
        scrollRequested.current = true;
        if (composer.current && !composer.current.disabled) composer.current.focus();
        else closeControl.current?.focus();
      }
      if (scrollRequested.current) scrollToLatest();
    } else if (opened.current) launcher.current?.focus();
    opened.current = open;
  }, [open, messages, scrollToLatest]);

  const send = async () => {
    if (!active || sendInFlight.current) return;
    let body: string;
    try { body = normalizeChatMessage(draftRef.current); }
    catch (cause) { setSendError(explainError(cause)); return; }
    const attempt = pendingSend.current?.body === body ? pendingSend.current : { clientId: crypto.randomUUID(), body };
    pendingSend.current = attempt;
    const sentDraft = draftRef.current;
    const scope = generation.current;
    const current = () => mounted.current && scope === generation.current && latest.current.roomId === roomId && latest.current.userId === userId && latest.current.active;
    sendInFlight.current = true; setSending(true); setSendError('');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const next = await Promise.race([
        sendRoomMessage(roomCode, roomId, attempt.clientId, attempt.body),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Chat send timed out. Your message is kept; try sending it again.')), 12_000); }),
      ]);
      if (!current()) return;
      accept(next, true);
      if (draftRef.current === sentDraft) { setDraft(''); draftRef.current = ''; }
      if (pendingSend.current === attempt) pendingSend.current = null;
    } catch (cause) {
      if (current() && !latest.current.onRoomUnavailable(cause)) setSendError(explainError(cause));
    } finally {
      if (timeout) clearTimeout(timeout);
      if (current()) { sendInFlight.current = false; setSending(false); }
    }
  };

  const characterCount = Array.from(draft).length;
  const close = () => setOpen(false);
  return <div className="room-chat-widget">
    {!open && <button ref={launcher} className="room-chat-launcher" aria-controls={`${id}-panel`} aria-expanded={false} aria-label={`Room chat${unread ? `, ${unread} unread ${unread === 1 ? 'message' : 'messages'}` : ''}`} onClick={() => { scrollRequested.current = true; setUnread(0); setOpen(true); }}><MessageCircle size={20} /><span>Room chat</span>{unread > 0 && <span className="room-chat-unread" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}</button>}
    {open && <section id={`${id}-panel`} className="room-chat-panel" role="dialog" aria-labelledby={`${id}-title`} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
      <header className="room-chat-heading"><div><h2 id={`${id}-title`}><MessageCircle size={19} />Room chat</h2><p>{active ? `Room ${roomCode} · players and spectators` : 'Rejoin the room to chat'}</p></div><button ref={closeControl} className="icon-button" aria-label="Close room chat" onClick={close}><X size={20} /></button></header>
      <div className="room-chat-log" ref={log} role="log" aria-label="Room messages" aria-live="polite" aria-relevant="additions" aria-busy={!loaded && syncing} onScroll={() => {
        const element = log.current;
        if (!element) return;
        nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        if (nearBottom.current) setUnread(0);
      }}>
        {!active ? <p className="room-chat-empty">Rejoin this room to see and send messages.</p> : !loaded && !loadError ? <p className="room-chat-empty"><LoaderCircle className="spin" size={20} />Opening the conversation…</p> : messages.length ? messages.map(message => <article key={message.id} className={`room-chat-message ${message.user_id === userId ? 'is-own' : ''}`}><div><strong>{message.nickname}{message.user_id === userId && <span>you</span>}</strong><time dateTime={message.created_at}>{messageTime(message.created_at)}</time></div><p>{message.body}</p></article>) : loaded ? <p className="room-chat-empty">No messages yet. Say hello to the room.</p> : null}
      </div>
      {open && unread > 0 && <button className="room-chat-jump" onClick={scrollToLatest}><MessageCircle size={14} />{unread} new {unread === 1 ? 'message' : 'messages'}</button>}
      {active && loadError && <div className="room-chat-error" role="status"><p>{loadError}</p><button disabled={syncing} onClick={() => refresh.current(true)}>{syncing ? 'Reconnecting…' : 'Retry chat'}</button></div>}
      <form className="room-chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
        <label className="room-chat-input-label" htmlFor={`${id}-message`}>Message the room</label>
        <textarea ref={composer} id={`${id}-message`} value={draft} disabled={!active} rows={2} maxLength={1000} placeholder={active ? 'Say something to the room…' : 'Rejoin to send a message'} aria-describedby={`${id}-hint${sendError ? ` ${id}-send-error` : ''}`} onChange={event => { const value = Array.from(event.target.value).slice(0, 500).join(''); setDraft(value); draftRef.current = value; setSendError(''); }} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            void send();
          }
        }} />
        {sendError && <p id={`${id}-send-error`} className="room-chat-send-error" role="alert">{sendError} Your draft is kept.</p>}
        <div className="room-chat-compose-actions"><span id={`${id}-hint`}>Enter sends · Shift + Enter for a new line</span><span className="room-chat-count" aria-label={`${characterCount} of 500 characters`}>{characterCount}/500</span><button className="primary-button" type="submit" disabled={!active || sending || !draft.trim()} aria-label={sending ? 'Sending message' : 'Send message'}>{sending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}<span>{sending ? 'Sending…' : 'Send'}</span></button></div>
      </form>
      <p className="room-chat-retention">{messages.length === 100 ? 'Latest 100 messages. ' : ''}Chat clears when the room expires after 24 hours without activity.</p>
    </section>}
  </div>;
}
