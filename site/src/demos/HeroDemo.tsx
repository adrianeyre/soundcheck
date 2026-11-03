import { Play, Undo2 } from "lucide-react";

import { Bar, Collapse, Field, Spinner, Stage, Stream, Window, type Act } from "../kit-parts";
import { Timeline, type Clip, type Lane, type Section } from "./Timeline";
import "./look.css";
import "./hero.css";

// The website's hero: Soundcheck's Editor, where an Assistant Request adds a
// build-up before the drop. Built on Stageshow's `ai-chat` gold (the question
// sent, a working state, the answer streaming in at its own height) beside
// the product's Timeline.
//
// Beats: the Request is typed and sent; the Assistant listens to the bars
// before the drop (it renders the song and hears it, which is the product's
// point); as its answer streams, the Drop and everything after it slide four
// bars right as one, and the Build-up Section and its two Clips open into
// the gap; the changes it made settle under the answer. Plays once: the
// still is the payoff, and Replay remounts it.
//
// Real strings: the song, the Track names, the Sections, the Request, the
// answer and its two changes. The earlier turn in the thread is placeholder.

const REQUEST = "Add a four-bar build-up before the drop";
const ANSWER =
  "I listened to bars 9 to 12. Added a Build-up at bar 13 with a snare roll that doubles every bar, and opened the Keys into the drop, which now starts at bar 17.";
const WORDS = ANSWER.split(" ").length;

type Phase = "idle" | "listening" | "answer";
type S = { draft: string; sent: boolean; phase: Phase; words: number; built: boolean; changes: boolean };

const initial: S = { draft: "", sent: false, phase: "idle", words: 0, built: false, changes: false };
const poster: S = { draft: "", sent: true, phase: "answer", words: WORDS, built: true, changes: true };

async function script(a: Act<S>) {
  await a.wait(800);
  a.mark("type");
  await a.type("draft", REQUEST, { interval: 36 });
  await a.wait(380);
  a.mark("send");
  a.put({ sent: true, draft: "" });
  await a.wait(420);
  a.mark("listen");
  a.put({ phase: "listening" });
  await a.wait(1500);
  a.mark("answer");
  a.put({ phase: "answer" });
  for (let i = 1; i <= WORDS; i++) {
    a.put({ words: i });
    // The song changes as the answer reaches it, a third of the way in.
    if (i === 10) {
      a.mark("build");
      a.put({ built: true });
    }
    await a.wait(45);
  }
  await a.wait(320);
  a.mark("changes");
  a.put({ changes: true });
  await a.wait(3200);
}

const LANES: Lane[] = [
  { name: "Drums", kind: "drum" },
  { name: "Bass", kind: "instrument" },
  { name: "Keys", kind: "instrument" },
  { name: "Lead", kind: "instrument" },
  { name: "Pad", kind: "instrument" },
  { name: "Perc", kind: "drum" },
  { name: "Arp", kind: "instrument" },
];

function song(built: boolean): { sections: Section[]; clips: Clip[] } {
  const after = built ? 4 : 0;
  return {
    sections: [
      { id: "intro", name: "Intro", bar: 0, bars: 4 },
      { id: "verse", name: "Verse", bar: 4, bars: 8 },
      { id: "build", name: "Build-up", bar: 12, bars: 4, hidden: !built, lit: true },
      { id: "drop", name: "Drop", bar: 12, bars: 8, shift: after },
    ],
    clips: [
      { id: "d-intro", lane: 0, bar: 0, bars: 4 },
      { id: "d-verse", lane: 0, bar: 4, bars: 8 },
      { id: "d-roll", lane: 0, bar: 12, bars: 4, roll: true, hidden: !built, lit: true },
      { id: "d-drop", lane: 0, bar: 12, bars: 8, shift: after },
      { id: "b-verse", lane: 1, bar: 4, bars: 8 },
      { id: "b-drop", lane: 1, bar: 12, bars: 8, shift: after },
      { id: "k-intro", lane: 2, bar: 0, bars: 4 },
      { id: "k-verse", lane: 2, bar: 4, bars: 8 },
      { id: "k-rise", lane: 2, bar: 12, bars: 4, hidden: !built, lit: true },
      { id: "k-drop", lane: 2, bar: 12, bars: 8, shift: after },
      { id: "l-drop", lane: 3, bar: 12, bars: 8, shift: after },
      { id: "p-intro", lane: 4, bar: 0, bars: 4 },
      { id: "p-verse", lane: 4, bar: 4, bars: 8 },
      { id: "p-drop", lane: 4, bar: 12, bars: 8, shift: after },
      { id: "c-verse", lane: 5, bar: 8, bars: 4 },
      { id: "c-drop", lane: 5, bar: 12, bars: 8, shift: after },
      { id: "a-verse", lane: 6, bar: 8, bars: 4 },
      { id: "a-drop", lane: 6, bar: 12, bars: 8, shift: after },
    ],
  };
}

export default function HeroDemo() {
  return (
    <Stage<S>
      width={1112}
      height={560}
      compact={{ below: 760, width: 358, height: 640 }}
      theme="dark"
      fidelity="standard"
      initial={initial}
      poster={poster}
      script={script}
      play="once"
      className="sc-look sc-hero"
    >
      {(s, _rect, layout) => {
        const compact = layout === "compact";
        const { sections, clips: all } = song(s.built);
        // The phone column keeps the four Tracks the story touches, so the Assistant has the room
        const lanes = compact ? LANES.slice(0, 4) : LANES;
        const clips = all.filter((c) => c.lane < lanes.length);
        return (
          <Window title="Night Drive" className="sc-hero__win">
            <div className="sc-hero__transport">
              <span className="sc-hero__play">
                <Play size={14} strokeWidth={2.25} />
                Play
              </span>
              <span className="sc-hero__pos">1.1.000</span>
              <span className="sc-hero__meta">122 BPM</span>
              <span className="sc-hero__meta">4/4</span>
              {!compact && (
                <span className="sc-hero__undo" aria-hidden>
                  <Undo2 size={14} strokeWidth={2} />
                </span>
              )}
            </div>
            <div className="sc-hero__body">
              <section className="sc-hero__assistant">
                <div className="sc-hero__title">Assistant</div>
                <div className="sc-hero__thread">
                  <div className="sc-hero__past">
                    <Bar w={168} h={28} r={14} tone={2} className="sc-hero__past-q" />
                    <Bar w="88%" h={7} r={3.5} tone={2} />
                    <Bar w="64%" h={7} r={3.5} tone={2} />
                  </div>
                  <Collapse open={s.sent} reveal="drop" from="below">
                    <div className="sc-hero__q">{REQUEST}</div>
                  </Collapse>
                  <Collapse open={s.phase === "listening"}>
                    <div className="sc-hero__status">
                      <Spinner size={12} />
                      Listening to bars 9–12
                    </div>
                  </Collapse>
                  <Collapse open={s.phase === "answer"}>
                    <div className="sc-hero__a">
                      <Stream className="sc-hero__stream" text={ANSWER} count={s.words} />
                      <div className="sc-hero__changes" data-on={s.changes || undefined}>
                        <span className="sc-hero__change">
                          <i data-kind="section" />
                          Section Build-up, bars 13–16
                        </span>
                        <span className="sc-hero__change">
                          <i data-kind="clip" />2 Clips added, 4 moved
                        </span>
                      </div>
                    </div>
                  </Collapse>
                </div>
                <Field
                  className="sc-hero__composer"
                  value={s.draft}
                  placeholder="Ask for a change, or type / for a Skill"
                  focused={!s.sent}
                />
              </section>
              <section className="sc-hero__timeline">
                <div className="sc-hero__title">Timeline</div>
                <Timeline
                  lanes={lanes}
                  clips={clips}
                  sections={sections}
                  bars={compact ? 19 : 28}
                  barWidth={compact ? 14 : 30}
                  header={compact ? 64 : 96}
                  laneHeight={compact ? 32 : 46}
                />
              </section>
            </div>
          </Window>
        );
      }}
    </Stage>
  );
}

/** What a still of the hero says, for the page's text alternative. */
export const HERO_DESCRIPTION = `Soundcheck's Editor. The Request "${REQUEST}" has been sent, and the Assistant has answered: "${ANSWER}" On the Timeline, a Build-up Section and two Clips sit before the Drop.`;
