/**
 * What the model can read of the Project: the summary each Request starts
 * with, and the detail the read tools return.
 *
 * The summary says what there is and where: every Track, Bus and the
 * Master, what each feeds, the Effects in its Insert Chain, its Clips, the
 * Sections, the tempo map, and which settings are automated. It leaves out the values:
 * settings, Automation breakpoints and notes, which a real song has
 * thousands of. `read_channel`, `read_automation` and `read_notes` return
 * those, so the model reads only what the Request needs.
 */
import { effectName, effectTable, isMissingPlugin, type TableParam } from "../effect/effect-table";
import { instrumentName, isMissingInstrument, pluginInstrumentTable } from "../instrument/instrument-table";
import {
  type Automation,
  type Bus,
  clipLength,
  type Effect,
  type Note,
  type PatternClip,
  type Project,
  type Send,
  type Track,
} from "../project/model";
import { sectionTicks } from "../project/sections";
import { barBeatTick, barStart, barTicks, roundSeconds, type TimeSignature, tempoMapOf } from "../project/time";

/** A range of ticks, from `start` up to but not including `end`; either may be left out. */
export interface TickRange {
  start?: number;
  end?: number;
}

function signature({ beatsPerBar, beatUnit }: TimeSignature): string {
  return `${beatsPerBar}/${beatUnit}`;
}

export function inRange(tick: number, { start = 0, end = Infinity }: TickRange): boolean {
  return tick >= start && tick < end;
}

/**
 * The Project as the model first sees it: enough to plan a change and to
 * know what to read, and no audio.
 * `tempo` and `timeSignature` are the song's start; a song with Tempo
 * Changes lists each by its id, with the bar it falls in and where that bar starts,
 * when it comes in seconds, and what it is from there on. A song with
 * Sections lists each by name, with its bars and the ticks they span.
 * A song with Buses lists them, and says where every Track and Bus sends its
 * signal: "master", or a busId, and to which Buses it sends. A Track, Bus or
 * the Master with Automation lists the settings it automates.
 */
export function projectSummary(project: Project) {
  const map = tempoMapOf(project);
  const routed = project.buses.length > 0;
  const output = (to: string | null) => (routed ? { output: to ?? "master" } : {});
  const sends = (list: readonly Send[]) => (routed && list.length > 0 ? { sends: list.map(({ busId }) => busId) } : {});
  return {
    name: project.name,
    tempo: project.tempo,
    timeSignature: signature(project.timeSignature),
    ticksPerBar: barTicks(project.timeSignature),
    ...(project.tempoChanges.length > 0 && {
      tempoChanges: map.segments.slice(1).map((segment) => ({
        // Each segment past the start is one Tempo Change's.
        tempoChangeId: project.tempoChanges.find((change) => change.tick === segment.tick)!.id,
        tick: segment.tick,
        bar: barBeatTick(map, segment.tick).bar,
        // Where that bar starts: the change's own tick unless it changes
        // only the tempo, part way through a bar.
        barTick: barStart(map, barBeatTick(map, segment.tick).bar),
        seconds: roundSeconds(segment.seconds),
        tempo: segment.tempo,
        timeSignature: signature(segment.timeSignature),
        ticksPerBar: barTicks(segment.timeSignature),
      })),
    }),
    ...(project.sections.length > 0 && {
      sections: project.sections.map((section) => ({
        sectionId: section.id,
        name: section.name,
        startBar: section.startBar,
        bars: section.bars,
        // Its ticks on the tempo map, to find the Clips in it.
        ...sectionTicks(section, map),
      })),
    }),
    // Never in the mix, so only named: compare_to_reference measures it.
    ...(project.referenceTrack && { referenceTrack: { file: project.referenceTrack.file } }),
    tracks: project.tracks.map((track) => ({
      trackId: track.id,
      name: track.name,
      kind: track.kind,
      ...instrumentSummary(track),
      insertChain: track.insertChain.map(effectSummary),
      ...automated(track.automation),
      ...output(track.output),
      ...sends(track.sends),
      clips: track.clips.map((clip) => ({
        clipId: clip.id,
        start: clip.start,
        length: Math.round(clipLength(clip, map)),
        // An Audio Clip trimmed at its start plays from `fileOffset` seconds
        // into its file, for `duration` seconds whatever the tempo.
        ...(clip.kind === "pattern"
          ? { notes: clip.notes.length }
          : { file: clip.file, fileOffset: clip.fileOffset, duration: clip.duration }),
      })),
    })),
    ...(routed && {
      buses: project.buses.map((bus) => ({
        busId: bus.id,
        name: bus.name,
        insertChain: bus.insertChain.map(effectSummary),
        ...automated(bus.automation),
        ...output(bus.output),
        ...sends(bus.sends),
      })),
    }),
    master: {
      insertChain: project.master.insertChain.map(effectSummary),
      ...automated(project.master.automation),
    },
  };
}

/** Which settings are automated, by what they move, or nothing when none is. */
function automated(automation: readonly Automation[]) {
  return automation.length > 0 ? { automated: automation.map((lane) => lane.setting) } : {};
}

/** One Effect of an Insert Chain, by id and name: a Plugin says which, and if it is missing. */
function effectSummary(effect: Effect) {
  return {
    effectId: effect.id,
    effect: effect.type,
    ...(effect.type === "plugin" && { name: effectName(effect), ...(isMissingPlugin(effect) && { missing: true }) }),
    ...(effect.bypassed && { bypassed: true }),
  };
}

/** Which Instrument a Track plays, and its preset or Kit. */
function instrumentSummary(track: Track) {
  if (track.kind !== "instrument") return {};
  const { instrument } = track;
  if (instrument.type === "plugin") {
    return {
      instrument: instrument.type,
      name: instrumentName(instrument),
      plugin: instrument.plugin.id,
      ...(isMissingInstrument(instrument) && { missing: true }),
    };
  }
  return { instrument: instrument.type, preset: instrument.preset };
}

/**
 * What a running VST3 Plugin's settings are: they are named by number, so
 * each is given with its label, its unit and, for one with steps, its step.
 * Every one runs from 0 to 1.
 */
function vst3Exposed(vendor: string, table: readonly TableParam[]) {
  return {
    vendor,
    exposed: table.map(({ name, label, unit, step }) => ({ name, label, ...(unit && { unit }), ...(step > 0 && { step }) })),
  };
}

/** A running VST3 Effect's exposed settings; nothing for any other Effect. */
function vst3Of(effect: Effect) {
  return effect.type === "plugin" && effect.vst3 ? vst3Exposed(effect.vst3.vendor, effectTable(effect)) : {};
}

/** One Effect in full, in the order its chain runs: its settings, and a Plugin's id and version. */
export function effectDetail(effect: Effect) {
  const plugin =
    effect.type === "plugin"
      ? {
          name: effectName(effect),
          plugin: effect.plugin.id,
          version: effect.plugin.version,
          ...(isMissingPlugin(effect) ? { missing: true } : vst3Of(effect)),
        }
      : {};
  return { effectId: effect.id, effect: effect.type, ...plugin, bypassed: effect.bypassed, settings: effect.settings };
}

/** A Track's Instrument in full: its preset or Kit, and every setting or Pad. */
function instrumentDetail(track: Track) {
  if (track.kind !== "instrument") return {};
  const { instrument } = track;
  if (instrument.type === "plugin") {
    return {
      instrument: instrument.type,
      name: instrumentName(instrument),
      plugin: instrument.plugin.id,
      version: instrument.plugin.version,
      ...(isMissingInstrument(instrument)
        ? { missing: true }
        : instrument.vst3 && vst3Exposed(instrument.vst3.vendor, pluginInstrumentTable(instrument))),
      settings: instrument.settings,
    };
  }
  if (instrument.type === "synth") return { instrument: instrument.type, preset: instrument.preset, settings: instrument.settings };
  return { instrument: instrument.type, preset: instrument.preset, pads: instrument.pads };
}

/**
 * One channel in full, for `read_channel`: every setting of a Track, a Bus
 * or the Master, its Instrument, its Insert Chain with each Effect's
 * settings, where it sends its signal and at what level, and which settings
 * are automated. Its Clips are in the summary, and its breakpoints are
 * `read_automation`'s.
 */
export function channelDetail(project: Project, channel: Track | Bus | "master") {
  if (channel === "master") {
    return {
      channel: "master",
      volume: project.master.volume,
      insertChain: project.master.insertChain.map(effectDetail),
      ...automated(project.master.automation),
    };
  }
  const routing = {
    output: channel.output ?? "master",
    sends: channel.sends.map(({ busId, level }) => ({ busId, level })),
  };
  const common = { ...channel.mixer, insertChain: channel.insertChain.map(effectDetail), ...routing, ...automated(channel.automation) };
  if (!("kind" in channel)) return { busId: channel.id, name: channel.name, ...common };
  return { trackId: channel.id, name: channel.name, kind: channel.kind, ...instrumentDetail(channel), ...common };
}

/**
 * Each automated setting of a channel in `range` of song ticks, for
 * `read_automation`, with its breakpoints: all of them when the range is
 * left out.
 */
export function automationDetail(automation: readonly Automation[], range: TickRange = {}) {
  return automation.map(({ setting, breakpoints }) => ({
    setting,
    breakpoints: breakpoints.filter((breakpoint) => inRange(breakpoint.tick, range)).map((breakpoint) => ({ ...breakpoint })),
  }));
}

/**
 * Each note's id: its start and pitch, as `<start>:<pitch>`, with `:2`, `:3`
 * and on for a second or third note at the same start and pitch. Ids are
 * worked out from the notes rather than kept in the Project, so none has to
 * be saved; a note's id stays the same whatever happens to the others, and
 * changes only when it moves.
 */
export function noteIds(notes: readonly Note[]): string[] {
  const seen = new Map<string, number>();
  return notes.map(({ start, pitch }) => {
    const key = `${start}:${pitch}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? key : `${key}:${count}`;
  });
}

/**
 * A Pattern Clip's notes, for `read_notes`: those starting in `range` of
 * ticks from the start of the Clip, all of them when it is left out, each
 * with its id.
 */
export function notesDetail(clip: PatternClip, range: TickRange = {}) {
  const ids = noteIds(clip.notes);
  return clip.notes.flatMap((note, index) =>
    inRange(note.start, range)
      ? [{ id: ids[index]!, pitch: note.pitch, start: note.start, length: note.length, velocity: note.velocity }]
      : [],
  );
}
