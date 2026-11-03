/**
 * A waveform as the app draws an Audio Clip's: mirrored bars, the same every
 * render for one seed. `shape` sets how loud each part is, so a vocal reads
 * as phrases and drums as hits.
 */
export function Wave({
  seed,
  width,
  height,
  bars = Math.round(width / 3),
  shape = "full",
  className,
}: {
  seed: number;
  width: number;
  height: number;
  bars?: number;
  shape?: "full" | "phrases" | "hits" | "low";
  className?: string;
}) {
  let s = seed * 9301 + 49297;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const step = width / bars;
  const rects = Array.from({ length: bars }, (_, i) => {
    const t = i / bars;
    let level = 0.35 + rand() * 0.65;
    if (shape === "phrases") level *= Math.sin(t * Math.PI * 7) > -0.2 ? 1 : 0.08;
    if (shape === "hits") level *= i % 8 === 0 ? 1 : i % 4 === 0 ? 0.7 : 0.22;
    if (shape === "low") level = 0.45 + 0.4 * Math.abs(Math.sin(t * Math.PI * 16));
    const h = Math.max(1.5, level * height * 0.92);
    return <rect key={i} x={i * step} y={(height - h) / 2} width={Math.max(1, step - 1)} height={h} rx={0.75} />;
  });
  return (
    <svg className={className} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      {rects}
    </svg>
  );
}
