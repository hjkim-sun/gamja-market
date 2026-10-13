'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { completeTransaction } from '@/lib/api/reviews';
import { ApiError } from '@/types/api';

interface CompleteTransactionButtonProps {
  requestId: string;
  className?: string;
}

const RETRY_MESSAGE = '잠시 후 다시 시도해 주세요.';

/** 설계서 11.4: 거래 완료는 되돌릴 수 없으므로 확인 패널을 한 번 더 거친다. */
export function CompleteTransactionButton({ requestId, className = '' }: CompleteTransactionButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleComplete() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      await completeTransaction(requestId);
      // 성공 후에는 서버 상태가 바뀌어 이 버튼이 사라진다. 확인 패널은 그대로 두고 갱신만 맡긴다.
      router.refresh();
    } catch (caught) {
      if (!mountedRef.current) return;
      if (caught instanceof ApiError) {
        if (caught.code === 'REQUEST_NOT_MATCHED') {
          // 이미 상태가 바뀌었다. 서버 문구를 보여주고 최신 상태로 갱신한다.
          setError(caught.message);
          setConfirming(false);
          router.refresh();
        } else if (caught.code === 'COMPLETION_FORBIDDEN' || caught.code === 'NOT_FOUND') {
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
      if (mountedRef.current) setSubmitting(false);
    }
  }

  return (
    <div className={className}>
      {confirming ? (
        <div className="rounded-xl border border-potato-300 bg-potato-50 p-4" role="group" aria-label="거래 완료 확인">
          <p className="text-sm font-bold text-stone-800">
            물건을 받으셨나요? 거래를 완료하면 채팅이 종료되고 되돌릴 수 없어요.
          </p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void handleComplete()} disabled={submitting}>
              {submitting ? '완료 중…' : '완료'}
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
          거래 완료
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
