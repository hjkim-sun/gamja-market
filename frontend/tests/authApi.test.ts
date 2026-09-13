import { afterEach, describe, expect, it, vi } from 'vitest';

import { login, logout, me, signup } from '@/lib/api/auth';
import { ApiError } from '@/types/auth';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(handler);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('auth API 클라이언트', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POST에 JSON Content-Type과 사용자 정의 헤더를 보낸다', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(201, { user: { id: 'user-1', email: 'buyer@example.com' } }),
    );

    const user = await signup({
      email: 'buyer@example.com',
      password: 'potato-pass-123',
      password_confirmation: 'potato-pass-123',
    });

    expect(user).toEqual({ id: 'user-1', email: 'buyer@example.com' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/signup');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Requested-With': 'gamja-market',
    });
    expect(init.cache).toBe('no-store');
  });

  it('계약 오류 본문을 code·fields가 있는 ApiError로 변환한다', async () => {
    stubFetch(async () =>
      jsonResponse(422, {
        error: {
          code: 'PASSWORD_MISMATCH',
          message: '비밀번호가 일치하지 않습니다.',
          fields: { password_confirmation: '비밀번호가 일치하지 않습니다.' },
        },
      }),
    );

    const caught = await signup({
      email: 'buyer@example.com',
      password: 'potato-pass-123',
      password_confirmation: 'potato-pass-124',
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.code).toBe('PASSWORD_MISMATCH');
    expect(apiError.status).toBe(422);
    expect(apiError.fields.password_confirmation).toBe('비밀번호가 일치하지 않습니다.');
  });

  it('401 /me는 UNAUTHENTICATED ApiError가 된다', async () => {
    stubFetch(async () =>
      jsonResponse(401, {
        error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.', fields: {} },
      }),
    );

    const caught = await me().catch((error: unknown) => error);
    expect((caught as ApiError).code).toBe('UNAUTHENTICATED');
  });

  it('통신 실패는 NETWORK_ERROR로 구분한다', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    const caught = await login({ email: 'buyer@example.com', password: 'potato-pass-123' }).catch(
      (error: unknown) => error,
    );
    expect((caught as ApiError).code).toBe('NETWORK_ERROR');
    expect((caught as ApiError).status).toBe(0);
  });

  it('로그아웃 204는 본문을 JSON으로 읽지 않는다', async () => {
    const jsonSpy = vi.fn();
    stubFetch(async () => {
      const response = new Response(null, { status: 204 });
      Object.defineProperty(response, 'json', { value: jsonSpy });
      return response;
    });

    await expect(logout()).resolves.toBeUndefined();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('본문이 없는 오류도 상태 코드로 code를 채운다', async () => {
    stubFetch(async () => new Response(null, { status: 503 }));

    const caught = await logout().catch((error: unknown) => error);
    expect((caught as ApiError).code).toBe('SERVICE_UNAVAILABLE');
  });
});
