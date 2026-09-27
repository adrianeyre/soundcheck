/**
 * The Soundcheck mark: a note on a rounded square, the favicon's shape too.
 * Its gradient is the colour palette's (`--logo-from`, `--logo-to`).
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden focusable="false">
      <defs>
        <linearGradient id="logo-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--logo-from)" }} />
          <stop offset="1" style={{ stopColor: "var(--logo-to)" }} />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#logo-fill)" />
      <path d="M26 44V20l20-5v24" fill="none" stroke="#0b0d17" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="21" cy="44" r="6" fill="#0b0d17" />
      <circle cx="41" cy="39" r="6" fill="#0b0d17" />
      <path d="M50 10l1.6 3.4L55 15l-3.4 1.6L50 20l-1.6-3.4L45 15l3.4-1.6z" fill="#ffffff" />
    </svg>
  );
}
