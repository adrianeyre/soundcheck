import type { DrumPad } from "../project/model";

/** Where a piece of the kit is drawn, and how, in the picture's 400 × 220 space. */
interface Piece {
  id: string;
  /** The General MIDI drum notes it answers to. */
  notes: readonly number[];
  shape: "drum" | "cymbal" | "kick" | "hat";
  x: number;
  y: number;
  r: number;
}

/**
 * The kit as a drummer sees it from the stool: hi-hat and snare on the left,
 * the kick in front, the toms over it, the floor tom on the right, and the
 * crash and ride above. The notes are the General MIDI drum map's, which the
 * Drum Sampler's Starter Kit follows.
 */
const PIECES: readonly Piece[] = [
  { id: "crash", notes: [49, 57, 52, 55], shape: "cymbal", x: 92, y: 42, r: 34 },
  { id: "ride", notes: [51, 59, 53], shape: "cymbal", x: 318, y: 46, r: 38 },
  { id: "hat", notes: [42, 44, 46], shape: "hat", x: 44, y: 116, r: 28 },
  { id: "highTom", notes: [48, 50], shape: "drum", x: 164, y: 70, r: 24 },
  { id: "midTom", notes: [45, 47], shape: "drum", x: 232, y: 70, r: 26 },
  { id: "floorTom", notes: [41, 43], shape: "drum", x: 312, y: 142, r: 34 },
  { id: "snare", notes: [38, 40, 37], shape: "drum", x: 112, y: 150, r: 30 },
  { id: "kick", notes: [36, 35], shape: "kick", x: 208, y: 162, r: 46 },
];

export interface KitPiece {
  id: string;
  shape: Piece["shape"];
  x: number;
  y: number;
  r: number;
  /** The Pads this piece plays, in Pad order. */
  pads: DrumPad[];
}

/**
 * The kit pieces the Pads fill: each Pad goes on the piece its note belongs
 * to, and a Pad whose note has no piece (a clap, a cowbell, a Pad moved to
 * another note) gets a percussion pad of its own along the bottom, so every
 * Pad has somewhere to light up. Pieces no Pad plays are still drawn, dimmed.
 */
export function kitPieces(pads: readonly DrumPad[]): KitPiece[] {
  const pieces: KitPiece[] = PIECES.map(({ id, shape, x, y, r }) => ({ id, shape, x, y, r, pads: [] }));
  const extras: DrumPad[] = [];
  for (const pad of pads) {
    const index = PIECES.findIndex((piece) => piece.notes.includes(pad.note));
    if (index >= 0) pieces[index]!.pads.push(pad);
    else extras.push(pad);
  }
  // Down the right-hand edge, clear of the floor tom, in columns of five.
  extras.forEach((pad, index) => {
    const column = Math.floor(index / 5);
    pieces.push({ id: `extra:${pad.note}`, shape: "drum", x: 400 - column * 28, y: 96 + (index % 5) * 26, r: 11, pads: [pad] });
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
 * would see. Clicking a piece, or pressing Enter on it, hits its first Pad.
 */
export function DrumKit({ trackName, pads, hitting, onHit }: DrumKitProps) {
  const pieces = kitPieces(pads);
  const hit = pads.filter((pad) => hitting.has(pad.note));
  const lit = (piece: KitPiece) => piece.pads.some((pad) => hitting.has(pad.note));

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
          const interactive = pad !== undefined && onHit !== undefined;
          return (
            <g
              key={piece.id}
              className="drum-kit-piece"
              data-shape={piece.shape}
              data-hit={lit(piece) ? "true" : undefined}
              data-empty={pad === undefined ? "true" : undefined}
              role={interactive ? "button" : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={interactive ? `Hit ${label}` : undefined}
              onPointerDown={interactive ? () => onHit(pad.note, true) : undefined}
              onPointerUp={interactive ? () => onHit(pad.note, false) : undefined}
              onPointerLeave={interactive ? () => onHit(pad.note, false) : undefined}
              onKeyDown={
                interactive
                  ? (event) => {
                      if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
                        event.preventDefault();
                        onHit(pad.note, true);
                      }
                    }
                  : undefined
              }
              onKeyUp={interactive ? () => onHit(pad.note, false) : undefined}
            >
              <title>{label || "No Pad"}</title>
              {piece.shape === "cymbal" || piece.shape === "hat" ? (
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
                <text x={piece.x} y={piece.shape === "cymbal" ? piece.y - piece.r * 0.32 - 4 : piece.y + 4} className="drum-kit-label">
                  {piece.pads.length > 1 ? `${pad.name} +${piece.pads.length - 1}` : pad.name}
                </text>
              )}
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
