export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-2 text-sm font-semibold text-red-600" role="alert">
      {message}
    </p>
  );
}

export function FormAlert({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div
      className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold leading-6 text-red-700"
      role="alert"
    >
      {message}
    </div>
  );
}
