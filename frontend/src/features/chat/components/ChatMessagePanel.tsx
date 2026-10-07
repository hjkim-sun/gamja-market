'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { ConfirmMatchButton } from '@/features/matching/components/ConfirmMatchButton';
import { listMessages, sendMessage } from '@/lib/api/chat';
import { formatDateTime } from '@/lib/format';
import { ApiError } from '@/types/api';
import type { ChatRoom, ChatStatus } from '@/types/application';
import type { ChatMessage, MessageList } from '@/types/chat';

/** 설계서 8장: 폴링 주기, 오류 백오프 상한, 바닥 근접 판정 픽셀. */
export const POLL_INTERVAL_MS = 3_000;
export const MAX_BACKOFF_MS = 30_000;
const NEAR_BOTTOM_PX = 120;
const MAX_BODY_LENGTH = 1_000;
const UNSTABLE_AFTER_FAILURES = 2;

interface ChatMessagePanelProps {
  room: ChatRoom;
  /** SSR로 받은 첫 메시지. null이면 첫 폴링이 afterSeq 없이 다시 시도한다(P1·P2). */
  initialList: MessageList | null;
}

interface PendingMessage {
  clientMessageId: string;
  body: string;
  state: 'sending' | 'failed';
}

interface RoomState {
  chatStatus: ChatStatus;
  canSend: boolean;
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

function backoffDelay(failures: number): number {
  return Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
}

export function ChatMessagePanel({ room, initialList }: ChatMessagePanelProps) {
  const router = useRouter();
  // 라우터 객체 정체성이 바뀌어도 폴링 effect가 재시작되지 않도록 ref로 쥔다.
  const routerRef = useRef(router);
  routerRef.current = router;
  const roomId = room.id;
  const loginHref = `/login?next=/chats/${roomId}`;

  const [messages, setMessages] = useState<ChatMessage[]>(initialList?.items ?? []);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(initialList?.hasOlder ?? false);
  const [roomState, setRoomState] = useState<RoomState>(
    initialList
      ? { chatStatus: initialList.room.chatStatus, canSend: initialList.room.canSend }
      : { chatStatus: room.chatStatus, canSend: room.canSend },
  );
  const [unstable, setUnstable] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [newBelow, setNewBelow] = useState(false);

  // D13: 커서는 폴링 결과로만 전진한다. 전송 응답으로는 건드리지 않는다.
  const lastSeqRef = useRef<number | undefined>(initialList ? initialList.latestSeq : undefined);
  const logRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const forceScrollRef = useRef(true);
  const previousCountRef = useRef(0);
  const mountedRef = useRef(false);
  const sendControllersRef = useRef<Set<AbortController>>(new Set());

  // router.refresh()로 서버가 새 방 상태를 내려주면(확정 직후 등) 로컬 상태를 맞춘다.
  useEffect(() => {
    setRoomState({ chatStatus: room.chatStatus, canSend: room.canSend });
  }, [room.chatStatus, room.canSend]);

  useEffect(() => {
    if (unavailable) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let activeId = 0;
    let failures = 0;

    function clearTimer() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }

    function cancelInFlight() {
      activeId += 1;
      controller?.abort();
      controller = null;
    }

    function schedule(delay: number) {
      clearTimer();
      if (stopped || document.visibilityState === 'hidden') return;
      timer = setTimeout(() => void poll(), delay);
    }

    async function poll() {
      clearTimer();
      if (stopped) return;
      cancelInFlight();
      const id = activeId;
      const current = new AbortController();
      controller = current;
      const afterSeq = lastSeqRef.current;

      try {
        const list = await listMessages(roomId, { afterSeq, signal: current.signal });
        if (stopped || id !== activeId) return;

        failures = 0;
        setUnstable(false);
        setRoomState({ chatStatus: list.room.chatStatus, canSend: list.room.canSend });
        if (afterSeq === undefined) setHasOlder(list.hasOlder);

        if (list.items.length > 0) {
          lastSeqRef.current = list.items[list.items.length - 1].seq;
          setMessages((currentMessages) => mergeMessages(currentMessages, list.items));
          const confirmed = new Set(list.items.filter((item) => item.isMine).map((item) => item.clientMessageId));
          if (confirmed.size > 0) {
            setPending((currentPending) =>
              currentPending.filter((item) => !confirmed.has(item.clientMessageId)),
            );
          }
        } else if (afterSeq === undefined) {
          lastSeqRef.current = list.latestSeq;
        }

        schedule(list.hasMore ? 0 : POLL_INTERVAL_MS);
      } catch (caught) {
        if (stopped || id !== activeId || current.signal.aborted) return;

        if (caught instanceof ApiError && caught.code === 'UNAUTHENTICATED') {
          stopped = true;
          routerRef.current.push(loginHref);
          return;
        }
        if (caught instanceof ApiError && caught.code === 'NOT_FOUND') {
          stopped = true;
          setUnavailable(true);
          return;
        }

        failures += 1;
        if (failures >= UNSTABLE_AFTER_FAILURES) setUnstable(true);
        schedule(backoffDelay(failures));
      }
    }

    function handleVisibility() {
      if (stopped) return;
      if (document.visibilityState === 'hidden') {
        clearTimer();
        cancelInFlight();
      } else {
        void poll();
      }
    }

    document.addEventListener('visibilitychange', handleVisibility);
    // SSR 메시지가 없으면 바로 다시 시도하고, 있으면 한 주기 뒤에 첫 폴링을 한다.
    if (lastSeqRef.current === undefined) void poll();
    else schedule(POLL_INTERVAL_MS);

    return () => {
      stopped = true;
      clearTimer();
      cancelInFlight();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [roomId, loginHref, unavailable]);

  useEffect(() => {
    mountedRef.current = true;
    const controllers = sendControllersRef.current;
    return () => {
      mountedRef.current = false;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, []);

  const scrollToBottom = useCallback(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
    nearBottomRef.current = true;
    setNewBelow(false);
  }, []);

  useEffect(() => {
    const count = messages.length + pending.length;
    const grew = count > previousCountRef.current;
    previousCountRef.current = count;
    if (!grew) return;

    if (forceScrollRef.current || nearBottomRef.current) {
      forceScrollRef.current = false;
      scrollToBottom();
    } else {
      setNewBelow(true);
    }
  }, [messages.length, pending.length, scrollToBottom]);

  function handleScroll() {
    const log = logRef.current;
    if (!log) return;
    nearBottomRef.current = log.scrollHeight - log.scrollTop - log.clientHeight <= NEAR_BOTTOM_PX;
    if (nearBottomRef.current) setNewBelow(false);
  }

  const dispatchSend = useCallback(
    async (clientMessageId: string, body: string) => {
      const controller = new AbortController();
      sendControllersRef.current.add(controller);

      try {
        const result = await sendMessage(roomId, { clientMessageId, body }, controller.signal);
        if (!mountedRef.current) return;
        // D13: 커서(lastSeqRef)는 올리지 않는다. 같은 id가 폴링으로 오면 Map 병합이 중복을 막는다.
        setPending((current) => current.filter((item) => item.clientMessageId !== clientMessageId));
        setMessages((current) => mergeMessages(current, [result.message]));
      } catch (caught) {
        if (!mountedRef.current || controller.signal.aborted) return;

        if (caught instanceof ApiError && caught.code === 'CHAT_ROOM_CLOSED') {
          setPending((current) => current.filter((item) => item.clientMessageId !== clientMessageId));
          setRoomState({ chatStatus: 'closed', canSend: false });
        } else if (caught instanceof ApiError && caught.code === 'VALIDATION_ERROR') {
          setPending((current) => current.filter((item) => item.clientMessageId !== clientMessageId));
          setSendError(caught.fields.body ?? '메시지는 1자 이상 1000자 이하로 입력해 주세요.');
          setDraft((current) => (current ? current : body));
        } else if (caught instanceof ApiError && caught.code === 'UNAUTHENTICATED') {
          routerRef.current.push(loginHref);
        } else if (caught instanceof ApiError && caught.code === 'NOT_FOUND') {
          setUnavailable(true);
        } else {
          setPending((current) =>
            current.map((item) =>
              item.clientMessageId === clientMessageId ? { ...item, state: 'failed' } : item,
            ),
          );
        }
      } finally {
        sendControllersRef.current.delete(controller);
      }
    },
    [roomId, loginHref],
  );

  const canSend = roomState.canSend && !unavailable;
  const trimmed = draft.trim();

  function submitDraft() {
    if (!canSend || trimmed.length === 0) return;
    const clientMessageId = crypto.randomUUID();
    forceScrollRef.current = true;
    setSendError(null);
    setDraft('');
    setPending((current) => [...current, { clientMessageId, body: trimmed, state: 'sending' }]);
    void dispatchSend(clientMessageId, trimmed);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitDraft();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // IME 조합 중 Enter는 글자 확정이므로 전송하지 않는다.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submitDraft();
  }

  function retry(item: PendingMessage) {
    setPending((current) =>
      current.map((entry) =>
        entry.clientMessageId === item.clientMessageId ? { ...entry, state: 'sending' } : entry,
      ),
    );
    // P15: 같은 clientMessageId로 다시 보내 서버 멱등 처리에 맡긴다.
    void dispatchSend(item.clientMessageId, item.body);
  }

  const { chatStatus } = roomState;
  const isBuyer = room.viewerRole === 'buyer';
  const empty = messages.length === 0 && pending.length === 0;

  return (
    <section className="mt-6" aria-label="채팅 메시지">
      {unavailable ? (
        <p className="mb-3 rounded-xl bg-stone-100 px-4 py-3 text-sm font-bold text-stone-700" role="alert">
          채팅방을 볼 수 없어요.
        </p>
      ) : chatStatus === 'matched' ? (
        <p className="mb-3 rounded-xl bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700" role="status">
          매칭이 확정된 채팅방이에요. 거래 일정을 이야기해 보세요.
        </p>
      ) : chatStatus === 'closed' ? (
        <p className="mb-3 rounded-xl bg-stone-100 px-4 py-3 text-sm font-bold text-stone-700" role="status">
          {isBuyer
            ? '이 지원은 마감되었어요.'
            : '다른 판매자와 매칭되어 마감된 채팅방이에요. 이전 대화만 볼 수 있어요.'}
        </p>
      ) : null}

      {isBuyer && chatStatus === 'active' && !unavailable ? (
        <ConfirmMatchButton requestId={room.request.id} applicationId={room.applicationId} className="mb-3" />
      ) : null}

      {unstable ? (
        <p className="mb-3 rounded-xl bg-potato-50 px-4 py-3 text-sm font-semibold text-potato-700" role="status">
          연결이 불안정해요. 자동으로 다시 시도합니다.
        </p>
      ) : null}

      <div className="relative">
        <div
          ref={logRef}
          onScroll={handleScroll}
          role="log"
          aria-live="polite"
          aria-label="메시지 목록"
          className="max-h-[60vh] min-h-48 space-y-3 overflow-y-auto rounded-2xl border border-stone-200 bg-white p-4"
        >
          {hasOlder ? (
            <p className="text-center text-xs text-stone-400">이전 메시지 일부는 표시되지 않아요.</p>
          ) : null}
          {empty ? (
            <p className="py-10 text-center text-sm text-stone-500">
              아직 메시지가 없어요. 첫 메시지를 보내 보세요.
            </p>
          ) : null}
          {messages.map((message) => (
            <div key={message.id} className={`flex ${message.isMine ? 'justify-end' : 'justify-start'}`}>
              <div className="max-w-[80%]">
                <p
                  className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-6 ${
                    message.isMine ? 'bg-potato-200 text-stone-900' : 'bg-stone-100 text-stone-800'
                  }`}
                >
                  {message.body}
                </p>
                <time
                  dateTime={message.createdAt}
                  className={`mt-1 block text-xs text-stone-400 ${message.isMine ? 'text-right' : ''}`}
                  suppressHydrationWarning
                >
                  {formatDateTime(message.createdAt)}
                </time>
              </div>
            </div>
          ))}
          {pending.map((item) => (
            <div key={item.clientMessageId} className="flex justify-end">
              <div className="max-w-[80%]">
                <p className="whitespace-pre-wrap break-words rounded-2xl bg-potato-100 px-4 py-2.5 text-sm leading-6 text-stone-700">
                  {item.body}
                </p>
                {item.state === 'sending' ? (
                  <p className="mt-1 text-right text-xs text-stone-400">전송 중…</p>
                ) : (
                  <p className="mt-1 text-right text-xs font-semibold text-red-600">
                    전송 실패 ·{' '}
                    <button type="button" className="underline" onClick={() => retry(item)}>
                      다시 시도
                    </button>
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
        {newBelow ? (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-stone-900 px-4 py-2 text-xs font-bold text-white shadow-lg"
          >
            새 메시지 ↓
          </button>
        ) : null}
      </div>

      <form onSubmit={handleSubmit} className="sticky bottom-0 mt-3 bg-[#fbfaf7] pb-2 pt-1" noValidate>
        <label htmlFor="chat-message-input" className="sr-only">
          메시지 입력
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id="chat-message-input"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (sendError) setSendError(null);
            }}
            onKeyDown={handleKeyDown}
            maxLength={MAX_BODY_LENGTH}
            rows={2}
            disabled={!canSend}
            placeholder={canSend ? '메시지를 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)' : ''}
            aria-invalid={sendError ? true : undefined}
            aria-describedby={sendError ? 'chat-message-error' : undefined}
            className="min-h-11 flex-1 resize-none rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-800 outline-none placeholder:text-stone-400 focus:border-potato-400 focus:ring-2 focus:ring-potato-200 disabled:bg-stone-100"
          />
          <Button type="submit" disabled={!canSend || trimmed.length === 0}>
            보내기
          </Button>
        </div>
        <div className="mt-1 flex items-center justify-between gap-3 text-xs">
          <span>
            {sendError ? (
              <span id="chat-message-error" className="font-semibold text-red-600" role="alert">
                {sendError}
              </span>
            ) : !canSend ? (
              <span className="text-stone-500">
                {unavailable ? '채팅방을 볼 수 없어 메시지를 보낼 수 없어요.' : '마감된 채팅방에서는 메시지를 보낼 수 없어요.'}
              </span>
            ) : null}
          </span>
          <span className="text-stone-400">
            {draft.length}/{MAX_BODY_LENGTH}
          </span>
        </div>
      </form>
    </section>
  );
}
