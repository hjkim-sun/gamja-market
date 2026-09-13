import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/features/auth/AuthProvider';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function Probe() {
  const { status, user, login } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="email">{user?.email ?? '-'}</span>
      <button
        type="button"
        onClick={() => {
          void login({ email: 'buyer@example.com', password: 'potato-pass-123' }).catch(() => {});
        }}
      >
        로그인 실행
      </button>
    </div>
  );
}

describe('AuthProvider 상태 전이', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('지연된 /me 401 응답이 로그인 성공 상태를 되돌리지 않는다', async () => {
    let resolveMe: ((response: Response) => void) | undefined;

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        // 복원 응답을 의도적으로 지연시킨다.
        return new Promise<Response>((resolve) => {
          resolveMe = resolve;
        });
      }
      if (url.endsWith('/api/auth/login') && (init?.method ?? 'GET') === 'POST') {
        return jsonResponse(200, { user: { id: 'user-1', email: 'buyer@example.com' } });
      }
      throw new Error(`예상하지 못한 요청: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    expect(screen.getByTestId('status')).toHaveTextContent('loading');

    await user.click(screen.getByRole('button', { name: '로그인 실행' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    // 이제서야 도착한 오래된 /me 401은 무시되어야 한다.
    resolveMe?.(
      jsonResponse(401, {
        error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.', fields: {} },
      }),
    );

    await Promise.resolve();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('email')).toHaveTextContent('buyer@example.com');
  });

  it('로그인 실패는 기존 인증 상태를 덮어쓰지 않는다', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse(200, { user: { id: 'user-1', email: 'buyer@example.com' } });
      }
      if (url.endsWith('/api/auth/login') && (init?.method ?? 'GET') === 'POST') {
        return jsonResponse(401, {
          error: {
            code: 'INVALID_CREDENTIALS',
            message: '이메일 또는 비밀번호를 확인해 주세요.',
            fields: {},
          },
        });
      }
      throw new Error(`예상하지 못한 요청: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    await user.click(screen.getByRole('button', { name: '로그인 실행' }));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('email')).toHaveTextContent('buyer@example.com');
  });

  it('GET /me 요청에는 cache no-store와 same-origin 자격증명을 사용한다', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse(401, {
        error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.', fields: {} },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/me');
    expect(init.cache).toBe('no-store');
    expect(init.credentials).toBe('same-origin');
  });
});
