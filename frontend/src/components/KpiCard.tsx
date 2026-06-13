type Props = { label: string; value: string; sub?: string };

export default function KpiCard({ label, value, sub }: Props) {
  return (
    <div className="card p-5">
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-gray-900 dark:text-slate-100">{value}</div>
      {sub && <div className="mt-1 text-xs text-gray-500 dark:text-slate-400">{sub}</div>}
    </div>
  );
}
