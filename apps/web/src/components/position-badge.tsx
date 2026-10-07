/** A rank position: lower is better; null means outside the top 100 (or no data yet). */
export function PositionBadge({
  position,
  date,
}: {
  position: number | null;
  date?: string | null;
}) {
  const tone =
    position === null
      ? 'bg-slate-100 text-slate-500'
      : position <= 3
        ? 'bg-emerald-100 text-emerald-800'
        : position <= 10
          ? 'bg-sky-100 text-sky-800'
          : 'bg-slate-100 text-slate-700';
  const label = position === null ? '—' : `#${position}`;
  const title = position === null ? 'Not in the top 100' : `Position ${position}`;
  return (
    <span
      className={`inline-block min-w-8 rounded px-1.5 py-0.5 text-center text-xs font-medium tabular-nums ${tone}`}
      title={date ? `${title} on ${date}` : title}
    >
      {label}
    </span>
  );
}
