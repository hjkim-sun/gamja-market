import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequireAuth } from '@/features/auth/components/RequireAuth';
import { LoginForm } from '@/features/auth/components/LoginForm';

const replace = vi.fn();
const refresh = vi.fn(async () => {});
const login = vi.fn(async () => ({ id: 'user-1', email: 'buyer@example.com' }));
let authState: Record<string, unknown>;
let next = '/requests/new';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams({ next }),
}));

vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => authState,
}));

function setStatus(status: 'loading' | 'anonymous' | 'error' | 'authenticated') {
  authState = {
    status,
    user: status === 'authenticated' ? { id: 'user-1', email: 'buyer@example.com' } : null,
    error: status === 'error' ? '로그인 상태를 확인할 수 없습니다.' : null,
    refresh,
    login,
  };
}

async function submitLogin() {
  const user = userEvent.setup();
  render(<LoginForm />);
  await user.type(screen.getByLabelText('이메일'), 'buyer@example.com');
  await user.type(screen.getByLabelText('비밀번호'), 'potato-pass-123');
  await user.click(screen.getByRole('button', { name: '로그인' }));
}

describe('RequireAuth', () => {
  beforeEach(() => {
    replace.mockClear();
    refresh.mockClear();
    login.mockClear();
    next = '/requests/new';
  });

  it('loading 동안 복원 안내를 표시한다', () => {
    setStatus('loading');
    render(<RequireAuth>등록 폼</RequireAuth>);
    expect(screen.getByRole('status')).toHaveTextContent('로그인 상태를 확인하고 있어요');
    expect(screen.queryByText('등록 폼')).not.toBeInTheDocument();
  });

  it('anonymous면 등록 경로를 next로 보존해 로그인으로 보낸다', async () => {
    setStatus('anonymous');
    render(<RequireAuth>등록 폼</RequireAuth>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?next=/requests/new'));
    expect(screen.queryByText('등록 폼')).not.toBeInTheDocument();
  });

  it('복원 error를 비로그인으로 단정하지 않고 재시도한다', async () => {
    setStatus('error');
    const user = userEvent.setup();
    render(<RequireAuth>등록 폼</RequireAuth>);

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('로그인 상태를 확인할 수 없습니다');
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('authenticated에만 children을 표시한다', () => {
    setStatus('authenticated');
    render(<RequireAuth>등록 폼</RequireAuth>);
    expect(screen.getByText('등록 폼')).toBeInTheDocument();
  });

  it('로그인 성공 후 안전한 앱 내부 next 경로로 복귀한다', async () => {
    setStatus('anonymous');
    next = '/requests/new';
    await submitLogin();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/requests/new'));
  });

  it.each(['//evil.example', 'https://evil.example'])('외부 next=%s는 /로 제한한다', async (unsafe) => {
    setStatus('anonymous');
    next = unsafe;
    await submitLogin();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
  });
});
