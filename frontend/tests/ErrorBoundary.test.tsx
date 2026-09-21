import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import AppError from '@/app/error';

describe('서버 데이터 오류 상태', () => {
  it('목업 목록으로 폴백하지 않고 오류 안내와 다시 시도를 제공한다', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<AppError error={new Error('backend unavailable')} reset={reset} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/불러오|다시 시도|잠시 후/);
    expect(screen.queryAllByRole('link', { name: /상세 보기/ })).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
