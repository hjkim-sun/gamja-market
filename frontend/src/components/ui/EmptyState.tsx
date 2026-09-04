interface EmptyStateProps {
  title: string;
  description?: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="col-span-full rounded-2xl border border-dashed border-stone-300 bg-white px-5 py-16 text-center">
      <div className="mb-4 text-4xl" aria-hidden="true">
        🥔
      </div>
      <p className="text-lg font-bold text-stone-800">{title}</p>
      {description ? <p className="mt-2 text-sm text-stone-500">{description}</p> : null}
    </div>
  );
}
