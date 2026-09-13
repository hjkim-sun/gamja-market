'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';

import { useAuth } from '@/features/auth/AuthProvider';
import { FieldError, FormAlert } from '@/features/auth/components/FieldError';
import {
  authInputClassName,
  authLabelClassName,
  validateEmail,
  validatePassword,
} from '@/features/auth/components/authFormStyles';
import { Button } from '@/components/ui/Button';
import { ApiError, type ApiErrorFields } from '@/types/auth';

type LoginField = 'email' | 'password';

const FIELD_ORDER: readonly LoginField[] = ['email', 'password'];

const FIELD_IDS: Record<LoginField, string> = {
  email: 'login-email',
  password: 'login-password',
};

const ERROR_IDS: Record<LoginField, string> = {
  email: 'login-email-error',
  password: 'login-password-error',
};

export function LoginForm() {
  const router = useRouter();
  const { login } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<ApiErrorFields>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const formRef = useRef<HTMLFormElement>(null);

  function focusFirstError(errors: ApiErrorFields) {
    const firstField = FIELD_ORDER.find((field) => errors[field]);
    if (!firstField) return;
    formRef.current?.querySelector<HTMLInputElement>(`#${FIELD_IDS[firstField]}`)?.focus();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const nextErrors: ApiErrorFields = {};
    const emailError = validateEmail(email);
    const passwordError = validatePassword(password);

    if (emailError) nextErrors.email = emailError;
    if (passwordError) nextErrors.password = passwordError;

    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      setFormError(null);
      focusFirstError(nextErrors);
      return;
    }

    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);

    try {
      // 로그인은 확인값을 보내지 않는다.
      await login({ email: email.trim(), password });
      setPassword('');
      router.replace('/');
    } catch (caught) {
      // 실패 후 이메일은 유지하고 비밀번호 입력만 지운다.
      setPassword('');

      if (caught instanceof ApiError) {
        if (caught.code === 'INVALID_CREDENTIALS') {
          // 401은 필드가 아니라 폼 상단에 표시한다.
          setFormError(caught.message);
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
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={Boolean(fieldErrors.password)}
          aria-describedby={fieldErrors.password ? ERROR_IDS.password : undefined}
          className={authInputClassName}
        />
        <FieldError id={ERROR_IDS.password} message={fieldErrors.password} />
      </div>

      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? '로그인 중…' : '로그인'}
      </Button>

      <p className="text-center text-sm text-stone-600">
        아직 계정이 없나요?{' '}
        <Link
          href="/signup"
          className="font-bold text-leaf-700 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-potato-500"
        >
          회원가입
        </Link>
      </p>
    </form>
  );
}
