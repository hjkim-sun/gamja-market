import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '@/features/auth/AuthProvider';
import { LoginForm } from '@/features/auth/components/LoginForm';

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const unauthenticated = () =>
  jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.', fields: {} } });

function setupFetch(...responses: Array<() => Response>) {
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockImplementation(async (input) => {
    if (String(input).endsWith('/api/auth/me')) return unauthenticated();
    const next = responses.shift();
    if (!next) throw new Error('예상하지 못한 요청');
    return next();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function submitCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => !String(call[0]).endsWith('/api/auth/me'));
}

async function renderForm() {
  render(
    <AuthProvider>
      <LoginForm />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: '로그인' })).toBeEnabled());
}

describe('LoginForm', () => {
  beforeEach(() => {
    replace.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('이메일·비밀번호 두 필드만 보내고 확인값을 보내지 않는다', async () => {
    const fetchMock = setupFetch(() =>
      jsonResponse(200, { user: { id: 'user-1', email: 'buyer@example.com' } }),
    );
    const user = userEvent.setup();
    await renderForm();

    await user.type(screen.getByLabelText('이메일'), 'buyer@example.com');
    await user.type(screen.getByLabelText('비밀번호'), 'potato-pass-123');
    await user.click(screen.getByRole('button', { name: '로그인' }));

    const calls = submitCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'buyer@example.com',
      password: 'potato-pass-123',
    });
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
  });

  it('401은 폼 상단에 같은 안내로 표시하고 비밀번호만 지운다', async () => {
    setupFetch(() =>
      jsonResponse(401, {
        error: {
          code: 'INVALID_CREDENTIALS',
          message: '이메일 또는 비밀번호를 확인해 주세요.',
          fields: {},
        },
      }),
    );
    const user = userEvent.setup();
    await renderForm();

    await user.type(screen.getByLabelText('이메일'), 'buyer@example.com');
    await user.type(screen.getByLabelText('비밀번호'), 'potato-pass-123');
    await user.click(screen.getByRole('button', { name: '로그인' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('이메일 또는 비밀번호를 확인해 주세요.'),
    );
    expect(screen.getByLabelText('이메일')).toHaveValue('buyer@example.com');
    expect(screen.getByLabelText('비밀번호')).toHaveValue('');
    expect(replace).not.toHaveBeenCalled();
  });

  it('클라이언트 검증 실패 시 요청을 보내지 않는다', async () => {
    const fetchMock = setupFetch();
    const user = userEvent.setup();
    await renderForm();

    await user.type(screen.getByLabelText('이메일'), 'not-an-email');
    await user.type(screen.getByLabelText('비밀번호'), 'short');
    await user.click(screen.getByRole('button', { name: '로그인' }));

    expect(submitCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByLabelText('이메일')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('비밀번호')).toHaveAttribute('aria-invalid', 'true');
  });
});
