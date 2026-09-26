import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '@/features/auth/AuthProvider';
import { HeaderAuth } from '@/features/auth/components/HeaderAuth';

const { routerRefresh } = vi.hoisted(() => ({ routerRefresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: routerRefresh }),
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const meOk = () => jsonResponse(200, { user: { id: 'user-1', email: 'buyer@example.com' } });
const me401 = () =>
  jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.', fields: {} } });
const me503 = () =>
  jsonResponse(503, {
    error: { code: 'SERVICE_UNAVAILABLE', message: '일시적인 장애입니다.', fields: {} },
  });

function renderHeader() {
  render(
    <AuthProvider>
      <HeaderAuth />
    </AuthProvider>,
  );
}

describe('HeaderAuth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    routerRefresh.mockReset();
  });

  it('/me 401이면 로그인·회원가입 링크를 보여준다', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => me401()));
    renderHeader();

    await waitFor(() => expect(screen.getByRole('link', { name: '로그인' })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: '로그인' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: '회원가입' })).toHaveAttribute('href', '/signup');
  });

  it('/me 200이면 이메일과 로그아웃 버튼을 보여준다', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => meOk()));
    renderHeader();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '로그아웃' })).toBeInTheDocument(),
    );
    expect(screen.getByText('buyer@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '로그인' })).not.toBeInTheDocument();
  });

  it('/me 503은 비로그인이 아니라 확인 실패로 구분하고 재시도할 수 있다', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => me503())
      .mockImplementation(async () => meOk());
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderHeader();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('link', { name: '로그인' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '다시 시도' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '로그아웃' })).toBeInTheDocument(),
    );
  });

  it('로그아웃 204 성공 후 비로그인 상태로 바뀐다', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if ((init?.method ?? 'GET') === 'POST') return new Response(null, { status: 204 });
      return meOk();
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderHeader();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '로그아웃' })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: '로그아웃' }));

    await waitFor(() => expect(screen.getByRole('link', { name: '로그인' })).toBeInTheDocument());
    const logoutCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/logout'));
    expect(logoutCall).toBeDefined();
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('로그아웃 실패 시 인증 상태를 유지하고 재시도 안내를 보여준다', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return jsonResponse(503, {
          error: { code: 'SERVICE_UNAVAILABLE', message: '일시적인 장애입니다.', fields: {} },
        });
      }
      return meOk();
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderHeader();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '로그아웃' })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: '로그아웃' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('다시 시도'));
    // 상태는 유지된다.
    expect(screen.getByText('buyer@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '로그인' })).not.toBeInTheDocument();
  });
});
