import type { CSSProperties } from "react";

import "./timeline.css";

/**
 * A Soundcheck Timeline, small: the Section strip, the bar ruler and one lane
 * per Track, each Clip at its bar. Clips carry their notes as the app draws
 * them (dashes on a Pattern Clip), so they read as music, not as boxes.
 */

export type Kind = "drum" | "instrument";

export interface Lane {
  name: string;
  kind: Kind;
}

export interface Clip {
  id: string;
  lane: number;
  /** The first bar, from 0. */
  bar: number;
  bars: number;
  /** Bars it has moved by, eased. */
  shift?: number;
  /** Not there yet: it arrives when this turns false. */
  hidden?: boolean;
  /** The Clip the story is about. */
  lit?: boolean;
  /** A snare roll: hits that double each bar. */
  roll?: boolean;
}

export interface Section {
  id: string;
  name: string;
  bar: number;
  bars: number;
  shift?: number;
  hidden?: boolean;
  lit?: boolean;
}

/** A Clip's notes, as fractions across and down it: the same every render. */
function notes(clip: Clip, kind: Kind): { x: number; y: number; w: number }[] {
  const out: { x: number; y: number; w: number }[] = [];
  if (clip.roll) {
    for (let bar = 0; bar < clip.bars; bar++) {
      const hits = 2 ** (bar + 1);
      for (let i = 0; i < hits; i++) out.push({ x: (bar + i / hits) / clip.bars, y: 0.5, w: 0.5 / (hits * clip.bars) });
    }
    return out;
  }
  const perBar = kind === "drum" ? 4 : 2;
  let seed = clip.id.length * 7 + clip.lane * 13;
  for (let i = 0; i < clip.bars * perBar; i++) {
    seed = (seed * 31 + 11) % 97;
    const y = kind === "drum" ? ([0.72, 0.3, 0.5, 0.3][i % 4] ?? 0.5) : 0.25 + (seed % 5) * 0.12;
    out.push({ x: i / (clip.bars * perBar), y, w: kind === "drum" ? 0.035 / clip.bars : 0.36 / (perBar * clip.bars) });
  }
  return out;
}

export function Timeline({
  lanes,
  clips,
  sections,
  bars,
  barWidth,
  header = 96,
  laneHeight = 44,
  className,
}: {
  lanes: Lane[];
  clips: Clip[];
  sections: Section[];
  bars: number;
  barWidth: number;
  header?: number;
  laneHeight?: number;
  className?: string;
}) {
  const style = { "--bw": `${barWidth}px`, "--hdr": `${header}px`, "--lane": `${laneHeight}px` } as CSSProperties;
  return (
    <div className={`sc-tl ${className ?? ""}`} style={style}>
      <div className="sc-tl__row sc-tl__sections">
        <div className="sc-tl__head">Sections</div>
        <div className="sc-tl__track">
          {sections.map((s) => (
            <div
              key={s.id}
              className="sc-tl__section"
              data-hidden={s.hidden || undefined}
              data-lit={s.lit || undefined}
              style={{ left: s.bar * barWidth, width: s.bars * barWidth, transform: `translateX(${(s.shift ?? 0) * barWidth}px)` }}
            >
              <span>{s.name}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="sc-tl__row sc-tl__ruler">
        <div className="sc-tl__head" />
        <div className="sc-tl__track">
          {Array.from({ length: Math.ceil(bars / 4) }, (_, i) => (
            <span key={i} style={{ left: i * 4 * barWidth }}>
              {i * 4 + 1}
            </span>
          ))}
        </div>
      </div>
      {lanes.map((lane, l) => (
        <div key={lane.name} className="sc-tl__row sc-tl__lane">
          <div className="sc-tl__head" data-kind={lane.kind}>
            {lane.name}
          </div>
          <div className="sc-tl__track">
            {clips
              .filter((c) => c.lane === l)
              .map((c) => (
                <div
                  key={c.id}
                  className="sc-tl__clip"
                  data-kind={lane.kind}
                  data-hidden={c.hidden || undefined}
                  data-lit={c.lit || undefined}
                  style={{ left: c.bar * barWidth + 1, width: c.bars * barWidth - 2, transform: `translateX(${(c.shift ?? 0) * barWidth}px)` }}
                >
                  {notes(c, lane.kind).map((n, i) => (
                    <i key={i} style={{ left: `${n.x * 100}%`, top: `${n.y * 100}%`, width: `max(2px, ${n.w * 100}%)` }} />
                  ))}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
