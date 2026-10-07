'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { confirmMatch } from '@/lib/api/applications';
import { ApiError } from '@/types/api';

interface ConfirmMatchButtonProps {
  requestId: string;
  applicationId: string;
  /** 같은 요청에서 함께 마감될 다른 pending 지원 수. 모르면(채팅방) 생략한다. */
  pendingOthers?: number;
  className?: string;
}

const RETRY_MESSAGE = '잠시 후 다시 시도해 주세요.';

/** 설계서 10.4: 확정은 되돌릴 수 없으므로 확인 패널을 한 번 더 거친다. */
export function ConfirmMatchButton({
  requestId,
  applicationId,
  pendingOthers,
  className = '',
}: ConfirmMatchButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  async function handleConfirm() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      await confirmMatch(requestId, applicationId, controller.signal);
      router.refresh();
    } catch (caught) {
      if (controller.signal.aborted) return;
      if (caught instanceof ApiError) {
        if (caught.code === 'REQUEST_ALREADY_MATCHED' || caught.code === 'REQUEST_CLOSED') {
          // 이미 상태가 바뀌었다. 서버 문구를 보여주고 최신 상태로 갱신한다.
          setError(caught.message);
          setConfirming(false);
          router.refresh();
        } else if (caught.code === 'NOT_REQUEST_OWNER' || caught.code === 'NOT_FOUND') {
          setError(caught.message);
        } else if (caught.code === 'UNAUTHENTICATED') {
          setError('로그인이 필요해요. 다시 로그인해 주세요.');
        } else {
          setError(RETRY_MESSAGE);
        }
      } else {
        setError(RETRY_MESSAGE);
      }
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  const warning =
    pendingOthers === undefined
      ? '다른 지원은 자동으로 마감되고 되돌릴 수 없어요.'
      : `확정하면 다른 지원 ${pendingOthers}건은 자동으로 마감되고 되돌릴 수 없어요.`;

  return (
    <div className={className}>
      {confirming ? (
        <div className="rounded-xl border border-potato-300 bg-potato-50 p-4" role="group" aria-label="판매자 확정 확인">
          <p className="text-sm font-bold text-stone-800">{warning}</p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void handleConfirm()} disabled={submitting}>
              {submitting ? '확정 중…' : '확정'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              disabled={submitting}
            >
              취소
            </Button>
          </div>
        </div>
      ) : (
        <Button
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          이 판매자로 확정
        </Button>
      )}
      {error ? (
        <p className="mt-2 text-sm font-semibold text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
