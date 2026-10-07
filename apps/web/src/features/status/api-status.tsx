import { useApiHealth, type ApiHealth } from './use-api-health';

const labels: Record<ApiHealth, { text: string; dot: string }> = {
  ok: { text: 'API connected', dot: 'bg-emerald-500' },
  database_down: { text: 'Database unavailable', dot: 'bg-amber-500' },
  unreachable: { text: 'API unreachable', dot: 'bg-red-500' },
};

export function ApiStatus() {
  const { data } = useApiHealth();
  const label = data ? labels[data] : { text: 'Checking API…', dot: 'bg-slate-300' };

  return (
    <p role="status" className="flex items-center gap-2 text-sm text-slate-600">
      <span aria-hidden className={`size-2 rounded-full ${label.dot}`} />
      {label.text}
    </p>
  );
}
