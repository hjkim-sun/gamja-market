import { afterEach, describe, expect, it, vi } from 'vitest';

import * as applicationsApi from '@/lib/api/applications';
import { ApiError } from '@/types/api';

const requestId = '00000000-0000-4000-8000-000000000001';
const roomId = '00000000-0000-4000-8000-000000000002';
const applicationId = '00000000-0000-4000-8000-000000000003';
const application = {
  id: applicationId,
  requestId,
  seller: { id: 'seller-1', maskedEmail: 'se***@example.com' },
  offerPrice: 750_000,
  message: '박스와 구성품을 모두 보유하고 있습니다.',
  chatRoomId: roomId,
  createdAt: '2026-09-26T10:00:00+00:00',
};
const chatRoom = {
  id: roomId,
  applicationId,
  viewerRole: 'seller' as const,
  request: {
    id: requestId,
    title: '아이패드 프로를 구합니다',
    status: 'open' as const,
    priceMin: 600_000,
    priceMax: 800_000,
  },
  buyer: { id: 'buyer-1', maskedEmail: 'bu***@example.com' },
  seller: application.seller,
  offerPrice: application.offerPrice,
  applicationMessage: application.message,
  createdAt: application.createdAt,
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

describe('applications API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('지원 POST는 보안 헤더와 payload만 전송하고 201 응답을 파싱한다', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(201, { application, chatRoom }));
    const payload = { offerPrice: 750_000, message: application.message };

    await expect(applicationsApi.applyToRequest(requestId, payload)).resolves.toEqual({
      application,
      chatRoom,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/requests/${requestId}/applications`);
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'gamja-market',
      },
    });
    expect(JSON.parse(String(init.body))).toEqual(payload);
  });

  it.each([
    { application: { ...application, chatRoomId: 3 }, chatRoom },
    { application, chatRoom: { ...chatRoom, viewerRole: 'owner' } },
    { application, chatRoom: { ...chatRoom, seller: { id: 'seller-1' } } },
  ])('형태가 잘못된 성공 응답은 INTERNAL_ERROR다', async (body) => {
    stubFetch(async () => jsonResponse(201, body));
    const caught = await applicationsApi
      .applyToRequest(requestId, { offerPrice: 1, message: '유효한 메시지' })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('INTERNAL_ERROR');
  });

  it.each([
    [409, 'ALREADY_APPLIED'],
    [409, 'REQUEST_NOT_OPEN'],
    [403, 'SELF_APPLICATION_FORBIDDEN'],
  ])('알려진 오류 %s/%s를 보존한다', async (status, code) => {
    stubFetch(async () =>
      jsonResponse(status as number, {
        error: { code, message: '계약 오류', fields: {} },
      }),
    );
    const caught = await applicationsApi
      .applyToRequest(requestId, { offerPrice: 1, message: '유효한 메시지' })
      .catch((error: unknown) => error);
    expect((caught as ApiError).code).toBe(code);
    expect((caught as ApiError).status).toBe(status);
  });

  it('지원 422 fields와 network 오류를 보존하고 malformed 409는 auth 오류로 오인하지 않는다', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(422, {
        error: {
          code: 'VALIDATION_ERROR',
          message: '입력값을 확인해 주세요.',
          fields: { offerPrice: '제시가 오류', message: '메시지 오류' },
        },
      }),
    );
    const validation = await applicationsApi
      .applyToRequest(requestId, { offerPrice: -1, message: '한' })
      .catch((error: unknown) => error);
    expect((validation as ApiError).fields).toEqual({
      offerPrice: '제시가 오류',
      message: '메시지 오류',
    });

    fetchMock.mockImplementationOnce(async () => jsonResponse(409, { broken: true }));
    const malformed = await applicationsApi
      .applyToRequest(requestId, { offerPrice: 1, message: '유효한 메시지' })
      .catch((error: unknown) => error);
    expect((malformed as ApiError).code).toBe('INTERNAL_ERROR');
    expect((malformed as ApiError).code).not.toBe('EMAIL_ALREADY_EXISTS');

    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    const network = await applicationsApi
      .applyToRequest(requestId, { offerPrice: 1, message: '유효한 메시지' })
      .catch((error: unknown) => error);
    expect((network as ApiError).code).toBe('NETWORK_ERROR');
  });

  it.each(['owner', 'applicant', 'member', 'anonymous'] as const)(
    '목록은 cookie/baseUrl을 전달하고 %s 역할을 파싱한다',
    async (viewerRole) => {
      const fetchMock = stubFetch(async () =>
        jsonResponse(200, {
          viewerRole,
          applicantCount: 1,
          items: viewerRole === 'owner' || viewerRole === 'applicant' ? [application] : [],
        }),
      );
      const result = await applicationsApi.listApplications(requestId, {
        baseUrl: 'http://backend:8104',
        cookie: 'gamja_session=token',
      });
      expect(result.viewerRole).toBe(viewerRole);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `http://backend:8104/api/requests/${requestId}/applications`,
      );
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        method: 'GET',
        cache: 'no-store',
        headers: { Cookie: 'gamja_session=token' },
      });
    },
  );

  it('모르는 목록 역할은 INTERNAL_ERROR이고 채팅방 200/404/401을 구분한다', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, { viewerRole: 'admin', applicantCount: 0, items: [] }),
    );
    const invalidRole = await applicationsApi
      .listApplications(requestId)
      .catch((error: unknown) => error);
    expect((invalidRole as ApiError).code).toBe('INTERNAL_ERROR');

    fetchMock.mockImplementationOnce(async () => jsonResponse(200, chatRoom));
    await expect(applicationsApi.getChatRoom(roomId)).resolves.toEqual(chatRoom);
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(404, { error: { code: 'NOT_FOUND', message: '없음', fields: {} } }),
    );
    await expect(applicationsApi.getChatRoom(roomId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(401, {
        error: { code: 'UNAUTHENTICATED', message: '로그인 필요', fields: {} },
      }),
    );
    await expect(applicationsApi.getChatRoom(roomId)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
});
