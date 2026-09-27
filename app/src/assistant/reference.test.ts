import { readFileSync } from "node:fs";

import { initSync } from "@engine";
import { beforeAll, expect, test } from "vitest";

import { wasmAudioAnalyser } from "../audio/audio-analyser";
import { ProjectHistory } from "../project/history";
import { createAudioTrack, createProject, type Project } from "../project/model";
import { stereoWav } from "../song/test-wav";
import { runRequest, type Conversation, type ModelReply, type ToolResult } from "./assistant";
import type { KeptAnalysis } from "./compare";
import { listenWith } from "./listen";
import { compareToReference, hearReferenceIn } from "./reference";
import type { ToolCall } from "./tools";

// The real WASM engine renders the mix and measures both.
beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

const RATE = 48_000;
const sine = (hz: number, level: number, i: number) => level * Math.sin((2 * Math.PI * hz * i) / RATE);
/** Two seconds of the song: a 1 kHz tone. */
const MIX = Array.from({ length: 2 * RATE }, (_, i) => sine(1_000, 0.5, i));
/** The finished song to sound like: louder, and with a bass the mix hasn't got. */
const FINISHED = Array.from({ length: 2 * RATE }, (_, i) => sine(1_000, 0.5, i) + sine(80, 0.4, i));
const REFERENCE = "audio/Finished.wav";

/** One Audio Track, "Song", playing the tone at a quarter of unity, and a Reference Track. */
function project(): Project {
  const song = createProject("Mine");
  const track = createAudioTrack("Song", "song");
  track.mixer.volume = 0.25;
  track.clips.push({ id: "song-1", kind: "audio", start: 0, duration: 2, file: "audio/song.wav", fileOffset: 0 });
  song.tracks.push(track);
  song.referenceTrack = { file: REFERENCE };
  return song;
}

const samples = new Map([
  ["audio/song.wav", { name: "song.wav", bytes: stereoWav(MIX, MIX, RATE) }],
  [REFERENCE, { name: "Finished.wav", bytes: stereoWav(FINISHED, FINISHED, RATE) }],
]);
const listen = listenWith(wasmAudioAnalyser(() => Promise.resolve()), samples);
const hearReference = hearReferenceIn(samples);

/** Claude, replaced by a script. What the Assistant sent back is kept. */
function scripted(...replies: ModelReply[]) {
  const sent: (readonly ToolResult[])[] = [];
  let turn = 0;
  const conversation: Conversation = {
    next(results) {
      sent.push(results);
      const reply = replies[turn++];
      if (!reply) throw new Error("the Assistant asked for more turns than the script has");
      return Promise.resolve(reply);
    },
  };
  return { start: () => conversation, sent };
}

const calls = (...toolCalls: ToolCall[]): ModelReply => ({ text: "", toolCalls });
const says = (text: string): ModelReply => ({ text, toolCalls: [] });

type Against = { mix: number; reference: number; difference: number; matched?: number };

function comparison(result: ToolResult) {
  const [heading, json, verdict] = result.content.split("\n");
  return { heading, verdict, compared: JSON.parse(json!) as Record<string, Against> & { bands_db: Record<string, Against> } };
}

test("asked to sound more like the reference, the Assistant compares, makes a change, and compares again: it came closer", async () => {
  const history = new ProjectHistory(project());
  const { start, sent } = scripted(
    calls({ id: "before", name: "compare_to_reference", input: {} }),
    calls({ id: "fix", name: "set_track_volume", input: { trackId: "song", volume: 1 } }),
    calls({ id: "after", name: "compare_to_reference", input: {} }),
    says("Your mix was quieter than the reference and has no bass; I brought it up to the reference's loudness."),
  );

  const outcome = await runRequest({ history, request: "make my mix sound more like the reference", start, listen, hearReference });

  expect(outcome.error).toBeNull();
  const results = new Map(sent.flat().map((result) => [result.callId, result]));
  expect(results.get("before")!.isError).toBe(false);
  const before = comparison(results.get("before")!);
  expect(before.heading).toMatch(
    /^The whole mix, from 1\.1\.000 \(0 s\) to 2\.1\.000 \(2 s\) \(analysisId a1, which compare_audio takes\), against the Reference Track “Finished\.wav”, all 2 s of it\./,
  );
  // A quarter of unity is 12 dB down, and the reference is louder still for its bass.
  expect(before.compared.integrated_lufs!.difference).toBeLessThan(-12);
  expect(before.compared.integrated_lufs!.mix).toBeCloseTo(before.compared.integrated_lufs!.reference + before.compared.integrated_lufs!.difference, 1);
  // With the loudness matched, the mix has far less bass than the reference.
  expect(before.compared.bands_db.bass!.matched).toBeLessThan(-10);
  expect(before.verdict).toMatch(/^The mix is \d+(\.\d)? LU quieter than the reference overall\. With the loudness matched: .*the bass band \d+(\.\d)? dB less than the reference's/);

  // The fix brought the mix 12 dB closer, and the reference is measured the same.
  const after = comparison(results.get("after")!);
  expect(after.heading).toContain("analysisId a2");
  expect(after.compared.integrated_lufs!.difference - before.compared.integrated_lufs!.difference).toBeCloseTo(12, 0);
  expect(after.compared.integrated_lufs!.reference).toBe(before.compared.integrated_lufs!.reference);

  // Comparing is not a change: the summary and the undo step are the fix alone.
  expect(outcome.changes).toEqual(["Set “Song” to 0.0 dB"]);
  history.undo();
  expect(history.project).toEqual(project());
});

/** What the one compare_to_reference call of a Request on `song` is told. */
async function refusal(song: Project, options: Partial<Parameters<typeof runRequest>[0]> = {}) {
  const { start, sent } = scripted(calls({ id: "compare", name: "compare_to_reference", input: {} }), says("No."));
  await runRequest({ history: new ProjectHistory(song), request: "compare with the reference", start, listen, hearReference, ...options });
  return sent[1]![0]!;
}

test("without a Reference Track, a way to measure it or its file, the comparison is refused, saying why", async () => {
  const without = { ...project(), referenceTrack: null };
  expect(await refusal(without)).toMatchObject({ isError: true, content: expect.stringMatching(/no Reference Track/) });
  expect(await refusal(project(), { hearReference: undefined })).toMatchObject({ isError: true, content: "Listening isn't available here." });
  const lost = { ...project(), referenceTrack: { file: "audio/gone.wav" } };
  expect(await refusal(lost)).toMatchObject({
    isError: true,
    content: expect.stringMatching(/^The Reference Track couldn't be measured: gone\.wav isn't in the Project folder/),
  });
});

/** The engine's measurements, as much of them as a comparison reads, of 180 s at `lufs`. */
function measured(lufs: number | null, bands: Record<string, number | null>): string {
  return JSON.stringify({ end: { s: 180.04 }, loudness: { integrated_lufs: lufs, max_short_term_lufs: lufs }, rms_db: lufs, true_peak_dbtp: 0, bands_db: bands });
}

test("a band's matched difference leaves out the difference in loudness, and only differences of 1 dB or more are named", () => {
  const mix: KeptAnalysis = {
    id: "a1",
    trackId: null,
    what: "the whole mix",
    span: "from 1.1.000 (0 s) to 2.1.000 (2 s)",
    start: 0,
    end: 3840,
    measurements: measured(-14, { bass: -20, mid: -16, high: -30.5 }),
  };
  const { compared, verdict, heading } = comparison({
    callId: "c",
    isError: false,
    content: compareToReference(mix, "Finished.wav", measured(-8, { bass: -12, mid: -10.5, high: -24 })),
  });
  expect(heading).toContain("all 180 s of it");
  expect(compared.integrated_lufs).toEqual({ mix: -14, reference: -8, difference: -6 });
  expect(compared.bands_db).toEqual({
    bass: { mix: -20, reference: -12, difference: -8, matched: -2 },
    mid: { mix: -16, reference: -10.5, difference: -5.5, matched: 0.5 },
    high: { mix: -30.5, reference: -24, difference: -6.5, matched: -0.5 },
  });
  expect(verdict).toBe("The mix is 6 LU quieter than the reference overall. With the loudness matched: the bass band 2 dB less than the reference's.");

  const same = compareToReference({ ...mix, measurements: measured(-8, { bass: -12 }) }, "Finished.wav", measured(-8.5, { bass: -12 }));
  expect(same.split("\n")[2]).toBe("The mix is within 1 LU of the reference's loudness. With the loudness matched: every band within 1 dB of the reference's.");
  const silent = compareToReference({ ...mix, measurements: measured(null, { bass: null }) }, "Finished.wav", measured(-8, { bass: -12 }));
  expect(silent.split("\n")[2]).toBe("One of them is silent, so they can't be compared.");
});
