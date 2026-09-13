import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '@/features/auth/AuthProvider';
import { SignupForm } from '@/features/auth/components/SignupForm';

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

function unauthenticated(): Response {
  return jsonResponse(401, {
    error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.', fields: {} },
  });
}

/** /me 복원 호출을 먼저 소화한 뒤 테스트가 검사하는 제출 호출만 남긴다. */
function setupFetch(...responses: Array<() => Response>) {
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith('/api/auth/me')) return unauthenticated();
    const next = responses.shift();
    if (!next) throw new Error(`예상하지 못한 요청: ${url}`);
    return next();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** /api/auth/me 를 제외한 실제 제출 호출만 센다. */
function submitCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => !String(call[0]).endsWith('/api/auth/me'));
}

async function renderForm() {
  render(
    <AuthProvider>
      <SignupForm />
    </AuthProvider>,
  );
  // 초기 /me 복원이 끝나 anonymous가 되기를 기다린다.
  await waitFor(() => expect(screen.getByRole('button', { name: '회원가입' })).toBeEnabled());
}

const emailInput = () => screen.getByLabelText('이메일');
const passwordInput = () => screen.getByLabelText('비밀번호');
const confirmationInput = () => screen.getByLabelText('비밀번호 확인');
const submitButton = () => screen.getByRole('button', { name: '회원가입' });

describe('SignupForm 비밀번호 확인', () => {
  beforeEach(() => {
    replace.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('두 비밀번호가 다르면 요청을 보내지 않고 확인 필드에 오류를 표시한다', async () => {
    const fetchMock = setupFetch();
    const user = userEvent.setup();
    await renderForm();

    await user.type(emailInput(), 'buyer@example.com');
    await user.type(passwordInput(), 'potato-pass-123');
    await user.type(confirmationInput(), 'potato-pass-124');
    await user.click(submitButton());

    // 가입 API는 호출되지 않는다.
    expect(submitCalls(fetchMock)).toHaveLength(0);

    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('비밀번호가 일치하지 않습니다.');
    expect(confirmationInput()).toHaveAttribute('aria-invalid', 'true');
    expect(confirmationInput()).toHaveAttribute('aria-describedby', error.id);
    // 첫 오류 필드로 초점이 이동한다.
    expect(confirmationInput()).toHaveFocus();
    // 수정할 수 있도록 입력값을 유지한다.
    expect(passwordInput()).toHaveValue('potato-pass-123');
  });

  it('확인값이 비어 있으면 요청을 보내지 않는다', async () => {
    const fetchMock = setupFetch();
    const user = userEvent.setup();
    await renderForm();

    await user.type(emailInput(), 'buyer@example.com');
    await user.type(passwordInput(), 'potato-pass-123');
    await user.click(submitButton());

    expect(submitCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByRole('alert')).toHaveTextContent('비밀번호 확인');
  });

  it('확인 필드를 수정해 일치하면 오류가 해제되고 세 필드로 한 번만 요청한다', async () => {
    const fetchMock = setupFetch(() =>
      jsonResponse(201, { user: { id: 'user-1', email: 'buyer@example.com' } }),
    );
    const user = userEvent.setup();
    await renderForm();

    await user.type(emailInput(), 'buyer@example.com');
    await user.type(passwordInput(), 'potato-pass-123');
    await user.type(confirmationInput(), 'potato-pass-124');
    await user.click(submitButton());
    expect(screen.getByRole('alert')).toHaveTextContent('비밀번호가 일치하지 않습니다.');

    // 확인값을 고쳐 일치시키면 오류가 사라진다.
    await user.clear(confirmationInput());
    await user.type(confirmationInput(), 'potato-pass-123');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(confirmationInput()).toHaveAttribute('aria-invalid', 'false');

    await user.click(submitButton());

    const calls = submitCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/signup');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'buyer@example.com',
      password: 'potato-pass-123',
      password_confirmation: 'potato-pass-123',
    });
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
  });

  it('비밀번호 쪽을 수정해 일치하면 오류가 해제된다', async () => {
    setupFetch();
    const user = userEvent.setup();
    await renderForm();

    await user.type(emailInput(), 'buyer@example.com');
    await user.type(passwordInput(), 'potato-pass-123');
    await user.type(confirmationInput(), 'potato-pass-124');
    await user.click(submitButton());
    expect(screen.getByRole('alert')).toHaveTextContent('비밀번호가 일치하지 않습니다.');

    await user.clear(passwordInput());
    await user.type(passwordInput(), 'potato-pass-124');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('서버 422 PASSWORD_MISMATCH를 확인 필드에 표시하고 재시도할 수 있다', async () => {
    const fetchMock = setupFetch(
      () =>
        jsonResponse(422, {
          error: {
            code: 'PASSWORD_MISMATCH',
            message: '비밀번호가 일치하지 않습니다.',
            fields: { password_confirmation: '비밀번호가 일치하지 않습니다.' },
          },
        }),
      () => jsonResponse(201, { user: { id: 'user-1', email: 'buyer@example.com' } }),
    );
    const user = userEvent.setup();
    await renderForm();

    await user.type(emailInput(), 'buyer@example.com');
    await user.type(passwordInput(), 'potato-pass-123');
    await user.type(confirmationInput(), 'potato-pass-123');
    await user.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('비밀번호가 일치하지 않습니다.'),
    );
    expect(confirmationInput()).toHaveAttribute('aria-invalid', 'true');
    // 실패 후 이메일은 유지하고 두 비밀번호는 지운다.
    expect(emailInput()).toHaveValue('buyer@example.com');
    expect(passwordInput()).toHaveValue('');
    expect(confirmationInput()).toHaveValue('');
    expect(replace).not.toHaveBeenCalled();

    await user.type(passwordInput(), 'potato-pass-999');
    await user.type(confirmationInput(), 'potato-pass-999');
    await user.click(submitButton());

    expect(submitCalls(fetchMock)).toHaveLength(2);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
  });
});

describe('SignupForm 서버 오류 표시', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function submitValid(user: ReturnType<typeof userEvent.setup>) {
    await user.type(emailInput(), 'buyer@example.com');
    await user.type(passwordInput(), 'potato-pass-123');
    await user.type(confirmationInput(), 'potato-pass-123');
    await user.click(submitButton());
  }

  it('409는 이메일 필드 아래에 표시한다', async () => {
    setupFetch(() =>
      jsonResponse(409, {
        error: {
          code: 'EMAIL_ALREADY_EXISTS',
          message: '이미 가입된 이메일입니다.',
          fields: { email: '이미 가입된 이메일입니다.' },
        },
      }),
    );
    const user = userEvent.setup();
    await renderForm();
    await submitValid(user);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('이미 가입된 이메일입니다.'),
    );
    expect(emailInput()).toHaveAttribute('aria-invalid', 'true');
    expect(emailInput()).toHaveValue('buyer@example.com');
  });

  it('네트워크 실패는 재시도 안내를 표시하고 비밀번호를 지운다', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith('/api/auth/me')) return unauthenticated();
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    await renderForm();
    await submitValid(user);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('네트워크'));
    expect(passwordInput()).toHaveValue('');
    expect(confirmationInput()).toHaveValue('');
    expect(submitButton()).toBeEnabled();
  });

  it('422 VALIDATION_ERROR의 fields를 각 필드에 반영한다', async () => {
    setupFetch(() =>
      jsonResponse(422, {
        error: {
          code: 'VALIDATION_ERROR',
          message: '입력값을 확인해 주세요.',
          fields: { email: '이메일 형식을 확인해 주세요.' },
        },
      }),
    );
    const user = userEvent.setup();
    await renderForm();
    await submitValid(user);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('이메일 형식을 확인해 주세요.'),
    );
    expect(emailInput()).toHaveAttribute('aria-invalid', 'true');
  });
});
