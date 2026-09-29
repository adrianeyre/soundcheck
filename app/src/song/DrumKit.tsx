import type { KeyboardEvent } from "react";

import type { DrumPad } from "../project/model";

/** Where a piece of the kit is drawn, and how, in the picture's 400 × 220 space. */
interface Piece {
  id: string;
  /** The General MIDI drum notes it answers to. */
  notes: readonly number[];
  shape: "drum" | "cymbal" | "kick" | "hat" | "pedal";
  x: number;
  y: number;
  r: number;
  /**
   * Where the buttons of its other Pads go, beyond the first, which the
   * piece itself plays: the angle round it, in degrees clockwise from the
   * right, of each in turn.
   */
  chips?: readonly number[];
}

/**
 * The kit as a drummer sees it from the stool: hi-hat and snare on the left,
 * the kick in front, three toms over it, the floor tom on the right, the
 * crash, splash and ride above, and the hi-hat's pedal at its foot. The
 * notes are the General MIDI drum map's, which the Drum Sampler's Starter
 * Kit follows. A piece that plays more than one Pad, such as the snare's
 * Snare, Rimshot and Electric Snare, has a button for each of the others.
 */
const PIECES: readonly Piece[] = [
  { id: "crash", notes: [49, 57, 52], shape: "cymbal", x: 92, y: 42, r: 34, chips: [150, 30] },
  { id: "splash", notes: [55], shape: "cymbal", x: 206, y: 20, r: 20 },
  { id: "ride", notes: [51, 59, 53], shape: "cymbal", x: 318, y: 46, r: 38, chips: [150, 30] },
  { id: "hat", notes: [42, 46], shape: "hat", x: 44, y: 116, r: 28, chips: [-60, -100] },
  { id: "hatPedal", notes: [44], shape: "pedal", x: 44, y: 206, r: 12 },
  { id: "highTom", notes: [48, 50], shape: "drum", x: 150, y: 74, r: 22, chips: [200] },
  { id: "midTom", notes: [47], shape: "drum", x: 206, y: 66, r: 22 },
  { id: "lowTom", notes: [45], shape: "drum", x: 262, y: 74, r: 24 },
  { id: "floorTom", notes: [41, 43], shape: "drum", x: 312, y: 142, r: 34, chips: [60] },
  { id: "snare", notes: [38, 37, 40], shape: "drum", x: 112, y: 150, r: 30, chips: [180, 120] },
  { id: "kick", notes: [36, 35], shape: "kick", x: 208, y: 162, r: 46, chips: [25] },
];

/**
 * The size of a piece's label, in the picture's units: 10, or smaller for a
 * name too long to fit across a drum, about 0.6 of the size wide a letter.
 */
function labelSize(piece: { shape: Piece["shape"]; r: number }, name: string): number {
  if (piece.shape === "cymbal") return 10;
  const room = piece.shape === "pedal" ? piece.r * 3.2 : piece.shape === "hat" ? piece.r * 1.9 : piece.r * 1.8;
  return Math.max(5, Math.min(piece.shape === "pedal" ? 7 : 10, room / (name.length * 0.6)));
}

/** How far out from its piece's edge a Pad's button sits, and how big it is. */
const CHIP_GAP = 13;
const CHIP_R = 10;

export interface KitPiece {
  id: string;
  shape: Piece["shape"];
  x: number;
  y: number;
  r: number;
  /** The Pads this piece plays, in Pad order: the piece itself hits the first. */
  pads: DrumPad[];
  /** Where the buttons of its other Pads are, one for each after the first. */
  chips: { x: number; y: number }[];
}

/**
 * The kit pieces the Pads fill: each Pad goes on the piece its note belongs
 * to, and a Pad whose note has no piece (a clap, a cowbell, a Pad moved to
 * another note) gets a percussion pad of its own along the bottom, so every
 * Pad has somewhere to light up. Pieces no Pad plays are still drawn, dimmed.
 */
export function kitPieces(pads: readonly DrumPad[]): KitPiece[] {
  const pieces: KitPiece[] = PIECES.map(({ id, shape, x, y, r }) => ({ id, shape, x, y, r, pads: [], chips: [] }));
  const extras: DrumPad[] = [];
  for (const pad of pads) {
    const index = PIECES.findIndex((piece) => piece.notes.includes(pad.note));
    if (index >= 0) pieces[index]!.pads.push(pad);
    else extras.push(pad);
  }
  // Down the right-hand edge, clear of the floor tom, in columns of four.
  extras.forEach((pad, index) => {
    const column = Math.floor(index / 4);
    pieces.push({ id: `extra:${pad.note}`, shape: "drum", x: 402 - column * 31, y: 102 + (index % 4) * 31, r: 14, pads: [pad], chips: [] });
  });
  // Every Pad past a piece's first gets a button round it, so each can be hit on its own.
  pieces.forEach((piece, index) => {
    const angles = PIECES[index]?.chips ?? [];
    piece.chips = piece.pads.slice(1).map((_, chip) => {
      // Past the angles given, the buttons go on round the piece, 36 degrees apart.
      const angle = ((angles[chip] ?? (angles.at(-1) ?? 90) + 36 * (chip - angles.length + 1)) * Math.PI) / 180;
      const out = piece.r + CHIP_GAP;
      return { x: piece.x + Math.cos(angle) * out, y: piece.y + Math.sin(angle) * (piece.shape === "cymbal" || piece.shape === "hat" ? out * 0.6 : out) };
    });
  });
  return pieces;
}

export interface DrumKitProps {
  trackName: string;
  pads: readonly DrumPad[];
  /** The notes being hit now: by the song at the playhead, and by the keys, the computer keyboard or MIDI. */
  hitting: ReadonlySet<number>;
  /** Hit a Pad by clicking its piece (`on`), and let go (`!on`); absent when there is no audio to hear it. */
  onHit?: (note: number, on: boolean) => void;
}

/**
 * A drum kit drawn from the Drum Sampler's Pads, with each piece lighting up
 * as the Pad on it is hit, by the song or by a player: the picture a drummer
 * would see. Clicking a piece, or pressing Enter on it, hits its first Pad,
 * and each of its other Pads has a button of its own beside it.
 */
export function DrumKit({ trackName, pads, hitting, onHit }: DrumKitProps) {
  const pieces = kitPieces(pads);
  const hit = pads.filter((pad) => hitting.has(pad.note));
  // A Pad's button: pressed by the pointer, or by Enter or Space, it hits the Pad until let go.
  const hitProps = (pad: DrumPad | undefined) =>
    pad === undefined || onHit === undefined
      ? {}
      : {
          role: "button",
          tabIndex: 0,
          "aria-label": `Hit ${pad.name}`,
          onPointerDown: () => onHit(pad.note, true),
          onPointerUp: () => onHit(pad.note, false),
          onPointerLeave: () => onHit(pad.note, false),
          onKeyDown: (event: KeyboardEvent) => {
            if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
              event.preventDefault();
              onHit(pad.note, true);
            }
          },
          onKeyUp: () => onHit(pad.note, false),
        };

  return (
    <figure className="drum-kit" aria-label={`${trackName} drum kit`}>
      <svg
        role="group"
        aria-label={`${trackName} drum kit: ${hit.length ? `hitting ${hit.map((pad) => pad.name).join(", ")}` : "nothing hit"}`}
        viewBox="0 0 420 224"
      >
        {/* Stands first, so the pieces sit on them. */}
        {pieces
          .filter((piece) => piece.shape === "cymbal" || piece.shape === "hat")
          .map((piece) => (
            <line key={`stand:${piece.id}`} x1={piece.x} y1={piece.y} x2={piece.x} y2={220} className="drum-kit-stand" />
          ))}
        {pieces.map((piece) => {
          const pad = piece.pads[0];
          const label = piece.pads.map((p) => p.name).join(", ");
          return (
            <g key={piece.id}>
              <g
                className="drum-kit-piece"
                data-shape={piece.shape}
                data-hit={pad && hitting.has(pad.note) ? "true" : undefined}
                data-empty={pad === undefined ? "true" : undefined}
                {...hitProps(pad)}
              >
                <title>{label || "No Pad"}</title>
                {piece.shape === "pedal" ? (
                  <rect x={piece.x - piece.r * 1.6} y={piece.y - piece.r / 2} width={piece.r * 3.2} height={piece.r} rx={3} className="drum-kit-pedal" />
                ) : piece.shape === "cymbal" || piece.shape === "hat" ? (
                  <>
                    <ellipse cx={piece.x} cy={piece.y} rx={piece.r} ry={piece.r * 0.32} className="drum-kit-metal" />
                    {piece.shape === "hat" && (
                      <ellipse cx={piece.x} cy={piece.y + 7} rx={piece.r} ry={piece.r * 0.3} className="drum-kit-metal" />
                    )}
                    <circle cx={piece.x} cy={piece.y} r={3} className="drum-kit-bell" />
                  </>
                ) : (
                  <>
                    <circle cx={piece.x} cy={piece.y} r={piece.r} className="drum-kit-shell" />
                    <circle cx={piece.x} cy={piece.y} r={piece.r - (piece.shape === "kick" ? 6 : 4)} className="drum-kit-head" />
                    {piece.shape === "kick" && <circle cx={piece.x} cy={piece.y} r={piece.r * 0.35} className="drum-kit-port" />}
                  </>
                )}
                {pad && (
                  <text
                    x={piece.x}
                    y={piece.shape === "cymbal" ? piece.y - piece.r * 0.32 - 4 : piece.shape === "pedal" ? piece.y + 3 : piece.y + 4}
                    className="drum-kit-label"
                    style={{ fontSize: labelSize(piece, pad.name) }}
                  >
                    {pad.name}
                  </text>
                )}
              </g>
              {piece.pads.slice(1).map((other, index) => {
                const chip = piece.chips[index]!;
                return (
                  <g
                    key={other.note}
                    className="drum-kit-piece drum-kit-chip"
                    data-shape="chip"
                    data-hit={hitting.has(other.note) ? "true" : undefined}
                    {...hitProps(other)}
                  >
                    <title>{other.name}</title>
                    <circle cx={chip.x} cy={chip.y} r={CHIP_R} className="drum-kit-shell" />
                    <circle cx={chip.x} cy={chip.y} r={CHIP_R - 3} className="drum-kit-head" />
                    <text x={chip.x} y={chip.y < piece.y - piece.r * 0.3 ? chip.y - CHIP_R - 3 : chip.y + CHIP_R + 8} className="drum-kit-chip-label">
                      {other.name}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <figcaption className="hint">
        {onHit ? "Click a drum to hit it. It lights up whenever the song or a player hits it." : "Each drum lights up as the song hits it. Start audio to play them."}
      </figcaption>
    </figure>
  );
}
