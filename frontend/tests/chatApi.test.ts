import { afterEach, describe, expect, it, vi } from 'vitest';

import { listChatRooms, listMessages, sendMessage } from '@/lib/api/chat';
import { ApiError } from '@/types/api';

const roomId = '00000000-0000-4000-8000-000000000002';
const clientMessageId = '00000000-0000-4000-8000-0000000000aa';

const message = {
  id: '00000000-0000-4000-8000-0000000000bb',
  seq: 12,
  senderRole: 'seller' as const,
  isMine: false,
  body: '직거래 가능하신가요?',
  clientMessageId,
  createdAt: '2026-10-07T10:00:00.000000Z',
};
const roomState = {
  id: roomId,
  chatStatus: 'active' as const,
  canSend: true,
  applicationStatus: 'pending' as const,
  requestStatus: 'open' as const,
};
const messageList = { room: roomState, items: [message], latestSeq: 12, hasMore: false, hasOlder: false };
const roomListItem = {
  id: roomId,
  viewerRole: 'buyer' as const,
  chatStatus: 'active' as const,
  request: { id: 'request-1', title: '아이패드 프로를 구합니다', status: 'open' as const },
  counterpart: { id: 'user-2', maskedEmail: 'se***@example.com' },
  lastMessage: { body: '안녕하세요', senderRole: 'seller' as const, createdAt: '2026-10-07T10:00:00Z' },
  lastActivityAt: '2026-10-07T10:00:00Z',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn<typeof fetch>().mockImplementation(handler);
  vi.stubGlobal('fetch', mock);
  return mock;
}

function errorBody(code: string, fields: Record<string, string> = {}) {
  return { error: { code, message: '계약 오류', fields } };
}

describe('chat API', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('listMessages', () => {
    it('쿼리 없이 GET하고 cookie/baseUrl을 전달하며 응답을 파싱한다', async () => {
      const fetchMock = stubFetch(async () => jsonResponse(200, messageList));
      const result = await listMessages(roomId, { baseUrl: 'http://backend:8104', cookie: 'gamja_session=token' });

      expect(result).toEqual(messageList);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`http://backend:8104/api/chat-rooms/${roomId}/messages`);
      expect(init).toMatchObject({
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Cookie: 'gamja_session=token' },
      });
    });

    it('afterSeq와 limit는 값이 있을 때만 쿼리에 넣는다(0 포함)', async () => {
      const fetchMock = stubFetch(async () => jsonResponse(200, messageList));

      await listMessages(roomId, { afterSeq: 0, limit: 100 });
      await listMessages(roomId, { afterSeq: 7 });
      await listMessages(roomId, { limit: 100 });
      await listMessages(roomId);

      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        `/api/chat-rooms/${roomId}/messages?afterSeq=0&limit=100`,
        `/api/chat-rooms/${roomId}/messages?afterSeq=7`,
        `/api/chat-rooms/${roomId}/messages?limit=100`,
        `/api/chat-rooms/${roomId}/messages`,
      ]);
    });

    it('signal을 fetch에 전달한다', async () => {
      const fetchMock = stubFetch(async () => jsonResponse(200, messageList));
      const controller = new AbortController();
      await listMessages(roomId, { signal: controller.signal });
      expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
    });

    it.each([
      { ...messageList, room: { ...roomState, chatStatus: 'archived' } },
      { ...messageList, room: { ...roomState, canSend: 'yes' } },
      { ...messageList, room: { ...roomState, requestStatus: 'gone' } },
      { ...messageList, items: [{ ...message, senderRole: 'admin' }] },
      { ...messageList, items: [{ ...message, seq: '12' }] },
      { ...messageList, items: [{ ...message, isMine: 1 }] },
      { ...messageList, items: [{ ...message, clientMessageId: undefined }] },
      { ...messageList, items: 'none' },
      { ...messageList, latestSeq: '12' },
      { ...messageList, hasMore: undefined },
      { ...messageList, hasOlder: null },
      null,
    ])('형태가 잘못된 성공 응답은 INTERNAL_ERROR다', async (body) => {
      stubFetch(async () => jsonResponse(200, body));
      await expect(listMessages(roomId)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    });

    it('JSON이 아닌 성공 응답은 INTERNAL_ERROR다', async () => {
      stubFetch(async () => new Response('<html>', { status: 200 }));
      await expect(listMessages(roomId)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    });

    it.each([
      [401, 'UNAUTHENTICATED'],
      [404, 'NOT_FOUND'],
      [422, 'VALIDATION_ERROR'],
      [503, 'SERVICE_UNAVAILABLE'],
    ])('%s 오류 code를 전달한다', async (status, code) => {
      stubFetch(async () => jsonResponse(status, errorBody(code)));
      const caught = await listMessages(roomId).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe(code);
      expect((caught as ApiError).status).toBe(status);
    });

    it('통신 실패는 NETWORK_ERROR다', async () => {
      stubFetch(async () => {
        throw new TypeError('Failed to fetch');
      });
      await expect(listMessages(roomId)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    });
  });

  describe('sendMessage', () => {
    it('보안 헤더와 clientMessageId·body만 POST하고 201을 created=true로 돌려준다', async () => {
      const fetchMock = stubFetch(async () => jsonResponse(201, { message: { ...message, isMine: true } }));
      const result = await sendMessage(roomId, { clientMessageId, body: message.body });

      expect(result).toEqual({ message: { ...message, isMine: true }, created: true });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`/api/chat-rooms/${roomId}/messages`);
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'gamja-market' },
      });
      expect(JSON.parse(String(init.body))).toEqual({ clientMessageId, body: message.body });
    });

    it('멱등 재전송 200은 성공이며 created=false다', async () => {
      stubFetch(async () => jsonResponse(200, { message }));
      await expect(sendMessage(roomId, { clientMessageId, body: message.body })).resolves.toEqual({
        message,
        created: false,
      });
    });

    it.each([{ message: { ...message, seq: undefined } }, { message: null }, {}, null])(
      '형태가 잘못된 성공 응답은 INTERNAL_ERROR다',
      async (body) => {
        stubFetch(async () => jsonResponse(201, body));
        await expect(sendMessage(roomId, { clientMessageId, body: 'x' })).rejects.toMatchObject({
          code: 'INTERNAL_ERROR',
        });
      },
    );

    it('CHAT_ROOM_CLOSED 409와 422 body 필드 메시지를 전달한다', async () => {
      const fetchMock = stubFetch(async () => jsonResponse(409, errorBody('CHAT_ROOM_CLOSED')));
      await expect(sendMessage(roomId, { clientMessageId, body: 'x' })).rejects.toMatchObject({
        code: 'CHAT_ROOM_CLOSED',
        status: 409,
      });

      fetchMock.mockImplementationOnce(async () =>
        jsonResponse(422, errorBody('VALIDATION_ERROR', { body: '메시지는 1자 이상 1000자 이하로 입력해 주세요.', extra: '무시' })),
      );
      const validation = await sendMessage(roomId, { clientMessageId, body: ' ' }).catch(
        (error: unknown) => error,
      );
      expect((validation as ApiError).fields).toEqual({ body: '메시지는 1자 이상 1000자 이하로 입력해 주세요.' });
    });

    it('깨진 409 본문은 auth 오류로 오인하지 않고 INTERNAL_ERROR로 바꾼다', async () => {
      stubFetch(async () => jsonResponse(409, { broken: true }));
      const caught = await sendMessage(roomId, { clientMessageId, body: 'x' }).catch((error: unknown) => error);
      expect((caught as ApiError).code).toBe('INTERNAL_ERROR');
    });

    it('통신 실패는 NETWORK_ERROR다', async () => {
      stubFetch(async () => {
        throw new TypeError('Failed to fetch');
      });
      await expect(sendMessage(roomId, { clientMessageId, body: 'x' })).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
      });
    });
  });

  describe('listChatRooms', () => {
    it('GET /api/chat-rooms를 호출하고 lastMessage null도 파싱한다', async () => {
      const list = { items: [roomListItem, { ...roomListItem, id: 'room-2', lastMessage: null }], hasMore: false };
      const fetchMock = stubFetch(async () => jsonResponse(200, list));
      const result = await listChatRooms({ baseUrl: 'http://backend:8104', cookie: 'gamja_session=token' });

      expect(result).toEqual(list);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://backend:8104/api/chat-rooms');
      expect(init).toMatchObject({ method: 'GET', cache: 'no-store', headers: { Cookie: 'gamja_session=token' } });
    });

    it.each([
      { items: [{ ...roomListItem, viewerRole: 'admin' }], hasMore: false },
      { items: [{ ...roomListItem, chatStatus: 'x' }], hasMore: false },
      { items: [{ ...roomListItem, counterpart: { id: 'u' } }], hasMore: false },
      { items: [{ ...roomListItem, request: { id: 'r', title: 't' } }], hasMore: false },
      { items: [{ ...roomListItem, lastMessage: { body: 1 } }], hasMore: false },
      { items: [{ ...roomListItem, lastActivityAt: undefined }], hasMore: false },
      { items: [roomListItem] },
      { items: 'none', hasMore: false },
    ])('형태가 잘못된 응답은 INTERNAL_ERROR다', async (body) => {
      stubFetch(async () => jsonResponse(200, body));
      await expect(listChatRooms()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    });

    it('401을 UNAUTHENTICATED로 전달한다', async () => {
      stubFetch(async () => jsonResponse(401, errorBody('UNAUTHENTICATED')));
      await expect(listChatRooms()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    });
  });
});
