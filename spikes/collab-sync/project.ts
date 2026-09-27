/**
 * A small Project in the app's shape (Tracks, Buses, Sends, Clips with notes,
 * Insert Chains, Sections, the Master and the Reference Track) and the rules
 * `validate.ts` keeps that two people's edits could break together: a Send
 * feeds a Bus that exists, never makes a loop, and Sections never overlap.
 */
import type { JsonObject } from "./flat.ts";

export interface Send {
  busId: string;
  level: number;
}
export interface Effect {
  id: string;
  type: string;
  bypassed: boolean;
  settings: Record<string, number>;
}
export interface Note {
  pitch: number;
  start: number;
  length: number;
  velocity: number;
}
export interface Clip {
  id: string;
  start: number;
  length: number;
  notes: Note[];
}
export interface Mixer {
  volume: number;
  pan: number;
}
export interface Track {
  id: string;
  name: string;
  mixer: Mixer;
  sends: Send[];
  insertChain: Effect[];
  clips: Clip[];
}
export interface Bus {
  id: string;
  name: string;
  mixer: Mixer;
  sends: Send[];
  insertChain: Effect[];
}
export interface Section {
  id: string;
  name: string;
  startBar: number;
  bars: number;
}
export interface Project {
  name: string;
  tempo: number;
  sections: Section[];
  tracks: Track[];
  buses: Bus[];
  master: { volume: number; insertChain: Effect[] };
  referenceTrack: { file: string } | null;
}

export function track(id: string, name = id): Track {
  return { id, name, mixer: { volume: 1, pan: 0 }, sends: [], insertChain: [], clips: [] };
}

export function bus(id: string, name = id): Bus {
  return { id, name, mixer: { volume: 1, pan: 0 }, sends: [], insertChain: [] };
}

export function reverb(id: string): Effect {
  return { id, type: "reverb", bypassed: false, settings: { mix: 0.3, size: 0.5 } };
}

/** Two Tracks and two Buses, with a Send from the first Track to the first Bus. */
export function startingProject(): Project {
  const drums = track("t-drums", "Drums");
  drums.sends = [{ busId: "b-verb", level: 0.5 }];
  drums.clips = [{ id: "c-beat", start: 0, length: 3840, notes: [{ pitch: 36, start: 0, length: 240, velocity: 1 }] }];
  return {
    name: "Song",
    tempo: 120,
    sections: [{ id: "s-intro", name: "Intro", startBar: 1, bars: 4 }],
    tracks: [drums, track("t-bass", "Bass")],
    buses: [bus("b-verb", "Reverb"), bus("b-delay", "Delay")],
    master: { volume: 1, insertChain: [] },
    referenceTrack: null,
  };
}

export const asJson = (project: Project) => project as unknown as JsonObject;
export const asProject = (doc: JsonObject) => doc as unknown as Project;

/**
 * What is wrong with the Project, or null. Like the app's own validator,
 * which also checks Project files it opens, it never trusts the shape.
 */
export function validate(doc: JsonObject): string | null {
  try {
    return problem(asProject(doc));
  } catch {
    return "not a Project";
  }
}

const shaped = (channel: Track | Bus) =>
  typeof channel.id === "string" &&
  typeof channel.name === "string" &&
  Array.isArray(channel.sends) &&
  Array.isArray(channel.insertChain);
const clipShaped = (clip: Clip) => typeof clip.start === "number" && Array.isArray(clip.notes);

function problem(project: Project): string | null {
  if (![...project.tracks, ...project.buses].every(shaped)) return "a channel is missing a field";
  if (!project.tracks.every((each) => Array.isArray(each.clips) && each.clips.every(clipShaped))) {
    return "a Clip is missing a field";
  }
  if (!(project.tempo >= 20 && project.tempo <= 999)) return "tempo out of range";
  const buses = new Map(project.buses.map((each) => [each.id, each]));
  const channels = [...project.tracks, ...project.buses];
  for (const channel of channels) {
    const fed = new Set<string>();
    for (const send of channel.sends) {
      if (!buses.has(send.busId)) return `${channel.id} sends to a missing Bus`;
      if (send.busId === channel.id) return `${channel.id} sends to itself`;
      if (fed.has(send.busId)) return `${channel.id} sends to ${send.busId} twice`;
      fed.add(send.busId);
    }
  }
  const feeds = (from: string, to: string, seen = new Set<string>()): boolean =>
    (buses.get(from)?.sends ?? []).some(
      (send) => send.busId === to || (!seen.has(send.busId) && feeds(send.busId, to, new Set([...seen, send.busId]))),
    );
  for (const each of project.buses) if (feeds(each.id, each.id)) return `${each.id} feeds itself`;
  const sections = project.sections.toSorted((a, b) => a.startBar - b.startBar);
  for (let index = 1; index < sections.length; index++) {
    const before = sections[index - 1]!;
    if (before.startBar + before.bars > sections[index]!.startBar) return "Sections overlap";
  }
  return null;
}

/** A copy to change, as a command changes a copy and never the Project in place. */
export function edit(update: (project: Project) => void): (doc: JsonObject) => JsonObject {
  return (doc) => {
    const copy = structuredClone(asProject(doc));
    update(copy);
    return asJson(copy);
  };
}

/** Delete a Bus as `deleteBus` does: whatever sent to it stops. */
export function deleteBus(project: Project, id: string) {
  project.buses = project.buses.filter((each) => each.id !== id);
  for (const channel of [...project.tracks, ...project.buses]) {
    channel.sends = channel.sends.filter((send) => send.busId !== id);
  }
}

export const findTrack = (project: Project, id: string) => project.tracks.find((each) => each.id === id);
export const findBus = (project: Project, id: string) => project.buses.find((each) => each.id === id);
