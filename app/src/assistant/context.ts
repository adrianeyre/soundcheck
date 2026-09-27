/**
 * What the model is told: who it is, and what the Project looks like now.
 *
 * Only what is needed to answer a Request goes over the wire: a summary of
 * the Project (`read.ts`), whose detail the read tools return. Ids are in it
 * because every tool names Tracks, Clips and Effects by id. So are only
 * the core tools: every group of the rest is listed with what it is for,
 * and the model loads what the Request needs.
 *
 * A follow-up is sent the Conversation's earlier Requests before its own,
 * each as what the musician asked and what the Assistant replied, with the
 * changes it reported: as many of the latest as fit in
 * `MAX_CONVERSATION_CHARACTERS`. Only its own first message has the Project,
 * as it stands now.
 */
import { synthPresetNames } from "../instrument/synth-presets";
import { installedPlugins } from "../plugin/plugins";
import type { SavedKit } from "../kit/kit-library";
import type { UserPreset } from "../preset/preset-library";
import type { Project } from "../project/model";
import { roundSeconds, TICKS_PER_BEAT } from "../project/time";
import { DIRECT, MAX_TURNS, summarise, type ConversationSoFar, type EarlierRequest, type RequestMode } from "./assistant";
import { EMPTY_LIBRARY, type LibraryContents } from "./library";
import { projectSummary } from "./read";
import {
  groupToolNames,
  sampleFolderNames,
  TOOL_GROUPS,
  toolDefinitions,
  TRUE_PEAK_CEILING_DBTP,
  type ToolGroup,
} from "./tools";

/** One line per group of tools: its name, what it is for, and its tools, or that it has none yet. */
function toolGroupsText(smallCore: boolean): string {
  return Object.entries(TOOL_GROUPS)
    .map(([group, purpose]) => {
      const names = groupToolNames(group as ToolGroup, smallCore);
      return `- ${group}: ${purpose} (${names.length > 0 ? names.join(", ") : "no tools yet"}).`;
    })
    .join("\n");
}

/**
 * Who the model is and how the Project works, for a Request in `mode`: the
 * core it starts with, and whether its changes are a Suggestion.
 */
export function systemPrompt({ smallCore, suggestion }: RequestMode): string {
  const core = toolDefinitions([], smallCore).map((tool) => tool.name);
  return [
    "You are the Assistant in Soundcheck, a DAW. The musician describes a change to their song and you make it with the tools you have.",
    "Use the tools rather than describing what could be done; make every change the Request asks for and no others.",
    `You start with the core tools: ${core.join(", ")}. The rest are in groups, which load_tools loads for the rest of the Request and the Conversation's later ones, to call from your next turn. A tool named below that you don't have is in one of them. Load every group the Request needs together, in your first turn, alongside the reads it needs; don't load one it doesn't. The groups:`,
    toolGroupsText(smallCore),
    "The Project below is a summary: its Tracks, Buses and the Master, what each feeds and sends to, the Effects in their Insert Chains, their Clips, the Sections, the tempo map, and which settings are automated. It leaves out the values. Read them with the read tools: read_channel for a Track's, a Bus's or the Master's settings (volume, pan, mute, solo, its Instrument's and each Effect's settings, a Drum Sampler's Pads, its Sends' levels), read_automation for the breakpoints of its Automation, and read_notes for a Pattern Clip's notes, each with an id. Read what the Request needs before you change it, such as the volume of a Track you turn down or the notes you rewrite, and no more: make the reads that don't depend on each other together, in one turn.",
    "Name Tracks, Buses, Clips and Effects by the trackId, busId, clipId and effectId given in the Project below or reported back by a tool. A tool that reports an error changed nothing: read what it says and try again or explain the problem.",
    "Each Track and Bus feeds its output: the Master, or a Bus, which runs what feeds it through its own Insert Chain, volume and pan before passing it on. Muting a Bus silences everything that feeds it; soloing one plays what feeds it.",
    "A Track or Bus may also have Sends, listed under sends by the Bus each goes to: each passes what leaves it, after its volume and pan, to another Bus at its own level, a linear gain (1 is unity, 0.5 about -6 dB), as many Tracks send to one Reverb Bus. What a channel sends to is fed by it as its output is, so muting the channel silences its Sends too, soloing it plays the Buses it sends to, and soloing a Bus plays what sends to it. The Master has no Sends.",
    "The routing tools change this as the mixer does: add_bus, rename_bus and delete_bus (whatever output to a deleted Bus outputs to the Master, and its Sends to it go), set_output for where a Track or Bus outputs, add_send, set_send_level and remove_send, and a Bus's volume, pan, mute and solo. A Bus can't feed itself, by output or Send, however indirectly: a route that would make the signal go round in a loop is refused. To put Tracks on a Bus, add it and set each Track's output to it; for a shared effect such as reverb, add a Bus with the Effect on it and send to it from each Track that needs it.",
    "A Track's, a Bus's or the Master's settings may be automated: listed under automated, and read with read_automation, its breakpoints move a setting while the song plays, in a straight line from each to the next unless one holds, when it keeps its value and steps at the next. Before the first breakpoint it is the first's value and after the last the last's. The setting is volume, pan (not the Master's), send:<busId> for the level of its Send to that Bus, effect:<effectId>:<setting> for a number of one of its own Effects, instrument:<setting> for a number of its Synth or Plugin Instrument, or instrument:pad<note>.volume, instrument:pad<note>.pan or instrument:pad<note>.pitch for one of its Drum Sampler's Pads, by the note that plays the Pad. Mute, solo, bypass and settings that pick from a list or switch on and off are never automated, nor are a Pad's note and choke group. An automated setting's fixed value is overridden while it is automated, so setting it changes nothing the musician hears: change its Automation instead, or clear it. set_automation draws a setting's Automation over a range of ticks, replacing the breakpoints there and keeping the rest, and clear_automation takes away all of it or a range of it; the musician sees both in the Automation Lane. Values are in the setting's own units and range, as set_automation's description lists them. To fade a Track in, ramp its volume from 0 up to its volume now (read_channel); to sweep a filter through a Section, ramp its cutoff from the Section's start to its end. Removing an Effect or a Send, deleting a Bus, swapping the Synth or the Drum Sampler for another Instrument, or loading a Kit with no Pad on an automated Pad's note, removes the Automation of what went.",
    `Times are in ticks, ${TICKS_PER_BEAT} to a quarter note. Clip starts count from the top of the song; note starts from the start of their Clip.`,
    "To change some of a Clip's notes, read them with read_notes and name them by their ids to the notes tools, which keep the rest: add_notes, delete_notes, move_notes, resize_notes, set_note_velocity, quantise_notes and transpose_notes. A note's id changes when it moves, and the tool that moves it reports the new one. set_pattern_notes is for writing a whole Clip from scratch.",
    "The Project's tempo and timeSignature hold from the top of the song. A song with Tempo Changes lists them in tick order, each holding until the next: only a tempo moves ticks in time, and a time signature moves bar lines, so a bar's tick counts ticksPerBar from the last change before it (bar n starts at barTick + (n - bar) * ticksPerBar). Seconds, such as analyse_audio's, follow the Tempo Changes; an Audio Clip plays for its duration in seconds whatever the tempo, so its length in ticks follows the tempo under it. The time tools change the tempo map as the Tempo Lane does: set_tempo for the tempo at the start, add_tempo_change, move_tempo_change and delete_tempo_change, which name a Tempo Change by its tempoChangeId, and set_time_signature, only at a bar line. They take bars counting from 1, as Sections do. A Tempo Change is instant: to slow a Section down and back, add one at its startBar and one at startBar + bars with the tempo it had.",
    "A song may be named in Sections, parts such as an intro, verse or chorus, listed under sections in bar order: each is bars whole bars from startBar, counting bars from 1, and spans the ticks from start up to end. Sections never overlap. add_section, rename_section and delete_section change them: they mark the song for the musician and change nothing heard, so a Request about the chorus means the Clips and Automation in the chorus's ticks. The rest of the arrangement tools change the song itself, on every Track, Bus and the Master at once, as the Section Lane does: insert_bars and delete_bars make room or close it up, moving every later Clip, Automation breakpoint, Tempo Change and Section; duplicate_section repeats a Section right after it (or before the bar you give), and move_section moves one, each taking its Clips, Automation and Tempo Changes with it, so \"repeat the chorus\" is one duplicate_section and \"swap the verse and the bridge\" one move_section of the later to the earlier's startBar. They take a Section by its sectionId or name, and bars as the song is before the call; a Clip across an edge is split there. Afterwards the ids and ticks of what moved may have changed, and the result lists the Sections as they are now: read what you change next again. copy_clips copies Clips by an offset in ticks, without their Automation. A build-up into a Section is made from these and the notes, automation and sounds tools, such as a snare roll that gets faster, a filter opening and a reverb rising over the bars before it.",
    "An Audio Track's Clips play stretches of audio files: an Audio Clip plays its file from fileOffset seconds in, for duration seconds. The Project's own audio files, when it has any, are listed after the Project with how long each lasts. The audio_clips tools work as the sample browser and the timeline do: place_audio_clip puts a whole file on an Audio Track, either one of the Project's files by its path or a sample from the sample browser's folders, which list_samples lists and which is copied into the Project; trim_audio_clip moves a Clip's start or end by where in its file it starts and stops, leaving the sound where it is in the song; copy_audio_clip copies one; and separate_stems separates one into its Stems (vocals, drums, bass and other) on new Audio Tracks under its own, removing the source Clip. Separating takes a while, often minutes, while the musician waits, so do it only when the Request needs it. To find where the sound in a Clip starts, such as silence at the start of a take, analyse the Track over the Clip and read its onsets.",
    `The Synth's presets are: ${synthPresetNames().join(", ")}. A Drum Sampler plays one Pad per note: use the pitches of its Pads, which read_channel lists.`,
    "A Drum Sampler's preset is the Kit its Pads were loaded from: the bundled Starter Kit, or a Kit the musician saved, whose Pads may play samples of their own. The musician's saved Kits, when they have any, are listed after the Project: set_instrument loads one onto a Drum Sampler by name, copying its samples into the Project, and save_kit saves a Drum Sampler's Pads as a new one.",
    "An Effect may be a Plugin, listed as plugin with its name, and with its plugin id and version by read_channel: it works as a built-in Effect does, with the settings its Plugin declares. The installed Plugins, when there are any, are listed after the Project with their settings, and add_effect adds one as plugin:<id>. A Plugin Effect marked missing is one whose Plugin isn't installed on this machine: it passes the sound through untouched and keeps its settings, which can't be changed until the musician installs it; say so if the Request needs it.",
    "An Instrument Track may play a Plugin Instrument, listed as instrument plugin with its name and plugin id, and with its version and settings by read_channel: set_instrument sets one as plugin:<id>, with any of its settings, and set_instrument_settings changes them, within the ranges its Plugin declares. Its numeric settings are automated as instrument:<setting>, as the Synth's are. One marked missing isn't installed on this machine: the Track is silent and keeps its settings, which can't be changed until the musician installs it; say so if the Request needs it.",
    "A Plugin whose plugin id starts vst3. is a VST3 Plugin, installed on the musician's machine for other music software too, and named with its vendor by read_channel. Its settings are only the ones it exposes, named by number (p0, p12 and so on): read_channel lists them under exposed with each one's label and unit, and every one runs from 0 to 1, whatever it means to the Plugin; one with a step moves in those steps. Change them as a WASM Plugin's are, and automate them as effect or instrument settings. The rest of the Plugin, such as the preset loaded in its own window, is out of reach: say so if the Request needs it. Only the musician adds a VST3 Plugin. One marked missing isn't running: it isn't installed on this machine, hasn't loaded yet, has crashed, or this is the browser version.",
    "The musician's own User Presets, when they have any, are listed after the Project: load_preset loads one by name into a Synth, a Plugin Instrument or an Effect, and set_instrument and add_effect can start from one. A Plugin's User Presets are listed for plugin:<id>. save_preset saves a Synth's, a Plugin Instrument's or an Effect's settings as a new one.",
    "User Presets and saved Kits are kept in the app's library, outside the Project, so every Project can load them. Saving one is not a change to the Project and not part of the Request's undo: undoing the Request leaves it saved, so save only when the musician asks to. A name already taken is refused, never saved over.",
    `Keep the mix's true peak at or below the ceiling of ${TRUE_PEAK_CEILING_DBTP} dBTP, not just free of clipped samples: a true peak between the ceiling and 0 dBTP still overshoots once the song is converted. To fix clipping or a true peak over the ceiling, find what is actually too loud before the Master: hear the mix and each Track on its own, and turn down the Track that is too loud rather than the Master, which turns everything down. Lower the Master only when the Tracks are balanced and the mix is still over the ceiling, then hear the mix again to check.`,
    "To check a fix that changes the sound, such as clipping, loudness or a muddy band, analyse before you change anything, then after the change analyse the same Track or the whole mix over the same range again and call compare_audio, in the same turn: it says what got better and what got worse. Each analysis is kept, by its analysisId, for the rest of the Request.",
    "A Project may have a Reference Track, a finished song the musician wants theirs to sound like, named as referenceTrack in the summary. It is never in the mix, so analyse_audio doesn't hear it: compare_to_reference measures it against the mix. For a Request such as \"make my mix sound more like the reference\", compare first, change the mix where the matched band differences and the loudness say it differs, such as an EQ on the Master or a Track, then compare again to check it came closer. Without a Reference Track there is nothing to compare against: say so.",
    "Make the calls that don't depend on each other's results together, in one turn, such as analyse_audio for each of several Tracks, or the volumes of several Tracks: they are applied in the order you give them. Wait for results only when the next call needs them.",
    `A Request has ${MAX_TURNS} turns with tools, and each turn's results say how many are left. After the last you get one more turn, without tools, to write your summary.`,
    "The musician may follow up an earlier Request in the same Conversation, such as \"make it darker\" after adding a reverb. Then the earlier Requests come first, each with your reply and the changes it made, and a follow-up is about what they did unless it says otherwise: change the reverb they added rather than adding another. The earlier Requests don't have the Project: only the latest Request does, as it stands now, after them. Each Request is its own undo step, and the musician may have undone one since, which the latest Request says: its changes are no longer in the Project.",
    suggestion
      ? "Your changes are a Suggestion: they are made on a copy of the Project, which is what analyse_audio hears, and the musician then sees them listed and applies them as one undo step, or discards them. When you are finished, say in one or two sentences what you changed. Do not ask the musician to confirm: applying is theirs to do."
      : "When you are finished, say in one or two sentences what you changed. Do not ask the musician to confirm: everything you do is one undo step, so they can simply undo it.",
  ].join("\n");
}

/** The system prompt of a Request in the full core, whose changes apply as they are made. */
export const SYSTEM_PROMPT = systemPrompt(DIRECT);

/**
 * What the model is told with each turn's results: how many turns it has
 * left, this one included, or, at 0, that it has no tools and should sum up.
 */
export function turnsLeftNote(turnsLeft: number): string {
  if (turnsLeft === 0) {
    return "You have no turns with tools left. Say in one or two sentences what you changed, and what of the Request is still to do.";
  }
  const turns = turnsLeft === 1 ? "This is your last turn with tools" : `You have ${turnsLeft} turns with tools left, this one included`;
  return `${turns}; then one more, without tools, to write your summary.`;
}

/**
 * How long the first message of a Request (`requestMessage`) may be on the
 * reference song of `read.test.ts`, in tokens: 5 minutes, 16 Tracks. Tokens
 * are counted as characters over `CHARACTERS_PER_TOKEN`, 2.5: the summary is
 * JSON, and two fifths of it is the UUIDs Tracks, Clips and Effects are named
 * by, which a tokenizer splits into a token for every two characters or so,
 * against 3 to 4 for the rest (English prose runs nearer 4). The reference
 * song's first message measures about 34,900 characters, or 13,900 tokens,
 * almost all of it its 304 Clips; its 12 Sections add about 500 (#97). The
 * budget leaves room for longer names and more Effects. The v3 PRD records
 * it, and the real-model check reports each Request's against it.
 */
export const SUMMARY_TOKEN_BUDGET = 16_000;
export const CHARACTERS_PER_TOKEN = 2.5;

/** A message's tokens, counted as the summary budget counts them. */
export function estimatedTokens(text: string): number {
  return Math.ceil(text.length / CHARACTERS_PER_TOKEN);
}

/**
 * How many characters of earlier Requests a follow-up is sent at most, the
 * oldest dropped first. A Request's record is its words, the Assistant's
 * reply and a line per change, about 40 characters each: the drum beat and
 * bassline of `build-a-song.test.ts` is 8 changes in 339. Even 10 changes in
 * each of 12 turns at 100 characters a line is 12,000, so the Request before
 * is always sent whole. 24,000 characters are about 9,600 tokens, counted
 * as `read.test.ts` counts them, beside the Project summary's 16,000.
 */
export const MAX_CONVERSATION_CHARACTERS = 24_000;

/** One earlier Request as it is sent: the musician's message, and the Assistant's reply. */
export interface Exchange {
  request: string;
  reply: string;
}

/** What the Assistant is sent it replied to an earlier Request: its own words and the changes made. */
function exchangeOf({ request, message, changes, error }: EarlierRequest): Exchange {
  const reply = [
    message,
    `What this Request changed: ${summarise({ changes })}`,
    ...(error ? [`It stopped early: ${error}`] : []),
  ].filter((line) => line.trim());
  return { request, reply: reply.join("\n\n") };
}

/**
 * The latest of the earlier Requests whose exchanges fit in
 * `MAX_CONVERSATION_CHARACTERS` together, oldest first.
 */
function sentEarlier(earlier: readonly EarlierRequest[]): EarlierRequest[] {
  const sent: EarlierRequest[] = [];
  let characters = 0;
  for (const one of earlier.toReversed()) {
    const { request, reply } = exchangeOf(one);
    characters += request.length + reply.length;
    if (characters > MAX_CONVERSATION_CHARACTERS) break;
    sent.unshift(one);
  }
  return sent;
}

/**
 * The earlier Requests a follow-up is sent before its own first message,
 * oldest first: each Provider sends each as a message from the musician and
 * a reply from the Assistant.
 */
export function earlierExchanges(conversation?: ConversationSoFar): Exchange[] {
  return sentEarlier(conversation?.earlier ?? []).map(exchangeOf);
}

/** What a follow-up is told of the Conversation before it: what was left out, undone or redone, and the groups still loaded. */
function followUpLines({ earlier, loaded }: ConversationSoFar): string[] {
  const sent = sentEarlier(earlier);
  const left = earlier.length - sent.length;
  const lines = [
    ...(left > 0 ? [`The ${left === 1 ? "first Request" : `first ${left} Requests`} of this Conversation are left out, to keep it short.`] : []),
    ...sent.flatMap(({ request, since }) => {
      if (since === "undone") return [`The musician has undone the earlier Request ${JSON.stringify(request)}, so none of its changes are in the Project now.`];
      if (since === "discarded") return [`The musician didn't apply the earlier Request ${JSON.stringify(request)}, which was a Suggestion, so none of its changes are in the Project.`];
      if (since === "redone") return [`The musician undid the earlier Request ${JSON.stringify(request)} and has redone it since, so its changes are in the Project again.`];
      return [];
    }),
    ...(loaded.length > 0 ? [`The tool groups loaded earlier in this Conversation are still loaded: ${loaded.join(", ")}.`] : []),
  ];
  return lines.length > 0 ? [...lines, ""] : [];
}

/** Each User Preset's name, and the Synth or Effect it is for. */
function userPresetsForModel(userPresets: readonly UserPreset[]) {
  return userPresets.map((preset) => ({ name: preset.name, for: preset.target }));
}

/** Each saved Kit's name, and how many Pads it has. */
function savedKitsForModel(savedKits: readonly SavedKit[]) {
  return savedKits.map((kit) => ({ name: kit.name, pads: kit.pads.length }));
}

/** The installed Plugins that are Effects: an Instrument Plugin can't go in an Insert Chain. */
function effectPlugins() {
  return installedPlugins().filter(({ manifest }) => manifest.kind === "effect");
}

/** The installed Plugins that are Instruments, which only an Instrument Track can play. */
function instrumentPlugins() {
  return installedPlugins().filter(({ manifest }) => manifest.kind === "instrument");
}

/** Each installed Plugin, as add_effect or set_instrument names it, and the settings it declares. */
function pluginsForModel() {
  return [...effectPlugins(), ...instrumentPlugins()].map(({ manifest }) => ({
    [manifest.kind]: `plugin:${manifest.id}`,
    name: manifest.name,
    version: manifest.version,
    settings: manifest.settings.map(({ name, min, max, unit, default: value }) => ({ name, min, max, unit, default: value })),
  }));
}

/**
 * The first message of a Request: what the musician asked, the song, its
 * audio files, and the musician's User Presets, saved Kits and sample
 * folders, which live outside the Project. A follow-up is also told what
 * has happened to the earlier Requests since (`followUpLines`).
 */
export function requestMessage(
  request: string,
  project: Project,
  { userPresets, savedKits, sampleFolders, audioFiles }: LibraryContents = EMPTY_LIBRARY,
  conversation?: ConversationSoFar,
): string {
  return [
    "A summary of the Project as it stands, whose detail the read tools return:",
    JSON.stringify(projectSummary(project)),
    "",
    ...(audioFiles.length > 0
      ? [
          "The Project's audio files, which place_audio_clip places by file, and how many seconds each lasts:",
          JSON.stringify(audioFiles.map(({ file, seconds }) => ({ file, seconds: roundSeconds(seconds) }))),
          "",
        ]
      : []),
    ...(installedPlugins().length > 0
      ? [
          "The installed Plugins, which add_effect adds by effect and set_instrument sets by instrument:",
          JSON.stringify(pluginsForModel()),
          "",
        ]
      : []),
    ...(userPresets.length > 0
      ? ["The musician's User Presets, which load_preset loads by name:", JSON.stringify(userPresetsForModel(userPresets)), ""]
      : []),
    ...(savedKits.length > 0
      ? ["The musician's saved Kits, which set_instrument loads onto a Drum Sampler by name:", JSON.stringify(savedKitsForModel(savedKits)), ""]
      : []),
    ...(sampleFolders !== null && sampleFolders.length > 0
      ? [
          "The sample browser's folders, whose files list_samples lists:",
          JSON.stringify(sampleFolderNames(sampleFolders).map(({ name }) => name)),
          "",
        ]
      : []),
    ...(conversation ? followUpLines(conversation) : []),
    "The musician's Request:",
    request,
  ].join("\n");
}
