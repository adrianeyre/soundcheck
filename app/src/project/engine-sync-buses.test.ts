import { readFileSync } from "node:fs";

import { Engine, initSync } from "@engine";
import { beforeAll, describe, expect, test } from "vitest";

import { applyEngineCommand } from "../audio/apply-engine-command";
import type { EngineCommand } from "../audio/audio-output";
import { busChain } from "../audio/gain-reduction";
import { applyCommand, type Command } from "./commands";
import { EngineSync } from "./engine-sync";
import { createBus, createEffect, createInstrumentTrack, createProject, type Project } from "./model";
import { TICKS_PER_BEAT } from "./time";

const BAR = TICKS_PER_BEAT * 4;

/** Three Tracks, each holding one note for a bar, and two Buses. */
function project(): Project {
  const song = createProject();
  [48, 55, 64].forEach((pitch, index) => {
    const track = createInstrumentTrack(`Synth ${index + 1}`, `t${index}`);
    track.clips.push({ id: `c${index}`, kind: "pattern", start: 0, length: BAR, notes: [{ pitch, start: 0, length: BAR, velocity: 1 }] });
    song.tracks.push(track);
  });
  song.buses.push(createBus("A", "a"), createBus("B", "b"));
  return song;
}

function edited(from: Project, ...commands: Command[]): Project {
  let current = from;
  for (const command of commands) {
    const result = applyCommand(current, command);
    if (!result.ok) throw new Error(result.error);
    current = result.project;
  }
  return current;
}

describe("EngineSync's Buses", () => {
  test("sends the Buses before the Tracks that feed them, then only what changed", () => {
    const sync = new EngineSync();
    const routed = edited(
      project(),
      { type: "setBusMixer", busId: "b", mixer: { volume: 0.5 } },
      { type: "addEffect", target: { busId: "b" }, effect: createEffect("eq", "b-eq") },
      { type: "setBusOutput", busId: "a", output: "b" },
      { type: "setTrackOutput", trackId: "t1", output: "a" },
    );
    const commands = sync.update(routed);
    const routing = commands.filter((command) => /Bus|Output/.test(command.type) || command.type === "setTrackCount");
    expect(routing.map(({ type, ...rest }) => ({ type, ...rest, settings: undefined }))).toEqual([
      { type: "setBusCount", count: 2, settings: undefined },
      { type: "setBusMixer", bus: 1, volume: 0.5, pan: 0, mute: false, solo: false, settings: undefined },
      { type: "setBusOutput", bus: 0, output: 1, settings: undefined },
      { type: "setTrackCount", count: 3, settings: undefined },
      { type: "setTrackOutput", track: 1, output: 0, settings: undefined },
    ]);
    expect(commands).toContainEqual({ type: "insertEffect", chain: busChain(1), index: 0, effect: "eq" });
    expect(sync.update(routed)).toEqual([]);

    const renamed = edited(routed, { type: "renameBus", busId: "a", name: "Anything" });
    expect(sync.update(renamed)).toEqual([]);
  });

  test("turning the routing round goes by the Master, so the engine never sees a loop", () => {
    const sync = new EngineSync();
    const aIntoB = edited(project(), { type: "setBusOutput", busId: "a", output: "b" });
    sync.update(aIntoB);
    const bIntoA = edited(aIntoB, { type: "setBusOutput", busId: "a", output: null }, { type: "setBusOutput", busId: "b", output: "a" });
    expect(sync.update(bIntoA)).toEqual([
      { type: "setBusOutput", bus: 0, output: -1 },
      { type: "setBusOutput", bus: 1, output: 0 },
    ]);
  });

  test("deleting a Bus lets the engine's last Bus go and moves the rest up", () => {
    const sync = new EngineSync();
    const before = edited(
      project(),
      { type: "setBusMixer", busId: "b", mixer: { volume: 0.5 } },
      { type: "setTrackOutput", trackId: "t0", output: "a" },
      { type: "setTrackOutput", trackId: "t2", output: "b" },
    );
    sync.update(before);
    // B takes A's place as engine Bus 0; what fed A now feeds the Master.
    expect(sync.update(edited(before, { type: "deleteBus", busId: "a" }))).toEqual([
      { type: "setBusCount", count: 1 },
      { type: "setBusMixer", bus: 0, volume: 0.5, pan: 0, mute: false, solo: false },
      // Track 2 fed engine Bus 1, which went, so the engine sent it to the Master.
      { type: "setTrackOutput", track: 0, output: -1 },
      { type: "setTrackOutput", track: 2, output: 0 },
    ]);
  });
});

describe("EngineSync's Sends", () => {
  test("sends each Track's and Bus's Sends by engine Bus, then only what changed", () => {
    const sync = new EngineSync();
    const sending = edited(
      project(),
      { type: "addSend", from: { trackId: "t0" }, busId: "b", level: 0.5 },
      { type: "addSend", from: { trackId: "t0" }, busId: "a", level: 0.25 },
      { type: "addSend", from: { busId: "a" }, busId: "b", level: 1.5 },
    );
    expect(sync.update(sending).filter((command) => command.type === "setSends")).toEqual([
      { type: "setSends", channel: busChain(0), sends: [1, 1.5] },
      { type: "setSends", channel: 0, sends: [1, 0.5, 0, 0.25] },
    ]);
    expect(sync.update(sending)).toEqual([]);
    const quieter = edited(sending, { type: "setSendLevel", from: { trackId: "t0" }, busId: "a", level: 0.125 });
    expect(sync.update(quieter)).toEqual([{ type: "setSends", channel: 0, sends: [1, 0.5, 0, 0.125] }]);
    const removed = edited(quieter, { type: "removeSend", from: { busId: "a" }, busId: "b" });
    expect(sync.update(removed)).toEqual([{ type: "setSends", channel: busChain(0), sends: [] }]);
  });

  test("turning a Send round clears it before the other way is sent, so the engine never sees a loop", () => {
    const sync = new EngineSync();
    const aSendsToB = edited(project(), { type: "addSend", from: { busId: "a" }, busId: "b", level: 1 });
    sync.update(aSendsToB);
    const bIntoA = edited(
      aSendsToB,
      { type: "removeSend", from: { busId: "a" }, busId: "b" },
      { type: "setBusOutput", busId: "b", output: "a" },
    );
    expect(sync.update(bIntoA)).toEqual([
      { type: "setSends", channel: busChain(0), sends: [] },
      { type: "setBusOutput", bus: 1, output: 0 },
    ]);
    const bSendsToA = edited(
      aSendsToB,
      { type: "removeSend", from: { busId: "a" }, busId: "b" },
      { type: "addSend", from: { busId: "b" }, busId: "a", level: 1 },
    );
    expect(sync.update(bSendsToA)).toEqual([
      { type: "setBusOutput", bus: 1, output: -1 },
      { type: "setSends", channel: busChain(1), sends: [0, 1] },
    ]);
  });

  test("deleting a Bus drops the Sends to it, and the rest follow their Bus to its new place", () => {
    const sync = new EngineSync();
    const before = edited(
      project(),
      { type: "addSend", from: { trackId: "t0" }, busId: "a", level: 0.5 },
      { type: "addSend", from: { trackId: "t1" }, busId: "b", level: 0.75 },
    );
    sync.update(before);
    expect(sync.update(edited(before, { type: "deleteBus", busId: "a" }))).toEqual([
      { type: "setBusCount", count: 1 },
      { type: "setSends", channel: 0, sends: [] },
      // B is engine Bus 0 now; the engine dropped the Send to engine Bus 1.
      { type: "setSends", channel: 1, sends: [0, 0.75] },
    ]);
  });
});

/** Drive the real WASM engine with the commands the UI sends, as the AudioWorklet does. */
function renderWith(commands: readonly EngineCommand[]): number[] {
  const engine = new Engine(48_000);
  try {
    for (const command of commands) applyEngineCommand(engine, command);
    return [...engine.render_range(0, TICKS_PER_BEAT)];
  } finally {
    engine.free();
  }
}

describe("Buses in the engine", () => {
  beforeAll(() => {
    initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
  });

  test("two Tracks routed to a Bus with an Effect are both processed by it", () => {
    const reverb = createEffect("reverb", "verb");
    const bussed = edited(
      project(),
      { type: "addEffect", target: { busId: "a" }, effect: reverb },
      { type: "setTrackOutput", trackId: "t0", output: "a" },
      { type: "setTrackOutput", trackId: "t1", output: "a" },
      { type: "setTrackMixer", trackId: "t2", mixer: { mute: true } },
    );
    const mastered = edited(
      project(),
      { type: "addEffect", target: "master", effect: reverb },
      { type: "setTrackMixer", trackId: "t2", mixer: { mute: true } },
    );
    const dry = edited(project(), { type: "setTrackMixer", trackId: "t2", mixer: { mute: true } });
    const heard = renderWith(new EngineSync().update(bussed));
    expect(heard).toEqual(renderWith(new EngineSync().update(mastered)));
    expect(heard).not.toEqual(renderWith(new EngineSync().update(dry)));
  });

  test("a Send plays its Track on its Bus too, after the fader, and the Master hears both", () => {
    const quiet = { type: "setTrackMixer", trackId: "t0", mixer: { volume: 0.5 } } as const;
    const muteOthers: Command[] = [
      { type: "setTrackMixer", trackId: "t1", mixer: { mute: true } },
      { type: "setTrackMixer", trackId: "t2", mixer: { mute: true } },
    ];
    const dry = edited(project(), quiet, ...muteOthers);
    const sending = edited(dry, { type: "addSend", from: { trackId: "t0" }, busId: "a", level: 0.5 });
    const louder = edited(dry, { type: "setTrackMixer", trackId: "t0", mixer: { volume: 0.75 } });
    // The Bus adds half the faded Track to its own output: 0.5 × 1.5.
    const heard = renderWith(new EngineSync().update(sending));
    const expected = renderWith(new EngineSync().update(louder));
    heard.forEach((sample, at) => expect(sample).toBeCloseTo(expected[at]!, 5));
    expect(heard).not.toEqual(renderWith(new EngineSync().update(dry)));
  });

  test("after any run of routing edits the engine plays what a fresh start on the Project plays", () => {
    // A seeded shuffle of Buses added and deleted, and Tracks and Buses
    // rerouted, a few edits at a time as an undo can make them, each Bus at
    // its own level so a wrong route is heard. The commands sent so far are
    // replayed on a new engine and compared with the Project sent afresh.
    let seed = 46;
    const random = () => {
      seed = (seed * 16_807) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const sync = new EngineSync();
    let current = project();
    const sent = [...sync.update(current)];
    let next = 0;
    let routedToBuses = 0;
    let busesSending = 0;
    for (let step = 0; step < 80; step++) {
      const edits = 1 + Math.floor(random() * 3);
      for (let edit = 0; edit < edits; edit++) {
        const outputs = [null, ...current.buses.map((bus) => bus.id)];
        const roll = random();
        const command: Command =
          roll < 0.2 || current.buses.length === 0
            ? { type: "addBus", bus: createBus(`Bus ${next}`, `bus${next++}`), index: Math.floor(random() * (current.buses.length + 1)) }
            : roll < 0.3
              ? { type: "deleteBus", busId: pick(current.buses).id }
              : roll < 0.45
                ? { type: "setTrackOutput", trackId: pick(current.tracks).id, output: pick(outputs) }
                : roll < 0.6
                  ? { type: "setBusOutput", busId: pick(current.buses).id, output: pick(outputs) }
                  : sendEdit(current, random, pick);
        const result = applyCommand(current, command);
        // A loop is refused, and that's fine: the next edit tries something else.
        if (result.ok) current = result.project;
      }
      current.buses.forEach((bus, index) => {
        bus.mixer.volume = 0.2 + ((index * 0.37 + step * 0.11) % 1.5);
      });
      routedToBuses += current.buses.filter((bus) => bus.output !== null).length;
      busesSending += current.buses.filter((bus) => bus.sends.length > 0).length;
      sent.push(...sync.update(current));
      expect(renderWith(sent)).toEqual(renderWith(new EngineSync().update(current)));
    }
    // The shuffle did route Buses into Buses, often.
    expect(routedToBuses).toBeGreaterThan(80);
    expect(busesSending).toBeGreaterThan(80);
  });
});

/** A Send added, changed or removed, on a Track or a Bus, at random. */
function sendEdit(song: Project, random: () => number, pick: <T>(items: readonly T[]) => T): Command {
  const owners = [
    ...song.tracks.map((track) => ({ from: { trackId: track.id }, sends: track.sends })),
    ...song.buses.map((bus) => ({ from: { busId: bus.id }, sends: bus.sends })),
  ];
  const { from, sends } = pick(owners);
  const level = Math.round(random() * 16) / 8;
  if (sends.length === 0 || random() < 0.4) return { type: "addSend", from, busId: pick(song.buses).id, level };
  const { busId } = pick(sends);
  return random() < 0.5 ? { type: "setSendLevel", from, busId, level } : { type: "removeSend", from, busId };
}
