type Props = { value: number; max?: number };

export default function ProgressBar({ value, max = 100 }: Props) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const reached = pct >= 100;
  return (
    <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
      <div
        className={`h-2 rounded-full transition-all ${
          reached ? "bg-emerald-500" : "bg-accent"
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
