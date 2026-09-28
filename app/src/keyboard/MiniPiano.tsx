import { pitchName } from "../song/step-grid";
import { isBlackKey } from "../theory/theory";

export interface MiniPianoProps {
  /** Lowest and highest pitch drawn; widened to whole octaves, C to C. */
  low: number;
  high: number;
  /** Pitches being played now by the song. */
  playing: ReadonlySet<number>;
  /** Pitches held now, from the on-screen keys, the computer keyboard or MIDI. */
  held?: ReadonlySet<number>;
  /** Pitches the Clip holds somewhere, marked faintly. */
  used?: ReadonlySet<number>;
  label: string;
}

const WHITE_W = 14;
const WHITE_H = 56;
const BLACK_W = 9;
const BLACK_H = 34;

/**
 * A piano drawn as a picture: the keys the song is playing light in the
 * play colour, those held in the accent colour, and the pitches the Clip
 * uses anywhere carry a dot, so a pattern can be followed on the keys as it
 * plays.
 */
export function MiniPiano({ low, high, playing, held = new Set(), used = new Set(), label }: MiniPianoProps) {
  const from = Math.max(0, low - (((low % 12) + 12) % 12));
  const to = Math.min(127, high + (12 - (((high % 12) + 12) % 12)) % 12);
  const pitches = Array.from({ length: to - from + 1 }, (_, index) => from + index);
  const whites = pitches.filter((pitch) => !isBlackKey(pitch));
  const width = whites.length * WHITE_W;
  const lit = [...playing, ...held].filter((pitch) => pitch >= from && pitch <= to).toSorted((a, b) => a - b);
  const state = (pitch: number) => (playing.has(pitch) ? "playing" : held.has(pitch) ? "held" : undefined);

  return (
    <svg
      role="img"
      aria-label={`${label}: ${lit.length ? lit.map(pitchName).join(", ") : "no keys"} sounding`}
      className="mini-piano"
      viewBox={`0 0 ${width} ${WHITE_H}`}
      preserveAspectRatio="none"
    >
      {whites.map((pitch, index) => (
        <g key={pitch}>
          <rect
            className="mini-piano-white"
            data-state={state(pitch)}
            x={index * WHITE_W}
            y={0}
            width={WHITE_W}
            height={WHITE_H}
            rx={2}
          />
          {used.has(pitch) && <circle cx={index * WHITE_W + WHITE_W / 2} cy={WHITE_H - 8} r={2.2} className="mini-piano-dot" />}
          {pitch % 12 === 0 && (
            <text x={index * WHITE_W + 2} y={WHITE_H - 14} className="mini-piano-label">
              {pitchName(pitch)}
            </text>
          )}
        </g>
      ))}
      {pitches.filter(isBlackKey).map((pitch) => {
        const x = whites.filter((white) => white < pitch).length * WHITE_W - BLACK_W / 2;
        return (
          <g key={pitch}>
            <rect className="mini-piano-black" data-state={state(pitch)} x={x} y={0} width={BLACK_W} height={BLACK_H} rx={1.5} />
            {used.has(pitch) && <circle cx={x + BLACK_W / 2} cy={BLACK_H - 6} r={1.8} className="mini-piano-dot" />}
          </g>
        );
      })}
    </svg>
  );
}
