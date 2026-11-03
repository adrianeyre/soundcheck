import { Check, Headphones, Play } from "lucide-react";

import { Avatar, Chart, Collapse, Facepile, Stage, Window, type Act } from "../kit-parts";
import { Timeline, type Clip, type Lane, type Section } from "./Timeline";
import { Wave } from "./Wave";
import "./look.css";
import "./features.css";

// The feature tiles. Each is one thing the product does, in its own UI,
// pinned with a bottom bleed (Stageshow's `static-card` and `dark-bento`
// golds): one surface leading, real words only on what the tile is about.

const TILE = { width: 548, height: 320, compact: { below: 520, width: 358, height: 300 } } as const;

/* ---------------------------------------------------------------------------
 * The Mix Helper: it listens to the mix and says what it hears (ADR 0015).
 * The spectrum is the hero; the suggestion straddles its left edge.
 */
const SPECTRUM = [22, 30, 46, 74, 92, 86, 70, 58, 52, 48, 50, 47, 44, 40, 38, 35, 31, 27, 22, 18];

export function MixHelperTile() {
  return (
    <Stage width={TILE.width} height={TILE.height} compact={TILE.compact} theme="dark" className="sc-look sc-tile sc-mix">
      {(_s, _r, layout) => (
        <>
          <Window title="Master" className="sc-mix__win">
            <div className="sc-mix__body">
              <div className="sc-mix__head">
                <span className="sc-mix__lufs">
                  −9.8 <small>LUFS</small>
                </span>
              </div>
              <div className="sc-mix__chart">
                <span className="sc-mix__band" />
                <Chart data={SPECTRUM} width={layout === "compact" ? 286 : 300} height={150} max={100} dot={false} />
              </div>
              <div className="sc-mix__axis">
                <span>30</span>
                <span>100</span>
                <span>1k</span>
                <span>10k Hz</span>
              </div>
            </div>
          </Window>
          <div className="sc-mix__note">
            <div className="sc-mix__note-title">
              <Headphones size={14} strokeWidth={2} />
              Mix Helper
            </div>
            <p>Kick and Bass both peak around 70 Hz. Cut the Bass 3 dB there?</p>
            <div className="sc-mix__actions">
              <span className="sc-mix__apply">Apply</span>
              <span className="sc-mix__later">Not now</span>
            </div>
          </div>
        </>
      )}
    </Stage>
  );
}

/* ---------------------------------------------------------------------------
 * Stem Separation: one Audio Clip becomes four Stems, a lane each, opening
 * one after another as the model finishes them.
 */
const STEMS = [
  { name: "Vocals", shape: "phrases", seed: 3 },
  { name: "Drums", shape: "hits", seed: 7 },
  { name: "Bass", shape: "low", seed: 11 },
  { name: "Other", shape: "full", seed: 5 },
] as const;

type StemsState = { shown: number; done: boolean };

async function stemsScript(a: Act<StemsState>) {
  await a.wait(900);
  for (let i = 1; i <= STEMS.length; i++) {
    a.put({ shown: i });
    await a.wait(520);
  }
  a.put({ done: true });
  await a.wait(600);
}

export function StemsTile() {
  return (
    <Stage<StemsState>
      width={TILE.width}
      height={TILE.height}
      compact={TILE.compact}
      theme="dark"
      initial={{ shown: 0, done: false }}
      poster={{ shown: STEMS.length, done: true }}
      script={stemsScript}
      play="once"
      className="sc-look sc-tile sc-stems"
    >
      {(s, _r, layout) => {
        const width = layout === "compact" ? 250 : 380;
        return (
          <Window title="Timeline" className="sc-stems__win">
            <div className="sc-stems__body">
              <div className="sc-stems__lane sc-stems__lane--source">
                <span className="sc-stems__name">Full mix</span>
                <span className="sc-stems__clip">
                  <Wave seed={1} width={width} height={30} />
                </span>
              </div>
              <div className="sc-stems__status" data-done={s.done || undefined}>
                {s.done ? <Check size={13} strokeWidth={2.5} /> : <span className="sc-stems__dot" />}
                {s.done ? "Separated into 4 Stems" : "Separating into Stems"}
              </div>
              {STEMS.map((stem, i) => (
                <Collapse key={stem.name} open={s.shown > i} reveal="drop">
                  <div className="sc-stems__lane">
                    <span className="sc-stems__name">{stem.name}</span>
                    <span className="sc-stems__clip">
                      <Wave seed={stem.seed} width={width} height={24} shape={stem.shape} />
                    </span>
                  </div>
                </Collapse>
              ))}
            </div>
          </Window>
        );
      }}
    </Stage>
  );
}

/* ---------------------------------------------------------------------------
 * The DJ Mixer: two Decks beat-matched, their waveforms stacked as the
 * Mixer page draws them, the crossfader between.
 */
export function DjTile() {
  return (
    <Stage width={TILE.width} height={TILE.height} compact={TILE.compact} theme="dark" className="sc-look sc-tile sc-dj">
      {(_s, _r, layout) => {
        const width = layout === "compact" ? 294 : 438;
        return (
          <Window title="Mixer" className="sc-dj__win">
            <div className="sc-dj__body">
              {[
                { n: 1, track: "Night Drive", bpm: "124.00", seed: 21, key: "8A" },
                { n: 2, track: "Low Tide", bpm: "124.00", seed: 34, key: "9A" },
              ].map((deck) => (
                <div key={deck.n} className="sc-dj__deck" data-deck={deck.n}>
                  <div className="sc-dj__info">
                    <span className="sc-dj__n">{deck.n}</span>
                    <span className="sc-dj__track">{deck.track}</span>
                    <span className="sc-dj__bpm">{deck.bpm} BPM</span>
                    <span className="sc-dj__key">{deck.key}</span>
                    <span className="sc-dj__sync">Sync</span>
                  </div>
                  <div className="sc-dj__wave">
                    <Wave seed={deck.seed} width={width} height={40} shape="hits" bars={Math.round(width / 2.5)} />
                    <span className="sc-dj__playhead" />
                  </div>
                </div>
              ))}
              <div className="sc-dj__controls">
                <span className="sc-dj__play">
                  <Play size={13} strokeWidth={2.25} />
                </span>
                <span className="sc-dj__fader">
                  <span className="sc-dj__thumb" />
                </span>
                <span className="sc-dj__play" data-on>
                  <Play size={13} strokeWidth={2.25} />
                </span>
              </div>
            </div>
          </Window>
        );
      }}
    </Stage>
  );
}

/* ---------------------------------------------------------------------------
 * Live Sessions: the people in one song, each in one colour everywhere: on
 * the Facepile and on the Clip they have selected.
 */
const LIVE_LANES: Lane[] = [
  { name: "Drums", kind: "drum" },
  { name: "Bass", kind: "instrument" },
  { name: "Keys", kind: "instrument" },
  { name: "Lead", kind: "instrument" },
];
const LIVE_SECTIONS: Section[] = [
  { id: "v", name: "Verse", bar: 0, bars: 8 },
  { id: "c", name: "Chorus", bar: 8, bars: 8 },
];
const LIVE_CLIPS: Clip[] = [
  { id: "d1", lane: 0, bar: 0, bars: 8 },
  { id: "d2", lane: 0, bar: 8, bars: 8 },
  { id: "b1", lane: 1, bar: 0, bars: 8 },
  { id: "b2", lane: 1, bar: 8, bars: 8 },
  { id: "k1", lane: 2, bar: 0, bars: 16 },
  { id: "l1", lane: 3, bar: 8, bars: 8 },
];

export function LiveTile() {
  return (
    <Stage width={TILE.width} height={TILE.height} compact={TILE.compact} theme="dark" className="sc-look sc-tile sc-live">
      {(_s, _r, layout) => {
        const compact = layout === "compact";
        const bw = compact ? 16 : 24;
        const header = compact ? 64 : 84;
        return (
          <Window title="Night Drive" className="sc-live__win">
            <div className="sc-live__bar">
              <span className="sc-live__badge">
                <span className="sc-live__dot" />
                Live Session
              </span>
              <Facepile names={["Adrian Eyre", "Sam Cole", "Maya Lin"]} size={22} />
            </div>
            <div className="sc-live__tl">
              <Timeline lanes={LIVE_LANES} clips={LIVE_CLIPS} sections={LIVE_SECTIONS} bars={16} barWidth={bw} header={header} laneHeight={40} />
              <span className="sc-live__sel" data-who="sam" style={{ left: header + 8 * bw, top: 30 + 22 + 40, width: 8 * bw }}>
                <span className="sc-live__tag">
                  <Avatar name="Sam Cole" size={14} />
                  Sam
                </span>
              </span>
              <span className="sc-live__sel" data-who="maya" style={{ left: header + 8 * bw, top: 30 + 22 + 3 * 40, width: 8 * bw }}>
                <span className="sc-live__tag">
                  <Avatar name="Maya Lin" size={14} />
                  Maya
                </span>
              </span>
            </div>
          </Window>
        );
      }}
    </Stage>
  );
}
