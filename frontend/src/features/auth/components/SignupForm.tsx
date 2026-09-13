'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';

import { useAuth } from '@/features/auth/AuthProvider';
import { FieldError, FormAlert } from '@/features/auth/components/FieldError';
import {
  authInputClassName,
  authLabelClassName,
  PASSWORD_MISMATCH_MESSAGE,
  validateEmail,
  validatePassword,
} from '@/features/auth/components/authFormStyles';
import { Button } from '@/components/ui/Button';
import { ApiError, type ApiErrorFields } from '@/types/auth';

type SignupField = 'email' | 'password' | 'password_confirmation';

/** 첫 오류 필드로 초점을 옮길 때 사용하는 필드 순서다. */
const FIELD_ORDER: readonly SignupField[] = ['email', 'password', 'password_confirmation'];

const FIELD_IDS: Record<SignupField, string> = {
  email: 'signup-email',
  password: 'signup-password',
  password_confirmation: 'signup-password-confirmation',
};

const ERROR_IDS: Record<SignupField, string> = {
  email: 'signup-email-error',
  password: 'signup-password-error',
  password_confirmation: 'signup-password-confirmation-error',
};

export function SignupForm() {
  const router = useRouter();
  const { signup } = useAuth();

  // 비밀번호 원문은 폼의 일시적 입력 상태와 요청에만 둔다.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');

  const [fieldErrors, setFieldErrors] = useState<ApiErrorFields>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const formRef = useRef<HTMLFormElement>(null);

  function focusFirstError(errors: ApiErrorFields) {
    const firstField = FIELD_ORDER.find((field) => errors[field]);
    if (!firstField) return;
    const element = formRef.current?.querySelector<HTMLInputElement>(`#${FIELD_IDS[firstField]}`);
    element?.focus();
  }

  /**
   * 어느 비밀번호든 수정하면 표시된 일치 오류를 다시 비교해 일치할 때 해제한다.
   * 최종 제출에서 항상 재검증하므로 여기서는 표시만 정리한다.
   */
  function revalidateMismatch(nextPassword: string, nextConfirmation: string) {
    setFieldErrors((previous) => {
      if (previous.password_confirmation !== PASSWORD_MISMATCH_MESSAGE) return previous;
      if (nextPassword !== nextConfirmation) return previous;

      const next = { ...previous };
      delete next.password_confirmation;
      return next;
    });
  }

  function handlePasswordChange(value: string) {
    setPassword(value);
    revalidateMismatch(value, passwordConfirmation);
  }

  function handlePasswordConfirmationChange(value: string) {
    setPasswordConfirmation(value);
    revalidateMismatch(password, value);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const nextErrors: ApiErrorFields = {};
    const emailError = validateEmail(email);
    const passwordError = validatePassword(password);
    const confirmationError = validatePassword(passwordConfirmation, '비밀번호 확인');

    if (emailError) nextErrors.email = emailError;
    if (passwordError) nextErrors.password = passwordError;
    if (confirmationError) nextErrors.password_confirmation = confirmationError;

    // 필드 검증을 통과한 뒤에만 원문을 비교한다. 변환 없이 정확히 같아야 한다.
    if (!passwordError && !confirmationError && password !== passwordConfirmation) {
      nextErrors.password_confirmation = PASSWORD_MISMATCH_MESSAGE;
    }

    if (Object.keys(nextErrors).length > 0) {
      // 로컬 오류에서는 요청을 보내지 않고 입력값도 유지한다.
      setFieldErrors(nextErrors);
      setFormError(null);
      focusFirstError(nextErrors);
      return;
    }

    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);

    try {
      await signup({ email: email.trim(), password, password_confirmation: passwordConfirmation });
      // 성공 시에도 두 비밀번호 입력 상태를 폐기한다.
      setPassword('');
      setPasswordConfirmation('');
      router.replace('/');
    } catch (caught) {
      // 서버 응답·네트워크 실패 후 이메일은 유지하고 두 비밀번호는 지운다.
      setPassword('');
      setPasswordConfirmation('');

      if (caught instanceof ApiError) {
        if (caught.code === 'PASSWORD_MISMATCH') {
          const errors: ApiErrorFields = {
            password_confirmation: caught.fields.password_confirmation ?? caught.message,
          };
          setFieldErrors(errors);
          focusFirstError(errors);
        } else if (caught.code === 'EMAIL_ALREADY_EXISTS') {
          const errors: ApiErrorFields = { email: caught.fields.email ?? caught.message };
          setFieldErrors(errors);
          focusFirstError(errors);
        } else if (caught.code === 'VALIDATION_ERROR') {
          setFieldErrors(caught.fields);
          if (Object.keys(caught.fields).length === 0) setFormError(caught.message);
          focusFirstError(caught.fields);
        } else {
          setFormError(caught.message);
        }
      } else {
        setFormError('잠시 후 다시 시도해 주세요.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form ref={formRef} noValidate onSubmit={handleSubmit} className="space-y-6">
      <FormAlert message={formError} />

      <div>
        <label htmlFor={FIELD_IDS.email} className={authLabelClassName}>
          이메일
        </label>
        <input
          id={FIELD_IDS.email}
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="buyer@example.com"
          aria-invalid={Boolean(fieldErrors.email)}
          aria-describedby={fieldErrors.email ? ERROR_IDS.email : undefined}
          className={authInputClassName}
        />
        <FieldError id={ERROR_IDS.email} message={fieldErrors.email} />
      </div>

      <div>
        <label htmlFor={FIELD_IDS.password} className={authLabelClassName}>
          비밀번호
        </label>
        <input
          id={FIELD_IDS.password}
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => handlePasswordChange(event.target.value)}
          aria-invalid={Boolean(fieldErrors.password)}
          aria-describedby={fieldErrors.password ? ERROR_IDS.password : 'signup-password-help'}
          className={authInputClassName}
        />
        <p id="signup-password-help" className="mt-2 text-xs text-stone-400">
          8~128자
        </p>
        <FieldError id={ERROR_IDS.password} message={fieldErrors.password} />
      </div>

      <div>
        <label htmlFor={FIELD_IDS.password_confirmation} className={authLabelClassName}>
          비밀번호 확인
        </label>
        <input
          id={FIELD_IDS.password_confirmation}
          name="password_confirmation"
          type="password"
          autoComplete="new-password"
          value={passwordConfirmation}
          onChange={(event) => handlePasswordConfirmationChange(event.target.value)}
          aria-invalid={Boolean(fieldErrors.password_confirmation)}
          aria-describedby={
            fieldErrors.password_confirmation ? ERROR_IDS.password_confirmation : undefined
          }
          className={authInputClassName}
        />
        <FieldError
          id={ERROR_IDS.password_confirmation}
          message={fieldErrors.password_confirmation}
        />
      </div>

      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? '가입 중…' : '회원가입'}
      </Button>

      <p className="text-center text-sm text-stone-600">
        이미 계정이 있나요?{' '}
        <Link
          href="/login"
          className="font-bold text-leaf-700 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-potato-500"
        >
          로그인
        </Link>
      </p>
    </form>
  );
}
