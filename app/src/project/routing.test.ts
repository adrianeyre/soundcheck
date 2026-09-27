import { expect, test } from "vitest";

import { sampleProject } from "./fixtures";
import { createBus } from "./model";
import { busesOnTheWay, outputName, routingLoop, routingProblem, sendProblem, silencedChannels } from "./routing";

/** Keys → Drums → Band → Master, Bass → Band. */
function routed() {
  const project = sampleProject();
  project.buses.push({ ...createBus("Drums", "drum-bus"), output: "band" });
  project.tracks[0]!.output = "drum-bus";
  return project;
}

test("a signal's way to the Master names every Bus it passes", () => {
  const project = routed();
  expect(busesOnTheWay(project, "drum-bus").map((bus) => bus.name)).toEqual(["Drums", "Band"]);
  expect(busesOnTheWay(project, null)).toEqual([]);
  expect(outputName(project, null)).toBe("the Master");
  expect(outputName(project, "band")).toBe("Band");
});

test("a route that would loop is refused with the loop spelled out; others are fine", () => {
  const project = routed();
  expect(routingProblem(project, { busId: "band" }, "drum-bus")).toBe(
    "Band can't feed Drums: the signal would go round in a loop (Band → Drums → Band)",
  );
  expect(routingProblem(project, { busId: "drum-bus" }, "drum-bus")).toBe("Drums can't feed itself");
  expect(routingProblem(project, { busId: "drum-bus" }, null)).toBeNull();
  // A Track can feed any Bus: nothing feeds a Track.
  expect(routingProblem(project, { trackId: "bass" }, "drum-bus")).toBeNull();
  expect(routingProblem(project, { trackId: "bass" }, "gone")).toBe("There is no Bus gone");
  expect(routingLoop(project)).toBeNull();
  project.buses[0]!.output = "drum-bus";
  expect(routingLoop(project)).toEqual(["Band", "Drums", "Band"]);
});

test("mute and solo silence channels as the engine does", () => {
  const project = routed();
  expect(silencedChannels(project)).toEqual(new Set());

  // Soloing Drums plays Keys, which feeds it, and Band, which it feeds.
  project.buses[1]!.mixer.solo = true;
  expect(silencedChannels(project)).toEqual(new Set(["bass", "vocals", "drums"]));

  // Muting Band silences everything that passes through it.
  project.buses[1]!.mixer.solo = false;
  project.buses[0]!.mixer.mute = true;
  expect(silencedChannels(project)).toEqual(new Set(["keys", "bass", "band", "drum-bus"]));
});

test("a Send can't close a loop, and a loop through a Send is found", () => {
  const project = routed();
  project.buses.push(createBus("Reverb", "verb"));
  expect(sendProblem(project, { busId: "band" }, "drum-bus")).toBe(
    "Band can't send to Drums: the signal would go round in a loop (Band → Drums → Band)",
  );
  expect(sendProblem(project, { busId: "verb" }, "verb")).toBe("Reverb can't send to itself");
  expect(sendProblem(project, { trackId: "keys" }, "verb")).toBeNull();
  project.buses[0]!.sends.push({ busId: "verb", level: 1 });
  // Band now sends to Reverb, so Reverb can't feed Drums, which feeds Band.
  expect(routingProblem(project, { busId: "verb" }, "drum-bus")).toBe(
    "Reverb can't feed Drums: the signal would go round in a loop (Reverb → Drums → Band → Reverb)",
  );
  expect(sendProblem(project, { busId: "band" }, "verb")).toBe("Band already sends to Reverb");
  expect(routingLoop(project)).toBeNull();
  project.buses[2]!.sends.push({ busId: "drum-bus", level: 1 });
  expect(routingLoop(project)).toEqual(["Band", "Reverb", "Drums", "Band"]);
});

test("a Send is heard past a muted output, and soloing follows it", () => {
  const project = routed();
  project.buses.push(createBus("Reverb", "verb"));
  project.tracks[0]!.sends.push({ busId: "verb", level: 1 });
  // Muting Band cuts Keys' way through Drums, but not its Send.
  project.buses[0]!.mixer.mute = true;
  expect(silencedChannels(project)).toEqual(new Set(["bass", "band", "drum-bus"]));
  project.buses[0]!.mixer.mute = false;

  // Soloing Keys plays Reverb, which it sends to, and not Bass or Vocals.
  project.tracks[0]!.mixer.solo = true;
  expect(silencedChannels(project)).toEqual(new Set(["bass", "vocals", "drums"]));
  // Soloing Reverb plays Keys, which sends to it, and whatever Keys feeds.
  project.tracks[0]!.mixer.solo = false;
  project.buses[2]!.mixer.solo = true;
  expect(silencedChannels(project)).toEqual(new Set(["bass", "vocals", "drums", "band", "drum-bus"]));
});
