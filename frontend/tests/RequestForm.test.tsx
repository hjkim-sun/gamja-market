import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestForm } from '@/features/requests/components/RequestForm';

describe('RequestForm', () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
  });

  it('빈 폼을 제출하면 필수 입력 오류를 보여준다', async () => {
    const user = userEvent.setup();
    render(<RequestForm />);

    await user.click(screen.getByRole('button', { name: '입력 내용 확인' }));

    expect(screen.getByText('제목은 2자 이상 60자 이하로 입력해 주세요.')).toBeInTheDocument();
    expect(screen.getByText('카테고리를 선택해 주세요.')).toBeInTheDocument();
    expect(screen.getByText('희망 상태를 선택해 주세요.')).toBeInTheDocument();
    expect(screen.getByText('거래 지역을 입력해 주세요.')).toBeInTheDocument();
  });

  it('최소가가 최대가보다 크면 범위 오류를 보여준다', async () => {
    const user = userEvent.setup();
    render(<RequestForm />);

    await user.type(screen.getByRole('textbox', { name: /제목/ }), '아이패드 구합니다');
    await user.selectOptions(screen.getByRole('combobox', { name: /카테고리/ }), '디지털기기');
    await user.type(screen.getByRole('textbox', { name: /원하는 스펙/ }), 'M2 모델이며 상태가 깨끗하면 좋겠습니다.');
    await user.type(screen.getByRole('spinbutton', { name: '희망 최소가' }), '900000');
    await user.type(screen.getByRole('spinbutton', { name: '희망 최대가' }), '700000');
    await user.click(screen.getByRole('radio', { name: /거의 새것/ }));
    await user.type(screen.getByRole('textbox', { name: /거래 지역/ }), '서울 강남구');
    await user.click(screen.getByRole('button', { name: '입력 내용 확인' }));

    expect(screen.getByText('최대가는 최소가보다 크거나 같아야 합니다.')).toBeInTheDocument();
  });

  it('유효한 입력은 저장 예정 안내를 보여준다', async () => {
    const user = userEvent.setup();
    render(<RequestForm />);

    await user.type(screen.getByRole('textbox', { name: /제목/ }), '아이패드 구합니다');
    await user.selectOptions(screen.getByRole('combobox', { name: /카테고리/ }), '디지털기기');
    await user.type(screen.getByRole('textbox', { name: /원하는 스펙/ }), 'M2 모델이며 상태가 깨끗하면 좋겠습니다.');
    await user.type(screen.getByRole('spinbutton', { name: '희망 최소가' }), '600000');
    await user.type(screen.getByRole('spinbutton', { name: '희망 최대가' }), '800000');
    await user.click(screen.getByRole('radio', { name: /거의 새것/ }));
    await user.type(screen.getByRole('textbox', { name: /거래 지역/ }), '서울 강남구');
    await user.click(screen.getByRole('button', { name: '입력 내용 확인' }));

    expect(screen.getByRole('status')).toHaveTextContent('아직 저장 기능이 없습니다');
  });
});
