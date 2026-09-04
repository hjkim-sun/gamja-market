import type { ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-potato-400 text-stone-900 hover:bg-potato-300 focus-visible:outline-potato-500 disabled:bg-stone-200 disabled:text-stone-500',
  secondary:
    'border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 focus-visible:outline-stone-500 disabled:bg-stone-100 disabled:text-stone-400',
  ghost:
    'text-stone-600 hover:bg-stone-100 focus-visible:outline-stone-500 disabled:text-stone-400',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({
  className = '',
  variant = 'primary',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex min-h-11 items-center justify-center rounded-xl px-4 py-2.5 text-sm font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed ${variantStyles[variant]} ${className}`}
      {...props}
    />
  );
}
