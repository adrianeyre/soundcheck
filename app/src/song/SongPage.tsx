import { Circle, Download, FileAudio, Scissors, FilePlus2, FolderOpen, ListMusic, Plus, Power, Radio, Redo2, Rows3, Save, SaveAll, Share2, Split, Square, Undo2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import type { Listen } from "../assistant/assistant";
import { AssistantSettings } from "../assistant/AssistantSettings";
import { RequestBox, type RequestBoxProps } from "../assistant/RequestBox";
import { useJevConnection } from "../assistant/assistant-settings";
import { jevDecide } from "../assistant/jev";
import type { KeyStore } from "../assistant/key-store";
import { assistantLibrary } from "../assistant/library";
import { listenWith } from "../assistant/listen";
import { type HearReference, hearReferenceIn } from "../assistant/reference";
import type { AnalyseAudio } from "../audio/audio-analyser";
import type { AudioInputs, RecordedTake } from "../audio/audio-input";
import type { AudioOutput, EngineCommand, Meters, OpenAudioOutput, RecordedNoteEvent } from "../audio/audio-output";
import { CollaborationNotices } from "../collab/CollaborationNotices";
import { CollaborationSettings } from "../collab/CollaborationSettings";
import { yourName } from "../collab/identity";
import type { LiveSocket } from "../collab/live-session";
import { readInvite } from "../collab/live-wire";
import { LiveSessionDialog } from "../collab/LiveSessionDialog";
import { useLiveSession } from "../collab/useLiveSession";
import { DEFAULT_OCTAVE, listenToComputerKeyboard } from "../keyboard/computer-keyboard";
import { PianoKeyboard } from "../keyboard/PianoKeyboard";
import { soundingOnTrack } from "../keyboard/sounding";
import type { NoteEvent } from "../midi/midi-input";
import type { OpenMidiInput } from "../midi/midi-input";
import { createPluginInstrument } from "../instrument/instrument-table";
import { PluginInstrumentPanel } from "../instrument/PluginInstrumentPanel";
import { KeysPanel } from "../instrument/KeysPanel";
import { KEYS_PRESETS } from "../instrument/keys-presets";
import { SynthPanel } from "../instrument/SynthPanel";
import { MeterBridge } from "../mixer/MeterBridge";
import { Mixer } from "../mixer/Mixer";
import { EqEditor } from "../effect/EqEditor";
import { ChordPads, parallelKey } from "../theory/ChordPads";
import { jevNextChord } from "../theory/next-chord";
import { DEFAULT_KEY, type MusicalKey } from "../theory/theory";
import { KitControls } from "../kit/KitControls";
import { KitLibrary, loadKitCommand, type SavedKit } from "../kit/kit-library";
import { memoryLibraryStorage, type LibraryStorage } from "../preset/library-storage";
import { keysPresetCommand, synthPresetCommand } from "../preset/preset-library";
import { usePresetLibrary } from "../preset/PresetLibraryProvider";
import type { Command } from "../project/commands";
import type { PluginFolder } from "../plugin/plugin-folder";
import type { PluginManifest } from "../plugin/plugins";
import { isVst3Instrument, type Vst3Class, vst3Classes, type Vst3Host } from "../plugin/vst3";
import { useVst3, useVst3Instances, Vst3Provider, Vst3Settings, Vst3Unavailable } from "../plugin/Vst3Settings";
import { PluginSettings, useInstalledPlugins } from "../plugin/PluginSettings";
import { EngineSync, instrumentTracks, type LoadedSample, type LoadedSamples } from "../project/engine-sync";
import { ProjectHistory } from "../project/history";
import {
  createAudioTrack,
  createDrumTrack,
  createKeysTrack,
  clipEnd,
  createInstrumentTrack,
  createProject,
  newId,
  type AudioClip,
  type AudioTrack,
  type Clip,
  type DrumPad,
  type InstrumentTrack,
  type PatternClip,
} from "../project/model";
import { barStart, barTicks, beatTicks, signatureAt, tempoMapOf } from "../project/time";
import { ClipExportPanel } from "../export/ClipExportPanel";
import { ExportPanel } from "../export/ExportPanel";
import { defaultLayout, setWidgetHidden, type WidgetId, type WidgetLayout } from "../grid/layout";
import { WidgetGrid, type WidgetGridProps } from "../grid/WidgetGrid";
import { droppedSample } from "../samples/sample-drag";
import { loadSampleFolders } from "../samples/sample-folders";
import { SampleBrowser, type SampleTarget } from "../samples/SampleBrowser";
import type { SampleRef, SampleSource } from "../samples/sample-source";
import { LoadTestPage, type LoadTestPageProps } from "../load-test/LoadTestPage";
import { BrowserVersionSettings } from "../settings/BrowserVersionSettings";
import type { DesktopOnly } from "../settings/desktop-only";
import { SettingsPage } from "../settings/SettingsPage";
import { integratedLufs, type ReferencePlayer } from "../reference/reference-player";
import { ReferenceTrackControl } from "../reference/ReferenceTrackControl";
import { type MixExporter, songEndTick } from "../export/mix-exporter";
import type { FileStorage } from "../storage/file-storage";
import { audioFiles, copyPathFor, fileName } from "../storage/project-folder";
import { ProjectFileAlerts, ProjectTitle } from "../storage/ProjectFile";
import { useProjectFile } from "../storage/useProjectFile";
import { assistantStems } from "../stems/assistant-stems";
import type { StemSeparator } from "../stems/stem-separator";
import { StemSeparationPanel } from "../stems/StemSeparationPanel";
import { useStemSeparation } from "../stems/useStemSeparation";
import { Dialog } from "../ui/Dialog";
import { memoWidget } from "../ui/memo";
import { Menu, type MenuItem } from "../ui/Menu";
import { useMenuShortcuts } from "../ui/menu-shortcuts";
import { AudioSettings } from "../settings/AudioSettings";
import { type AudioPreferences, readAudioPreferences, writeAudioPreferences } from "../settings/audio-preferences";
import { TransportBar } from "../transport/TransportBar";
import { DEFAULT_TRANSPORT, playRange, type TransportSettings, transportCommands } from "../transport/transport-settings";
import { UpdateNotice } from "../update/UpdateNotice";
import type { Updater } from "../update/updater";
import { UpdateSettings } from "../update/UpdateSettings";
import { useUpdates } from "../update/useUpdates";
import { DjPages } from "../dj/DjPages";
import type { AddedTake, AddTakeRequest } from "../dj/dj-session";
import type { HeadphoneOutput } from "../dj/headphone-output";
import type { TimecodeInput } from "../dj/timecode-input";
import { browserRecordingSaver, type DjRecordingSaver } from "../dj/recording-saver";
import { AudioEditor } from "./AudioEditor";
import { NoteTools } from "./NoteTools";
import { SongOverview } from "./SongOverview";
import { AudioRecordPanel } from "./AudioRecordPanel";
import { DrumPads } from "./DrumPads";
import { AUDIO_FILE_TYPES, readAudioFile, summariseAudio, type Waveform } from "./import-audio";
import { readWavFile } from "./load-sample";
import { recordingCommands } from "./recording";
import { DEFAULT_STEP_TICKS } from "./step-grid";
import { PianoRoll } from "./PianoRoll";
import { StepSequencer } from "./StepSequencer";
import { type AbsentAudio, Timeline } from "./Timeline";
import { describeTick, placeTake, roundBpm, setTempoAt, tempoMismatch } from "./take-placement";
import { AddTrack, type AddTrackChoice, TrackList } from "./TrackList";

/**
 * Bring the Audio Editor, just opened, into view: a saved layout can have
 * it far below the Timeline, off the bottom of the window. Where its top is
 * already on screen nothing moves; otherwise it scrolls up to a third of
 * the way down (its `scroll-margin-top`), keeping what was clicked in sight,
 * and its Widget flashes so the eye finds it.
 */
function revealAudioEditor() {
  const editor = document.querySelector<HTMLElement>('[aria-label="Audio Editor"]');
  if (!editor) return;
  const { top } = editor.getBoundingClientRect();
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  if (top < 0 || top > window.innerHeight - 160) editor.scrollIntoView?.({ block: "start", behavior: reduced ? "auto" : "smooth" });
  if (!reduced) editor.closest(".widget")?.animate?.([{ boxShadow: "0 0 0 3px var(--primary)" }, { boxShadow: "0 0 0 0 transparent" }], { duration: 900, easing: "ease-out" });
}

/** A new Pattern Clip is this many bars long. */
const CLIP_BARS = 4;
const POSITION_MS = 50;

export interface SongPageProps {
  openOutput: OpenAudioOutput;
  /** Where Projects are saved and opened; null where they can't be. */
  storage?: FileStorage | null;
  /** Exports the mix as a WAV file; null where it can't. */
  exporter?: MixExporter | null;
  /** Saves a recording of the Mixer page's DJ mix; the browser's way without one. */
  djRecordings?: DjRecordingSaver;
  /** Where the Mixer page's headphone cue can play: a second output device, or null where the platform can't choose one. */
  headphones?: HeadphoneOutput | null;
  /** Where the Mixer page's timecode vinyl comes in (a DVS), or null where the platform can't take it. */
  timecodeInput?: TimecodeInput | null;
  /** Where the Assistant's API key lives; no key store, no Assistant. */
  keyStore?: KeyStore;
  /** How the Assistant's requests go out; the global fetch unless the platform says otherwise. */
  fetch?: RequestBoxProps["fetch"];
  /**
   * MIDI keyboards, where the UI sees them. On the desktop notes go from
   * the MIDI thread straight into the engine and never reach the webview
   * (ADR 0002), so this only feeds the browser dev host.
   */
  openMidi?: OpenMidiInput;
  /** Separates an Audio Clip into its Stems; where it can't, it says so, and null has none at all. */
  stems?: StemSeparator | null;
  /** Finds and installs a newer version of the app; null where there is nothing to install. */
  updater?: Updater | null;
  /** For tests; a fresh, empty Project otherwise. */
  history?: ProjectHistory;
  /** For tests; the Assistant talks to the chosen Provider otherwise. */
  conversations?: RequestBoxProps["conversations"];
  /** How the Assistant listens to the Project; without it, it can't. */
  analyseAudio?: AnalyseAudio;
  /** The audio inputs to record from; null where the platform has none. */
  audioInputs?: AudioInputs | null;
  /** The sample browser's folders; null where the platform has none. */
  samples?: SampleSource | null;
  /** Chooses and auditions the Reference Track; null where there is none. */
  reference?: ReferencePlayer | null;
  /** The app-level library, where the sample browser remembers its folders. */
  library?: LibraryStorage;
  /** The app-level Plugins folder; absent where there is none. */
  plugins?: PluginFolder;
  /** Hosts the VST3 Plugins installed on this machine; null where they can't be (ADR 0008). */
  vst3?: Vst3Host | null;
  /** Why the Desktop App can't host them on this machine, where it can't (macOS). */
  vst3Unavailable?: string | null;
  /** Where a Live Session's invite links open: the Browser Version. */
  inviteSite?: string;
  /** For tests; Live Sessions connect to their Relay with a WebSocket otherwise. */
  connectRelay?: (url: string) => LiveSocket;
  /**
   * Which page shows: making music, or everything else. Both stay mounted,
   * so moving between them loses neither the song nor a half-typed setting.
   */
  view?: SongView;
  /** Asks for the other page, as the Assistant's "Set up" button does. */
  onView?: (view: SongView) => void;
  /**
   * The audio hosts and buffer sizes to choose from in Settings, where the
   * platform lets you (the desktop). The choice is kept on this machine.
   */
  audioDevice?: { listAudioHosts: () => Promise<string[]>; bufferSizes: readonly number[] };
  /** What only the Desktop App has, for Settings to list in the Browser Version (ADR 0006). */
  desktopOnly?: readonly DesktopOnly[];
  /** The latency test's own platform parts, where it is offered. */
  latencyTest?: Omit<LoadTestPageProps, "openOutput" | "openMidi" | "initialHost" | "initialBufferFrames">;
  onShowCookiePolicy?: () => void;
  onShowAccessibility?: () => void;
  /**
   * Where the menu and the Project's name go: the app's title bar, once it
   * is drawn. Without it they show at the top of the page.
   */
  header?: HTMLElement | null;
  /** The app's own menu, which File heads; without it the menu is File's alone. */
  menu?: { label: ReactNode; ariaLabel: string; items: readonly MenuItem[] };
  /** Where the Editor's Widgets sit; without it they start in their places and move only for this run. */
  grid?: {
    layout: WidgetLayout;
    onLayout: (layout: WidgetLayout) => void;
    pinned?: WidgetGridProps["pinned"];
    /** Told which Widgets have nothing to show whenever that changes, so the Grid menu can say so. */
    onEmpty?: (empty: readonly WidgetId[]) => void;
  };
  /** Where the Mixer page's Widgets sit, as `grid` is the Editor's. */
  mixingGrid?: {
    layout: WidgetLayout;
    onLayout: (layout: WidgetLayout) => void;
    pinned?: WidgetGridProps["pinned"];
    onEmpty?: (empty: readonly WidgetId[]) => void;
  };
  /** Where the Pads page's Widgets sit. */
  padsGrid?: {
    layout: WidgetLayout;
    onLayout: (layout: WidgetLayout) => void;
    pinned?: WidgetGridProps["pinned"];
    onEmpty?: (empty: readonly WidgetId[]) => void;
  };
}

export type SongView = "editor" | "settings" | "mixing" | "pads";

/** The id of each page's panel, for the menu to point at. */
export const viewPanelId = (view: SongView) => `page-${view}`;

/** Where recording started, and what it is recording into. */
interface RecordingFrom {
  startTick: number;
  trackId: string;
  /** The Clip being recorded into, or null for a new one. */
  clipId: string | null;
  /** The id the new Clip will get. */
  newClipId: string;
}

/**
 * The first end-to-end slice of the DAW: Instrument Tracks playing Pattern
 * Clips through the Synth or the Drum Sampler, edited in the Step Sequencer.
 * Every edit is a Project command, so it undoes.
 *
 * A WAV loaded onto a pad is held here, in memory, by the path the pad names
 * it with, because the engine takes bytes and not paths (ADR 0001). Saving
 * the Project writes those bytes into its folder's `audio/` and opening one
 * reads them back, so the same map holds a sample whether it has just been
 * loaded from the musician's own file or come out of the folder.
 */
export function SongPage({
  openOutput,
  openMidi,
  storage = null,
  exporter = null,
  djRecordings = browserRecordingSaver(),
  headphones,
  timecodeInput = null,
  stems: stemSeparator = null,
  updater = null,
  keyStore,
  fetch,
  history: given,
  conversations,
  analyseAudio,
  audioInputs = null,
  samples: sampleSource = null,
  reference: referencePlayer = null,
  library: givenLibrary,
  plugins: pluginFolder,
  vst3: vst3Host = null,
  vst3Unavailable = null,
  inviteSite = "",
  connectRelay,
  view = "editor",
  onView,
  audioDevice,
  desktopOnly = [],
  latencyTest,
  onShowCookiePolicy,
  onShowAccessibility,
  header,
  menu,
  grid,
  mixingGrid,
  padsGrid,
}: SongPageProps) {
  const [ownLayout, setOwnLayout] = useState(defaultLayout);
  const layout = grid?.layout ?? ownLayout;
  const setLayout = grid?.onLayout ?? setOwnLayout;
  // New and Open replace the Project, and its undo history with it.
  const [history, setHistory] = useState(() => given ?? new ProjectHistory(createProject(), { by: yourName() }));
  const project = useSyncExternalStore(
    useCallback((onChange) => history.subscribe(onChange), [history]),
    () => history.project,
  );
  const [output, setOutput] = useState<AudioOutput | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioPreferences, setAudioPreferences] = useState(readAudioPreferences);
  // Why the audio last failed to start, for Settings to say beside the choice.
  const [startError, setStartError] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [position, setPosition] = useState<number | null>(null);
  const [meters, setMeters] = useState<Meters | null>(null);
  const [transport, setTransport] = useState<TransportSettings>(DEFAULT_TRANSPORT);
  // The Section selected on the timeline's Section Lane, which is what Play plays; none plays the whole song.
  const [playSectionId, setPlaySectionId] = useState<string | null>(null);
  const [stepTicks, setStepTicks] = useState(DEFAULT_STEP_TICKS);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingAudio, setRecordingAudio] = useState(false);
  // While the Assistant is carrying out a Request the Project is its own:
  // the history refuses everyone else, so the buttons say so too.
  const [requesting, setRequesting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // The Audio Clip Export Clip… was chosen on, while its dialog is open.
  const [clipToExport, setClipToExport] = useState<string | null>(null);
  const [quantise, setQuantise] = useState(false);
  const [octave, setOctave] = useState(DEFAULT_OCTAVE);
  const [midiStatus, setMidiStatus] = useState<string | null>(null);
  // The song's key, which the Keyboard, Chords and Note Tools share; the musician's view, not the Project's.
  const [songKey, setSongKey] = useState<MusicalKey>(DEFAULT_KEY);
  // Jev, where it is set up, picks the Chords Widget's next chord.
  const jev = useJevConnection(keyStore);
  const nextChord = useMemo(() => (jev ? jevNextChord(jevDecide(jev, fetch), parallelKey) : undefined), [jev, fetch]);
  // The notes held right now, from the on-screen keys, the computer keyboard or MIDI, for the pianos to light.
  const [held, setHeld] = useState<ReadonlySet<number>>(new Set());
  const [samples, setSamples] = useState<LoadedSamples>(new Map());
  const [ownLibrary] = useState(memoryLibraryStorage);
  const library = givenLibrary ?? ownLibrary;
  const kitLibrary = useMemo(() => new KitLibrary(library), [library]);
  // Read the saved Kits once, so the Assistant is told them.
  useEffect(() => {
    kitLibrary.load().catch(() => undefined);
  }, [kitLibrary]);
  // The latency test opens its own audio output and MIDI input, so the
  // song's are closed while it runs, and it closes when Settings is left.
  const [latencyOpen, setLatencyOpen] = useState(false);
  const showLatency = latencyOpen && view === "settings";
  // The loaded audio as it is now. A Request that loads a saved Kit adds
  // its samples here straight away, so the rest of the Request hears them
  // before the page renders again.
  const samplesNow = useRef(samples);
  useEffect(() => {
    samplesNow.current = samples;
  }, [samples]);
  const currentSamples = useCallback(() => samplesNow.current, []);
  const addSamples = useCallback((added: ReadonlyMap<string, LoadedSample>) => {
    samplesNow.current = new Map([...samplesNow.current, ...added]);
    setSamples(samplesNow.current);
  }, []);
  const removeSamples = useCallback((paths: readonly string[]) => {
    samplesNow.current = new Map([...samplesNow.current].filter(([path]) => !paths.includes(path)));
    setSamples(samplesNow.current);
  }, []);
  const stemSeparation = useStemSeparation({ separator: stemSeparator, history, samples: currentSamples, addSamples });
  // The Assistant's separate_stems, which reads and changes the loaded audio only during a Request.
  const assistantSeparation = useMemo(
    () =>
      stemSeparator
        ? // oxlint-disable-next-line react/refs
          assistantStems(stemSeparator, { samples: currentSamples, add: addSamples, remove: removeSamples })
        : undefined,
    [stemSeparator, currentSamples, addSamples, removeSamples],
  );
  // The Assistant hears the pads' samples too.
  const listen = useMemo(
    (): Listen | undefined =>
      analyseAudio && ((song, range) => listenWith(analyseAudio, currentSamples())(song, range)),
    [analyseAudio, currentSamples],
  );
  const hearReference = useMemo((): HearReference => (file) => hearReferenceIn(currentSamples())(file), [currentSamples]);
  // The User Presets and saved Kits the Assistant loads from and saves into,
  // and the sample browser's folders it places samples from.
  const presets = usePresetLibrary();
  const assistantSounds = useMemo(
    () =>
      assistantLibrary(
        presets,
        kitLibrary,
        // The library only reads and adds to the loaded audio during a Request, never while rendering.
        // oxlint-disable-next-line react/refs
        { samples: currentSamples, add: addSamples },
        sampleSource && { source: sampleSource, folders: () => loadSampleFolders(library) },
      ),
    [presets, kitLibrary, currentSamples, addSamples, sampleSource, library],
  );
  // Each audio file's waveform, measured once when it is imported or opened.
  const [waveforms, setWaveforms] = useState<ReadonlyMap<LoadedSample, Waveform>>(new Map());
  const measuringRef = useRef(new Set<LoadedSample>());
  const outputRef = useRef<AudioOutput | null>(null);
  const playNote = useCallback((event: NoteEvent) => {
    outputRef.current?.send(event);
    setHeld((notes) => {
      if ((event.type === "noteOn") === notes.has(event.note)) return notes;
      const next = new Set(notes);
      if (event.type === "noteOn") next.add(event.note);
      else next.delete(event.note);
      return next;
    });
  }, []);
  const noteOn = useCallback((note: number, velocity: number) => playNote({ type: "noteOn", note, velocity }), [playNote]);
  const noteOff = useCallback((note: number) => playNote({ type: "noteOff", note }), [playNote]);
  // A key or drum clicked in a picture of the kit or the keys, at the on-screen Keyboard's middle velocity.
  const playOrStop = useCallback((note: number, on: boolean) => (on ? noteOn(note, 0.8) : noteOff(note)), [noteOn, noteOff]);
  const syncRef = useRef(new EngineSync());
  const recordedRef = useRef<RecordedNoteEvent[]>([]);
  const recordingFromRef = useRef<RecordingFrom | null>(null);

  const tracks = instrumentTracks(project);
  const selected = tracks
    .flatMap((track) => track.clips.map((clip) => ({ track, clip })))
    .find(({ clip }) => clip.id === selectedClipId);
  // The Audio Clip the Audio Editor has open: the one selected, on the Timeline or from its Track.
  const selectedAudio = project.tracks
    .flatMap((track) => (track.kind === "audio" ? track.clips.map((clip) => ({ track, clip })) : []))
    .find(({ clip }) => clip.id === selectedClipId);
  // Live notes play, and recording lands on, the Track holding the selected
  // Clip, or the one chosen below.
  const recordTrack = tracks.find((track) => track.id === selectedTrackId) ?? tracks[0] ?? null;
  // The Widgets with nothing to show are off the Grid until they have something (ADR 0004).
  const audioTrackCount = project.tracks.filter((track) => track.kind === "audio").length;
  const instrumentType = selected?.track.instrument.type;
  const empty: WidgetId[] = [
    ...(selectedAudio ? [] : (["audioEditor"] as const)),
    ...(selected ? [] : (["stepSequencer", "pianoRoll", "noteTools"] as const)),
    ...(instrumentType === "synth" || instrumentType === "drumSampler" || instrumentType === "keys" || instrumentType === "plugin"
      ? []
      : (["instrument"] as const)),
    ...(audioInputs && audioTrackCount > 0 ? [] : (["recordAudio"] as const)),
    ...(sampleSource ? [] : (["samples"] as const)),
  ];
  const emptyKey = empty.join(" ");
  // Clicking a key or a drum wherever one is drawn plays it, while there is audio to hear it.
  const playFromPicture = output ? playOrStop : undefined;
  // What the Keyboard lights and the Chords write into. Each is a fresh object on every render, but the
  // memoised Widgets compare them by what they hold (`ui/memo.ts`), so a meter reading doesn't redraw them.
  const keyboardPlaying = recordTrack && position !== null ? soundingOnTrack(recordTrack, position) : new Set<number>();
  const clipSignature = signatureAt(tempoMapOf(project), selected?.clip.start ?? 0);
  const clipBar = barTicks(clipSignature);
  const chordTarget = selected
    ? {
        trackName: selected.track.name,
        clipLength: selected.clip.length,
        notes: selected.clip.notes,
        beatTicks: beatTicks(clipSignature),
        barTicks: clipBar,
      }
    : null;
  const onEmpty = grid?.onEmpty;
  useEffect(() => {
    onEmpty?.(emptyKey ? (emptyKey.split(" ") as WidgetId[]) : []);
  }, [emptyKey, onEmpty]);
  // Engine Tracks are the Track list's, Audio Tracks included.
  const liveTrack = recordTrack ? project.tracks.indexOf(recordTrack) : -1;

  const waveformsByPath = new Map<string, Waveform>();
  for (const [path, loaded] of samples) {
    const waveform = waveforms.get(loaded);
    if (waveform) waveformsByPath.set(path, waveform);
  }

  const execute = (command: Command | Command[], label?: string) => {
    const result = history.execute(command, label);
    if (!result.ok) setError(result.error);
    else setError(null);
  };

  // The engine follows the Project, the samples loaded onto its pads and the
  // Plugins installed, so installing one a Project is missing brings it in,
  // and each VST3 Plugin takes its place once its instance has loaded.
  const plugins = useInstalledPlugins(pluginFolder);
  const vst3 = useVst3(vst3Host, project, history);
  const vst3Instances = useVst3Instances();
  useEffect(() => {
    if (!output) return;
    for (const command of syncRef.current.update(project, samples)) output.send(command);
    // EngineSync reads the installed Plugins and the VST3 instances itself; they are here so it runs again when they change.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [output, project, samples, plugins, vst3Instances]);

  // A Project opened from its folder brings its audio back as bytes; each
  // Audio Clip's file is measured for its waveform once.
  useEffect(() => {
    for (const track of project.tracks) {
      if (track.kind !== "audio") continue;
      for (const clip of track.clips) {
        const loaded = samples.get(clip.file);
        if (!loaded || waveforms.has(loaded) || measuringRef.current.has(loaded)) continue;
        measuringRef.current.add(loaded);
        summariseAudio(loaded.bytes)
          .then((waveform) => setWaveforms((known) => new Map(known).set(loaded, waveform)))
          // It plays or it doesn't; there is just no waveform to draw.
          .catch(() => {});
      }
    }
  }, [project, samples, waveforms]);

  // What Play plays: the selected Section, the ruler's region, or the whole song. With Loop on it loops;
  // with Loop off, playback stops at its end.
  const songMap = tempoMapOf(project);
  const playSection = project.sections.find((section) => section.id === playSectionId) ?? null;
  const range = playRange(
    transport,
    songMap,
    songEndTick(project),
    playSection && {
      name: playSection.name,
      start: barStart(songMap, playSection.startBar),
      end: barStart(songMap, playSection.startBar + playSection.bars),
    },
  );

  // Loop and metronome are the transport bar's own; tempo and time signature
  // are the Project's.
  useEffect(() => {
    if (!output) return;
    const commands = transportCommands(
      { ...transport, timeSignature: project.timeSignature },
      { start: range.start, end: range.end },
      { recording: recording || recordingAudio },
    );
    for (const command of commands) {
      if (command.type !== "setTempo" && command.type !== "setTimeSignature") output.send(command);
    }
  }, [output, transport, project.timeSignature, range.start, range.end, recording, recordingAudio]);

  // Live notes play through the Track being recorded onto.
  useEffect(() => {
    output?.send({ type: "setLiveTrack", track: liveTrack >= 0 ? liveTrack : null });
  }, [output, liveTrack]);

  useEffect(() => {
    if (!output) return;
    // The meters come from the engine's own measurement, with the position.
    const timer = setInterval(() => {
      const stats = output.stats();
      setPosition(stats.engine?.position ?? null);
      setMeters(stats.meters);
      // The engine's log is a fixed size, so it is drained as it fills.
      if (recording) recordedRef.current.push(...output.takeRecordedNotes());
    }, POSITION_MS);
    return () => clearInterval(timer);
  }, [output, recording]);

  // The computer keyboard plays, and records, like a MIDI keyboard.
  useEffect(
    () => listenToComputerKeyboard(window, playNote, setOctave),
    [playNote],
  );

  useEffect(() => {
    if (!openMidi || showLatency) return;
    const opening = openMidi(
      playNote,
      (names) => setMidiStatus(names.length ? `MIDI: ${names.join(", ")}` : null),
    );
    opening.catch(() => setMidiStatus(null));
    return () => void opening.then((midi) => midi.close()).catch(() => {});
  }, [openMidi, showLatency, playNote]);

  useEffect(() => () => void outputRef.current?.close(), []);

  // The Editor's song stops while the Mixer page or the Pads page is open,
  // so only the DJ mix is heard (ADR 0013). Both are drawn once first opened,
  // and kept, so the Decks stay as the DJ left them (`DjPages`).
  useEffect(() => {
    if (view === "mixing" || view === "pads") output?.send({ type: "stop" });
  }, [view, output]);

  const projectTiming = () => ({ tempo: project.tempo, timeSignature: project.timeSignature });

  const start = async (preferences = audioPreferences) => {
    setStarting(true);
    setError(null);
    setStartError(null);
    try {
      const { host, bufferFrames } = audioDevice ? preferences : { host: null, bufferFrames: null };
      const opened = await openOutput({
        latencyHint: "interactive",
        ...(host ? { host } : {}),
        ...(bufferFrames ? { bufferFrames } : {}),
        trackCount: 0,
      });
      outputRef.current = opened;
      syncRef.current = new EngineSync();
      setOutput(opened);
    } catch (reason) {
      setError(String(reason));
      setStartError(String(reason));
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    // What was being recorded is a take the musician played: stopping the
    // audio ends the recording where the transport stopped and keeps it,
    // rather than leaving the Record button armed over a closed engine.
    if (recording) stopRecording();
    const current = outputRef.current;
    outputRef.current = null;
    setOutput(null);
    setPosition(null);
    setMeters(null);
    await current?.close();
  };

  /**
   * Keep the new audio host or buffer size and, if audio is running, start
   * it again on them. The new stream is a fresh engine, which the effects
   * above bring up to date with the Project and the transport.
   */
  const changeAudio = async (next: AudioPreferences) => {
    setAudioPreferences(next);
    writeAudioPreferences(next);
    const current = outputRef.current;
    if (!current) return;
    outputRef.current = null;
    setOutput(null);
    setPosition(null);
    setMeters(null);
    await current.close();
    await start(next);
  };

  const send = (command: EngineCommand) => outputRef.current?.send(command);
  const readReport = useCallback(() => outputRef.current?.stats().engine ?? null, []);

  const changeTransport = (next: TransportSettings) => {
    if (next.tempo !== project.tempo) execute({ type: "setTempo", tempo: next.tempo });
    const { beatsPerBar, beatUnit } = next.timeSignature;
    if (beatsPerBar !== project.timeSignature.beatsPerBar || beatUnit !== project.timeSignature.beatUnit) {
      execute({ type: "setTimeSignature", timeSignature: next.timeSignature });
    }
    setTransport(next);
  };

  /** "Synth 3": the first number that isn't taken. */
  const nextName = (prefix: string) => {
    const names = new Set(project.tracks.map((t) => t.name));
    let number = tracks.length + 1;
    while (names.has(`${prefix} ${number}`)) number++;
    return `${prefix} ${number}`;
  };

  const addTrack = () => execute({ type: "addTrack", track: createInstrumentTrack(nextName("Synth")) });
  const addDrumTrack = () => execute({ type: "addTrack", track: createDrumTrack(nextName("Drums")) });
  // A new Keys Track starts on the first factory piano, the Concert Grand.
  const addKeysTrack = () => execute({ type: "addTrack", track: createKeysTrack(nextName("Keys"), undefined, KEYS_PRESETS[0]!) });
  const addAudioTrack = () => execute({ type: "addTrack", track: createAudioTrack(nextName("Audio")) });
  const addPluginTrack = (manifest: PluginManifest) => {
    const track = createInstrumentTrack(nextName(manifest.name));
    execute({ type: "addTrack", track: { ...track, instrument: createPluginInstrument(manifest) } });
  };
  // A VST3 Instrument is loaded before its Track is added, so it starts at its own settings.
  const addVst3Track = async (vst3Class: Vst3Class, bundle: string) => {
    if (!vst3) return;
    const track = createInstrumentTrack(nextName(vst3Class.name));
    try {
      const manifest = await vst3.sync.createInstrument(vst3Class, bundle, track.id);
      const result = history.execute({ type: "addTrack", track: { ...track, instrument: createPluginInstrument(manifest) } });
      if (!result.ok) {
        vst3.sync.discard(manifest.key);
        setError(result.error);
      } else setError(null);
    } catch (reason) {
      setError(`${vst3Class.name} couldn't be loaded: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  };
  const vst3Instruments = vst3 ? vst3Classes().filter(({ vst3Class }) => isVst3Instrument(vst3Class)) : [];

  /**
   * Import a file onto an Audio Track as a Clip after its last one, as long
   * as the file lasts. The bytes go to the engine and are saved into the
   * Project folder's `audio/`, so the Project no longer needs the original.
   */
  const importAudio = async (track: AudioTrack, file: File, at?: number, label = "Import audio") => {
    try {
      const { sample, waveform } = await readAudioFile(file);
      const map = tempoMapOf(project);
      const after = Math.max(0, ...track.clips.map((c) => Math.ceil(clipEnd(c, map))));
      addAudioClip(track, sample, waveform, at ?? after, label);
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    }
  };

  // Import as Stems… asks for its file with this, hidden.
  const importStemsInput = useRef<HTMLInputElement>(null);
  /**
   * Import as Stems…: the whole of `file` separated, as the Clip menu's
   * Separate into Stems is, and its Stems put on four new Tracks at the end
   * of the list from the playhead (or the song's start, with no audio
   * running) as it was when the file was chosen. The file itself is only
   * read: none of it is copied into the Project but its Stems.
   */
  const importAsStems = async (file: File) => {
    const playhead = Math.max(0, Math.round(outputRef.current?.stats().engine?.position ?? 0));
    const bytes = new Uint8Array(await file.arrayBuffer());
    let seconds: number;
    try {
      ({ seconds } = await summariseAudio(bytes));
    } catch (reason) {
      setError(`${file.name} can't be imported: ${String(reason)}`);
      return;
    }
    await stemSeparation.start({ kind: "file", name: file.name, bytes, duration: seconds, start: playhead });
  };

  /** Copy `sample` into the Project as its Reference Track, in place of any before it. */
  const chooseReference = (sample: LoadedSample) => {
    const path = copyPathFor(sample, samples, project);
    addSamples(new Map([[path, samples.get(path) ?? sample]]));
    execute({ type: "setReferenceTrack", referenceTrack: { file: path } }, project.referenceTrack ? "Replace Reference Track" : "Add Reference Track");
  };

  /** The whole mix's integrated loudness, to match the reference to; null for a song with nothing in it. */
  const measureMix = useMemo(
    () =>
      analyseAudio &&
      (async () => {
        const song = history.project;
        const end = songEndTick(song);
        if (end === 0) return null;
        const { measurements } = await listenWith(analyseAudio, currentSamples())(song, { start: 0, end, track: null });
        return integratedLufs(measurements);
      }),
    [analyseAudio, currentSamples, history],
  );

  /** Put `sample` on `track` from tick `at`, as long as it lasts, as one undo step. */
  const addAudioClip = (track: AudioTrack, sample: LoadedSample, waveform: Waveform, at: number, label: string) =>
    addAudioClips([{ track, sample, waveform, at }], label);

  /** Put each sample on its Track from its tick, all as one undo step. */
  const addAudioClips = (
    placed: readonly { track: AudioTrack; sample: LoadedSample; waveform: Waveform; at: number }[],
    label: string,
  ) => {
    const added = new Map<string, LoadedSample>();
    const commands: Command[] = placed.map(({ track, sample, waveform, at }) => {
      const withAdded = new Map([...samples, ...added]);
      const path = copyPathFor(sample, withAdded, project);
      const loaded = withAdded.get(path) ?? sample;
      added.set(path, loaded);
      setWaveforms((known) => new Map(known).set(loaded, waveform));
      const clip: AudioClip = {
        id: newId(),
        kind: "audio",
        start: at,
        duration: waveform.seconds,
        file: path,
        fileOffset: 0,
      };
      return { type: "addClip", trackId: track.id, clip };
    });
    setSamples((known) => new Map([...known, ...added]));
    execute(commands, label);
  };

  /**
   * The takes recorded onto armed Tracks become new Audio Clips where they
   * were played, and their WAVs are saved into the Project folder's `audio/`
   * with the rest. One undo removes them all.
   */
  const addRecordedTakes = async (takes: readonly { track: AudioTrack; take: RecordedTake }[]) => {
    try {
      const placed = await Promise.all(
        takes.map(async ({ track, take }) => ({
          track,
          sample: { name: `${track.name} take.wav`, bytes: [...take.wav] },
          waveform: await summariseAudio(take.wav),
          at: take.startTick,
        })),
      );
      if (placed.length > 0) addAudioClips(placed, "Record audio");
    } catch (reason) {
      setError(`The recording couldn't be read back: ${String(reason instanceof Error ? reason.message : reason)}`);
    }
  };

  /**
   * A recording made on the Mixer or Pads page, put into the song as an Audio
   * Clip: at the playhead, the start of its bar or the song's start, on a new
   * Audio Track or the selected one where it has room, as one undo step. Its
   * WAV is saved into the Project folder's `audio/` with the rest. The take
   * is audio, so it isn't stretched: where the mix's tempo wasn't the song's
   * there, it says so, and offers the song the mix's tempo, as a change of its own.
   */
  const addTakeToSong = async (request: AddTakeRequest): Promise<AddedTake> => {
    const waveform = await summariseAudio(request.wav);
    const now = history.project;
    const playhead = outputRef.current?.stats().engine?.position ?? 0;
    const placed = placeTake(now, {
      playhead,
      seconds: waveform.seconds,
      place: request.place,
      track: request.track,
      selectedTrackId: selectedAudio?.track.id ?? selected?.track.id ?? null,
    });
    const track = placed.track ?? createAudioTrack(nextName(request.name));
    const sample: LoadedSample = { name: `${placed.track ? request.name : track.name}.wav`, bytes: [...request.wav] };
    const path = copyPathFor(sample, samples, now);
    const loaded = samples.get(path) ?? sample;
    const clip: AudioClip = { id: newId(), kind: "audio", start: placed.at, duration: waveform.seconds, file: path, fileOffset: 0 };
    const command: Command = placed.track ? { type: "addClip", trackId: placed.track.id, clip } : { type: "addTrack", track: { ...track, clips: [clip] } };
    const result = history.execute(command, "Add recording to song");
    if (!result.ok) throw new Error(result.error);
    setWaveforms((known) => new Map(known).set(loaded, waveform));
    setSamples((known) => new Map(known).set(path, loaded));

    const where = `${describeTick(now, placed.at)}${request.place === "playhead" ? " (the playhead)" : ""}`;
    const onWhat = placed.track ? `on ${placed.track.name}` : `on ${track.name}, a new Audio Track`;
    const why = placed.fallback ? ` It isn't on the selected Audio Track: ${placed.fallback}.` : "";
    let message = `The take is in the song ${onWhat}, from ${where}.${why} Undo takes it out.`;
    const songTempo = tempoMismatch(now, placed.at, request.bpm);
    if (songTempo === null || request.bpm === null) return { message };
    const mix = roundBpm(request.bpm);
    message += ` The mix was at ${mix} BPM and the song is at ${songTempo} BPM there: the take is audio, so it keeps the mix's tempo and isn't stretched to the song's.`;
    const apply = () => {
      const changed = history.execute(setTempoAt(history.project, placed.at, mix), "Set tempo to the mix's");
      if (!changed.ok) throw new Error(changed.error);
      return `The song is at ${mix} BPM from ${describeTick(history.project, placed.at)} now, as the mix was. Undo puts ${songTempo} BPM back.`;
    };
    return { message, setTempo: { bpm: mix, apply } };
  };

  const setPad = (trackId: string, pad: number, settings: Partial<DrumPad>) =>
    execute({ type: "setDrumPad", trackId, pad, settings });

  /**
   * Put a WAV on a pad: the bytes go to the engine, and the path they will be
   * saved under goes on the pad, so it undoes and the Project folder keeps it.
   */
  const loadSample = async (trackId: string, pad: number, file: File, label = "Load sample") => {
    try {
      const sample = await readWavFile(file);
      // The same file on a second pad is the same copy; anything else gets a
      // path of its own, even where it is called what another sample is.
      const path = copyPathFor(sample, samples, project);
      setSamples((loaded) => new Map(loaded).set(path, sample));
      execute({ type: "setDrumPad", trackId, pad, settings: { sample: path } }, label);
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    }
  };

  /**
   * Put a WAV on a Track's Keys, to play at each key's pitch: as a pad's
   * sample, its bytes go to the engine and its path onto the Keys, and the
   * source becomes the sample, as one undo step.
   */
  const loadKeysSample = async (trackId: string, file: File, label = "Load Keys sample") => {
    try {
      const sample = await readWavFile(file);
      const path = copyPathFor(sample, samples, project);
      setSamples((loaded) => new Map(loaded).set(path, sample));
      execute({ type: "setKeysSample", trackId, sample: path }, label);
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    }
  };

  /**
   * Put a Kit's pads on a Drum Sampler, as one undo step. Its samples are
   * copied into the Project, like a WAV loaded onto a pad, so saving writes
   * them into the Project folder and the Project never names the library.
   */
  const loadKit = (trackId: string, kit: SavedKit, kitSamples: ReadonlyMap<string, LoadedSample>) => {
    try {
      const loaded = loadKitCommand(trackId, kit, kitSamples, samples, audioFiles(project));
      setSamples((known) => new Map([...known, ...loaded.samples]));
      execute(loaded.command, "Load Kit");
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    }
  };

  /**
   * Where the sample browser can put a file without dragging it: each Audio
   * Track, after its last Clip, and each Drum Sampler's pads.
   */
  const sampleTargets: SampleTarget[] = project.tracks.flatMap((track): SampleTarget[] => {
    if (track.kind === "audio") return [{ id: `track:${track.id}`, label: track.name }];
    if (track.instrument.type === "keys") return [{ id: `keys:${track.id}`, label: `${track.name}: Keys sample` }];
    if (track.instrument.type !== "drumSampler") return [];
    return track.instrument.pads.map((pad, index) => ({
      id: `pad:${track.id}:${index}`,
      label: `${track.name}: ${pad.name}`,
    }));
  });

  /**
   * A file from the sample browser, put on an Audio Track as an Audio Clip
   * (at `at`, or after its last Clip) or on a pad. Its bytes are copied in
   * and saved into the Project folder's `audio/` like an import's, so the
   * Project never names the sample folder; the drop is one undo step.
   */
  const putSample = async (sample: SampleRef, target: string, at?: number) => {
    if (!sampleSource) return;
    let file: File;
    try {
      file = new File([await sampleSource.readBytes(sample)], fileName(sample.path));
    } catch (reason) {
      setError(`${sample.path} couldn't be read: ${String(reason instanceof Error ? reason.message : reason)}`);
      return;
    }
    const [kind, trackId, pad] = target.split(":");
    const track = project.tracks.find((candidate) => candidate.id === trackId);
    if (kind === "track" && track?.kind === "audio") await importAudio(track, file, at, "Drop sample");
    else if (kind === "pad" && track) await loadSample(track.id, Number(pad), file, "Drop sample");
    else if (kind === "keys" && track) await loadKeysSample(track.id, file, "Drop sample");
  };

  const dropSample = (target: string, transfer: DataTransfer, at?: number) => {
    const sample = droppedSample(transfer);
    if (sample) void putSample(sample, target, at);
  };

  const addClip = (track: InstrumentTrack) => {
    // After the Track's last Clip.
    const after = Math.max(0, ...track.clips.map((c) => c.start + c.length));
    const clip: PatternClip = { id: newId(), kind: "pattern", start: after, length: newClipLength(after), notes: [] };
    execute({ type: "addClip", trackId: track.id, clip });
    selectClip(track, clip.id);
  };

  /**
   * Open `clipId` in the Audio Editor and bring the editor into view: it
   * sits under the Timeline, which may be below the window's fold once the
   * Grid has been rearranged.
   */
  const editAudio = (clipId: string) => {
    setSelectedClipId(clipId);
    // Hidden from the Grid menu, it is shown again: the musician asked for it.
    if (layout.audioEditor.hidden) setLayout(setWidgetHidden(layout, "audioEditor", false));
    requestAnimationFrame(revealAudioEditor);
  };

  const isAudioClip = (clipId: string) =>
    project.tracks.some((track) => track.kind === "audio" && track.clips.some((clip) => clip.id === clipId));

  const selectClip = (track: InstrumentTrack, clipId: string) => {
    setSelectedClipId(clipId);
    setSelectedTrackId(track.id);
  };

  /** A new Pattern Clip starting at `at` is `CLIP_BARS` of the bars there. */
  const newClipLength = (at: number) => CLIP_BARS * barTicks(signatureAt(tempoMapOf(project), at));

  /**
   * Arm and roll: live notes are logged from here, and the transport plays,
   * until `stopRecording` turns what was played into notes.
   */
  const startRecording = () => {
    const current = outputRef.current;
    if (!current || !recordTrack) return;
    // Anything logged before now belongs to no recording.
    current.takeRecordedNotes();
    recordedRef.current = [];
    recordingFromRef.current = {
      startTick: current.stats().engine?.position ?? 0,
      trackId: recordTrack.id,
      clipId: selected?.track.id === recordTrack.id ? selected.clip.id : null,
      newClipId: newId(),
    };
    current.send({ type: "setRecording", on: true });
    current.send({ type: "play" });
    setRecording(true);
  };

  /**
   * Drop a recording without turning it into notes: what was played belongs
   * to the Project it was played into, and that Project is going.
   */
  const abandonRecording = () => {
    setRecording(false);
    recordingFromRef.current = null;
    recordedRef.current = [];
    const current = outputRef.current;
    if (!current) return;
    current.send({ type: "setRecording", on: false });
    current.send({ type: "stop" });
    // Whatever the engine has logged belongs to no recording now.
    current.takeRecordedNotes();
  };

  /**
   * Stop, and put what was played in the Clip as one undo step. A note still
   * held down ends where the transport stopped.
   */
  const stopRecording = () => {
    setRecording(false);
    const current = outputRef.current;
    const from = recordingFromRef.current;
    recordingFromRef.current = null;
    if (!current) return;

    const stopTick = current.stats().engine?.position ?? 0;
    current.send({ type: "setRecording", on: false });
    current.send({ type: "stop" });
    const events = [...recordedRef.current, ...current.takeRecordedNotes()];
    recordedRef.current = [];

    const track = from && tracks.find((candidate) => candidate.id === from.trackId);
    if (!from || !track) return;
    const clip = track.clips.find((candidate) => candidate.id === from.clipId) ?? null;
    const commands = recordingCommands(events, {
      track,
      clip,
      startTick: from.startTick,
      stopTick,
      newClipLength: newClipLength(from.startTick),
      quantiseTicks: quantise ? stepTicks : null,
      newClipId: () => from.newClipId,
    });
    if (commands.length === 0) return;

    const result = history.execute(commands, "Record");
    if (!result.ok) setError(result.error);
    else {
      setError(null);
      selectClip(track, clip?.id ?? from.newClipId);
    }
  };

  const openLatencyTest = async () => {
    await stop();
    setLatencyOpen(true);
  };

  const projectFile = useProjectFile({
    storage,
    history,
    samples,
    disabled: requesting,
    beforeSave: vst3 ? (saving) => vst3.sync.withStates(saving) : undefined,
    onAudio: addSamples,
    onProject: (opened, loaded) => {
      // The Project being edited is going, and a take in progress goes
      // with it: it was played into that Project's Track, and nothing of
      // that Project stays selected either.
      abandonRecording();
      // So does a Stem Separation: its Clip was that Project's.
      stemSeparation.cancel();
      setHistory(opened);
      setSamples(loaded);
      setSelectedClipId(null);
      setSelectedTrackId(null);
    },
  });
  // An update restarts the app, so it asks first about unsaved changes.
  const updates = useUpdates(updater, { mayDiscard: projectFile.mayDiscard });

  const live = useLiveSession({
    history,
    samples: currentSamples,
    onAudio: addSamples,
    adopt: projectFile.adopt,
    shared: projectFile.shared,
    mayDiscard: projectFile.mayDiscard,
    site: inviteSite,
    connect: connectRelay,
  });
  // The Browser Version opened from an invite link offers to join it. The
  // link leaves the address bar, so reloading doesn't offer it again.
  const [liveDialog, setLiveDialog] = useState<{ link?: string } | null>(() =>
    typeof location !== "undefined" && readInvite(location.hash) ? { link: location.href } : null,
  );
  useEffect(() => {
    if (typeof location !== "undefined" && readInvite(location.hash)) {
      window.history.replaceState(null, "", `${location.pathname}${location.search}`);
    }
  }, []);

  // Why Separate into Stems and Import as Stems… can't be chosen now, if it can't.
  const cantSeparate = !stemSeparator
    ? "This version of Soundcheck can't separate Stems."
    : stemSeparation.separator?.kind === "unavailable"
      ? stemSeparation.separator.reason
      : stemSeparation.busy
        ? "A Stem Separation is already running."
        : undefined;
  const fileItems: MenuItem[] = [
    {
      kind: "action",
      id: "new",
      label: "New",
      icon: <FilePlus2 size={16} />,
      shortcut: "Ctrl+N",
      disabled: projectFile.replaceBlocked,
      onSelect: projectFile.newProject,
    },
    {
      kind: "action",
      id: "open",
      label: "Open…",
      icon: <FolderOpen size={16} />,
      shortcut: "Ctrl+O",
      disabled: projectFile.replaceBlocked,
      onSelect: projectFile.open,
    },
    {
      kind: "action",
      id: "save",
      label: "Save",
      icon: <Save size={16} />,
      shortcut: "Ctrl+S",
      disabled: projectFile.busy,
      onSelect: projectFile.save,
    },
    {
      kind: "action",
      id: "save-as",
      label: "Save As…",
      icon: <SaveAll size={16} />,
      shortcut: "Ctrl+Shift+S",
      disabled: projectFile.busy,
      onSelect: projectFile.saveAs,
    },
    {
      kind: "action",
      id: "share",
      label: "Share this Project…",
      icon: <Share2 size={16} />,
      // Sharing starts the log afresh, which a Live Session's members can't follow.
      disabled: projectFile.replaceBlocked || projectFile.shared || live.active,
      onSelect: projectFile.share,
    },
    {
      kind: "action",
      id: "live-session",
      label: "Live Session…",
      icon: <Radio size={16} />,
      disabled: !live.active && projectFile.replaceBlocked,
      onSelect: () => setLiveDialog({}),
    },
    { kind: "separator", id: "tracks-separator" },
    {
      kind: "submenu",
      id: "tracks",
      label: "Tracks",
      icon: <Rows3 size={16} />,
      items: [
        { kind: "action", id: "add-instrument-track", label: "Add Instrument Track", icon: <Plus size={16} />, shortcut: "Ctrl+Shift+T", trackKind: "instrument", onSelect: addTrack },
        { kind: "action", id: "add-drum-track", label: "Add Drum Track", icon: <Plus size={16} />, shortcut: "Ctrl+Shift+D", trackKind: "drum", onSelect: addDrumTrack },
        { kind: "action", id: "add-keys-track", label: "Add Keys Track", icon: <Plus size={16} />, trackKind: "instrument", onSelect: addKeysTrack },
        { kind: "action", id: "add-audio-track", label: "Add Audio Track", icon: <Plus size={16} />, shortcut: "Ctrl+Shift+A", trackKind: "audio", onSelect: addAudioTrack },
        ...plugins
          .filter(({ manifest }) => manifest.kind === "instrument")
          .map(({ manifest }): MenuItem => ({
            kind: "action",
            id: `add-plugin-track:${manifest.id}`,
            label: `Add ${manifest.name} Track`,
            icon: <Plus size={16} />,
            trackKind: "instrument",
            onSelect: () => addPluginTrack(manifest),
          })),
        ...vst3Instruments.map(({ bundle, vst3Class }): MenuItem => ({
          kind: "action",
          id: `add-vst3-track:${vst3Class.cid}`,
          label: `Add ${vst3Class.name} Track`,
          icon: <Plus size={16} />,
          trackKind: "instrument",
          onSelect: () => void addVst3Track(vst3Class, bundle),
        })),
      ],
    },
    { kind: "separator", id: "export-separator" },
    {
      kind: "action",
      id: "import-as-stems",
      label: "Import as Stems…",
      icon: <FileAudio size={16} />,
      disabled: cantSeparate !== undefined,
      description: cantSeparate,
      onSelect: () => importStemsInput.current?.click(),
    },
    {
      kind: "action",
      id: "export",
      label: "Export…",
      icon: <Download size={16} />,
      shortcut: "Ctrl+E",
      disabled: !exporter,
      onSelect: () => setExportOpen(true),
    },
  ];
  useMenuShortcuts(fileItems);

  // Only an Audio Clip has a menu for now: Export Clip… writes its own audio, raw.
  const clipMenuItems = (clip: Clip): MenuItem[] =>
    clip.kind === "audio"
      ? [
          {
            kind: "action",
            id: "edit-audio",
            label: "Edit in Audio Editor",
            icon: <Scissors size={16} />,
            onSelect: () => editAudio(clip.id),
          },
          {
            kind: "action",
            id: "export-clip",
            label: "Export Clip…",
            icon: <Download size={16} />,
            disabled: !exporter,
            onSelect: () => setClipToExport(clip.id),
          },
          {
            kind: "action",
            id: "separate-stems",
            label: "Separate into Stems",
            icon: <Split size={16} />,
            disabled: cantSeparate !== undefined,
            description: cantSeparate,
            onSelect: () => void stemSeparation.start({ kind: "clip", clip }),
          },
        ]
      : [];
  // Gone with its Clip, as after an undo.
  const exportedClip =
    project.tracks
      .flatMap((track): AudioClip[] => (track.kind === "audio" ? track.clips : []))
      .find((clip) => clip.id === clipToExport) ?? null;

  const titleBar = (
    <>
      {menu ? (
        <Menu
          label={menu.label}
          ariaLabel={menu.ariaLabel}
          items={[
            { kind: "submenu", id: "file", label: "File", icon: <FolderOpen size={16} />, items: fileItems },
            { kind: "separator", id: "file-separator" },
            ...menu.items,
          ]}
        />
      ) : (
        <Menu label="File" ariaLabel="File menu" items={fileItems} />
      )}
      <ProjectTitle file={projectFile} history={history} live={live.active} />
    </>
  );

  // An Audio Clip whose file isn't here plays silence. In a Live Session or a
  // Shared Project it is on its way from a Collaborator (ADR 0007);
  // otherwise it is missing.
  const absentAudio = new Map<string, AbsentAudio>();
  for (const track of project.tracks) {
    if (track.kind !== "audio") continue;
    for (const clip of track.clips) {
      if (!samples.has(clip.file)) absentAudio.set(clip.file, live.active || projectFile.shared ? "arriving" : "missing");
    }
  }

  return (
    <Vst3Provider vst3={vst3} unavailable={vst3Unavailable}>
      {header === undefined ? <div className="header-start">{titleBar}</div> : header && createPortal(titleBar, header)}
      <ProjectFileAlerts file={projectFile} />
      <UpdateNotice updates={updates} />
      <Dialog open={exportOpen} onClose={() => setExportOpen(false)} title="Export" closeLabel="Close export">
        <ExportPanel
          exporter={exporter}
          project={project}
          samples={samples}
          loop={{ start: range.start, end: range.end }}
        />
      </Dialog>
      <Dialog
        open={exportedClip !== null}
        onClose={() => setClipToExport(null)}
        title="Export Clip"
        closeLabel="Close Clip export"
      >
        {exportedClip && <ClipExportPanel exporter={exporter} clip={exportedClip} samples={samples} />}
      </Dialog>
      <div
        id={viewPanelId("editor")}
        className="page studio"
        hidden={view !== "editor"}
        aria-labelledby="editor-title"
      >
        <h1 id="editor-title" className="visually-hidden">
          Editor: {project.name}
        </h1>
        <section aria-label="Song" className="studio">
          {showLatency && (
            <p className="notice">The latency test in Settings has the audio. Close it to start the song&apos;s audio again.</p>
          )}
          {error && (
            <p role="alert" className="alert">
              {error}
            </p>
          )}
          <CollaborationNotices key={history.copy} history={history} />
          <LiveSessionDialog
            key={liveDialog?.link}
            open={liveDialog !== null}
            onClose={() => setLiveDialog(null)}
            live={live}
            initialLink={liveDialog?.link}
          />
          <StemSeparationPanel run={stemSeparation} />
          <input
            ref={importStemsInput}
            type="file"
            hidden
            accept={AUDIO_FILE_TYPES}
            aria-label="Import as Stems"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importAsStems(file);
              // The same file can be imported again.
              event.target.value = "";
            }}
          />

          <WidgetGrid
            layout={layout}
            onLayout={setLayout}
            pinned={grid?.pinned}
            empty={empty}
            widgets={{
              transport: (
                <div className="toolbar" role="toolbar" aria-label="Audio, transport and recording">
                  <div className="toolbar-group">
                    {output ? (
                      <button type="button" onClick={() => void stop()}>
                        <Power size={16} aria-hidden />
                        Stop audio
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={starting || showLatency}
                        aria-busy={starting}
                        onClick={() => void start()}
                      >
                        <Power size={16} aria-hidden />
                        {starting ? "Starting…" : "Start audio"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-icon"
                      aria-label={`Undo${history.undoLabel ? ` ${history.undoLabel}` : ""}`}
                      title={`Undo${history.undoLabel ? ` ${history.undoLabel}` : ""}`}
                      aria-keyshortcuts="Control+Z"
                      disabled={!history.canUndo}
                      onClick={() => history.undo()}
                    >
                      <Undo2 size={16} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="btn-icon"
                      aria-label={`Redo${history.redoLabel ? ` ${history.redoLabel}` : ""}`}
                      title={`Redo${history.redoLabel ? ` ${history.redoLabel}` : ""}`}
                      aria-keyshortcuts="Control+Shift+Z"
                      disabled={!history.canRedo}
                      onClick={() => history.redo()}
                    >
                      <Redo2 size={16} aria-hidden />
                    </button>
                  </div>
                  <span className="divider" aria-hidden />
                  <TransportBar
                    settings={{ ...transport, ...projectTiming() }}
                    range={range}
                    onWholeSong={() => setPlaySectionId(null)}
                    tempoMap={tempoMapOf(project)}
                    onChange={changeTransport}
                    send={send}
                    readReport={readReport}
                  />
                  {referencePlayer && (
                    <>
                      <span className="divider" aria-hidden />
                      <ReferenceTrackControl
                        referenceTrack={project.referenceTrack}
                        sample={project.referenceTrack ? samples.get(project.referenceTrack.file) : undefined}
                        player={referencePlayer}
                        measureMix={measureMix}
                        onChoose={chooseReference}
                        onRemove={() => execute({ type: "setReferenceTrack", referenceTrack: null }, "Remove Reference Track")}
                        onError={setError}
                        disabled={requesting}
                      />
                    </>
                  )}
                  <span className="divider" aria-hidden />
                  <div className="toolbar-group" role="group" aria-label="Record notes">
                    <label className="field">
                      Record onto
                      <select
                        value={recordTrack?.id ?? ""}
                        disabled={recording || tracks.length === 0}
                        onChange={(event) => setSelectedTrackId(event.target.value)}
                      >
                        {tracks.length === 0 && <option value="">No Instrument Tracks</option>}
                        {tracks.map((track) => (
                          <option key={track.id} value={track.id}>
                            {track.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="btn-record"
                      aria-pressed={recording}
                      disabled={!output || !recordTrack}
                      onClick={() => (recording ? stopRecording() : startRecording())}
                    >
                      {recording ? <Square size={14} aria-hidden /> : <Circle size={14} fill="currentColor" aria-hidden />}
                      {recording ? "Stop recording" : "Record"}
                    </button>
                    <label className="field-inline">
                      <input type="checkbox" checked={quantise} onChange={(event) => setQuantise(event.target.checked)} />
                      Quantise to step size
                    </label>
                    <span className="hint">
                      Keyboard octave{" "}
                      <span className="num">{octave}</span>
                      {midiStatus && ` · ${midiStatus}`}
                    </span>
                  </div>
                </div>
              ),
              assistant: keyStore && (
                <RequestBox
                  history={history}
                  keyStore={keyStore}
                  fetch={fetch}
                  conversations={conversations}
                  listen={listen}
                  hearReference={hearReference}
                  library={assistantSounds}
                  stems={assistantSeparation}
                  onRunning={setRequesting}
                  onOpenSettings={onView && (() => onView("settings"))}
                  // A take lands in the Project when it stops, which it couldn't
                  // while a Request had it: the take would be lost.
                  waitFor={recording || recordingAudio ? "Stop recording to make a Request." : null}
                />
              ),
              tracks: (
                <section aria-labelledby="tracks-heading" className="panel">
                  <div className="panel-head">
                    <h2 id="tracks-heading">
                      <ListMusic size={18} aria-hidden />
                      Tracks
                    </h2>
                  </div>
                  <TrackList
                    tracks={project.tracks}
                    onRename={(trackId, name) => execute({ type: "renameTrack", trackId, name })}
                    onMove={(trackId, index) => execute({ type: "moveTrack", trackId, index })}
                    onDelete={(trackId) => execute({ type: "deleteTrack", trackId })}
                    onAddClip={addClip}
                    onPickPreset={(trackId, preset) => {
                      const track = project.tracks.find((candidate) => candidate.id === trackId);
                      const keys = track?.kind === "instrument" && track.instrument.type === "keys";
                      execute(keys ? keysPresetCommand(trackId, preset) : synthPresetCommand(trackId, preset));
                    }}
                    onImportAudio={(track, file) => void importAudio(track, file)}
                    editingTrackId={selectedAudio?.track.id ?? null}
                    onEditAudio={(track) => {
                      // Its Clip already open stays open; otherwise its first.
                      const clip = track.clips.find((candidate) => candidate.id === selectedClipId) ?? track.clips[0];
                      if (clip) editAudio(clip.id);
                    }}
                  />
                  <AddTrack
                    choices={[
                      { id: "instrument", kind: "instrument", label: "Instrument", onAdd: addTrack },
                      { id: "drum", kind: "drum", label: "Drum", onAdd: addDrumTrack },
                      { id: "keys", kind: "instrument", label: "Keys", onAdd: addKeysTrack },
                      { id: "audio", kind: "audio", label: "Audio", onAdd: addAudioTrack },
                      ...plugins
                        .filter(({ manifest }) => manifest.kind === "instrument")
                        .map(({ manifest }): AddTrackChoice => ({
                          id: `plugin:${manifest.id}`,
                          kind: "instrument",
                          label: manifest.name,
                          onAdd: () => addPluginTrack(manifest),
                        })),
                      ...vst3Instruments.map(({ bundle, vst3Class }): AddTrackChoice => ({
                        id: `vst3:${vst3Class.cid}`,
                        kind: "instrument",
                        label: vst3Class.name,
                        onAdd: () => void addVst3Track(vst3Class, bundle),
                      })),
                    ]}
                  />
                </section>
              ),
              timeline: (
                <Timeline
                  project={project}
                  selectedClipId={selectedClipId}
                  position={position}
                  loop={{ start: range.start, end: range.end, enabled: transport.loop }}
                  clipBars={CLIP_BARS}
                  onSelectClip={(clipId) => {
                    const track = tracks.find((candidate) => candidate.clips.some((clip) => clip.id === clipId));
                    if (track && clipId) selectClip(track, clipId);
                    // An Audio Clip opens in the Audio Editor, brought into view when it wasn't already open.
                    else if (clipId && !selectedAudio && isAudioClip(clipId)) editAudio(clipId);
                    else setSelectedClipId(clipId);
                  }}
                  onCommands={execute}
                  onLoopRegion={(loopStart, loopEnd) => {
                    // A region dragged on the ruler is what plays, in place of a Section.
                    setPlaySectionId(null);
                    setTransport({ ...transport, loop: true, loopStart, loopEnd, loopRegionSet: true });
                  }}
                  onSelectSection={setPlaySectionId}
                  selectedSectionId={playSectionId}
                  waveforms={waveformsByPath}
                  absentAudio={absentAudio}
                  clipMenuItems={clipMenuItems}
                  onDropSample={
                    sampleSource && !requesting
                      ? (trackId, at, transfer) => dropSample(`track:${trackId}`, transfer, at)
                      : undefined
                  }
                  onImportAudio={
                    requesting
                      ? undefined
                      : (trackId, file, at) => {
                          const track = project.tracks.find((candidate) => candidate.id === trackId);
                          if (track?.kind === "audio") void importAudio(track, file, at);
                        }
                  }
                />
              ),
              audioEditor: selectedAudio ? (
                <AudioEditor
                  clip={selectedAudio.clip}
                  trackId={selectedAudio.track.id}
                  trackName={selectedAudio.track.name}
                  samples={samples}
                  tempoMap={tempoMapOf(project)}
                  exporter={exporter}
                  auditioner={referencePlayer}
                  onCommands={(commands, label) => execute(commands, label)}
                  disabled={requesting}
                />
              ) : null,
              stepSequencer: selected ? (
                <StepSequencer
                  key={selected.clip.id}
                  clip={selected.clip}
                  trackName={selected.track.name}
                  instrument={selected.track.instrument}
                  timeSignature={signatureAt(tempoMapOf(project), selected.clip.start)}
                  stepTicks={stepTicks}
                  onStepTicks={setStepTicks}
                  onNotes={(notes) => execute({ type: "setPatternNotes", clipId: selected.clip.id, notes })}
                  playhead={position}
                  held={held}
                  onPlay={playFromPicture}
                  onLength={(length) =>
                    execute({ type: "trimClip", clipId: selected.clip.id, start: selected.clip.start, length })
                  }
                  onDelete={() => {
                    execute({ type: "deleteClip", clipId: selected.clip.id });
                    setSelectedClipId(null);
                  }}
                />
              ) : null,
              // The same notes as the Step Sequencer: an edit in either shows in both.
              pianoRoll: selected ? (
                <PianoRoll
                  key={`piano-roll:${selected.clip.id}`}
                  clip={selected.clip}
                  trackName={selected.track.name}
                  instrument={selected.track.instrument}
                  timeSignature={signatureAt(tempoMapOf(project), selected.clip.start)}
                  onNotes={(notes, label) => execute({ type: "setPatternNotes", clipId: selected.clip.id, notes }, label)}
                  playhead={position}
                  held={held}
                  onPlay={playFromPicture}
                />
              ) : null,
              instrument:
                selected?.track.instrument.type === "synth" ? (
                  <SynthPanel
                    trackName={selected.track.name}
                    preset={selected.track.instrument.preset}
                    settings={selected.track.instrument.settings}
                    onChange={(settings) => execute({ type: "setSynthSettings", trackId: selected.track.id, settings })}
                  />
                ) : selected?.track.instrument.type === "drumSampler" ? (
                  <DrumPads
                    trackName={selected.track.name}
                    pads={selected.track.instrument.pads}
                    sampleNames={selected.track.instrument.pads.map((pad) =>
                      pad.sample ? (samples.get(pad.sample)?.name ?? fileName(pad.sample)) : undefined,
                    )}
                    onPad={(pad, settings) => setPad(selected.track.id, pad, settings)}
                    onAddPad={() => execute({ type: "addDrumPad", trackId: selected.track.id })}
                    onRemovePad={() => execute({ type: "removeDrumPad", trackId: selected.track.id })}
                    hitting={
                      new Set([...(position !== null ? soundingOnTrack(selected.track, position) : []), ...held])
                    }
                    onHit={playFromPicture}
                    onLoad={(pad, file) => void loadSample(selected.track.id, pad, file)}
                    onDropSample={
                      sampleSource && !requesting
                        ? (pad, transfer) => dropSample(`pad:${selected.track.id}:${pad}`, transfer)
                        : undefined
                    }
                    kitControls={
                      <KitControls
                        library={kitLibrary}
                        trackName={selected.track.name}
                        kit={selected.track.instrument.preset}
                        pads={selected.track.instrument.pads}
                        samples={samples}
                        disabled={requesting}
                        onLoad={(kit, kitSamples) => loadKit(selected.track.id, kit, kitSamples)}
                      />
                    }
                  />
                ) : selected?.track.instrument.type === "keys" ? (
                  <KeysPanel
                    trackName={selected.track.name}
                    preset={selected.track.instrument.preset}
                    settings={selected.track.instrument.settings}
                    sampleName={
                      selected.track.instrument.sample
                        ? (samples.get(selected.track.instrument.sample)?.name ?? fileName(selected.track.instrument.sample))
                        : null
                    }
                    onChange={(settings) => execute({ type: "setKeysSettings", trackId: selected.track.id, settings })}
                    onPreset={(preset) => execute(keysPresetCommand(selected.track.id, preset))}
                    onLoadSample={(file) => void loadKeysSample(selected.track.id, file)}
                    onClearSample={() => execute({ type: "setKeysSample", trackId: selected.track.id, sample: null }, "Remove Keys sample")}
                    onDropSample={
                      sampleSource && !requesting ? (transfer) => dropSample(`keys:${selected.track.id}`, transfer) : undefined
                    }
                  />
                ) : selected?.track.instrument.type === "plugin" ? (
                  <PluginInstrumentPanel
                    trackId={selected.track.id}
                    trackName={selected.track.name}
                    instrument={selected.track.instrument}
                    onChange={(settings) =>
                      execute({ type: "setInstrumentSettings", trackId: selected.track.id, settings })
                    }
                  />
                ) : null,
              recordAudio: (
                <AudioRecordPanel
                  inputs={audioInputs}
                  tracks={project.tracks.filter((track): track is AudioTrack => track.kind === "audio")}
                  engineTrack={(track) => project.tracks.indexOf(track)}
                  output={output}
                  disabled={requesting}
                  onRecorded={addRecordedTakes}
                  onInputChange={(track, input) => execute({ type: "setTrackInput", trackId: track.id, input })}
                  onMonitoringChange={(track, monitoring) =>
                    execute({ type: "setTrackMonitoring", trackId: track.id, monitoring })
                  }
                  onRecording={setRecordingAudio}
                  onError={setError}
                />
              ),
              samples: (
                <SampleBrowser
                  source={sampleSource}
                  library={library}
                  canAudition={output !== null}
                  targets={requesting ? [] : sampleTargets}
                  onUse={(sample, target) => void putSample(sample, target)}
                  onError={setError}
                />
              ),
              mixer: (
                <Mixer
                  project={project}
                  meters={meters}
                  onTrackMixer={(trackId, mixer) => execute({ type: "setTrackMixer", trackId, mixer })}
                  onMasterVolume={(volume) => execute({ type: "setMasterVolume", volume })}
                  onCommand={execute}
                />
              ),
              keyboard: (
                <KeyboardWidget
                  trackName={recordTrack?.name ?? null}
                  canPlay={output !== null}
                  songKey={songKey}
                  onSongKey={setSongKey}
                  held={held}
                  playing={keyboardPlaying}
                  noteOn={noteOn}
                  noteOff={noteOff}
                />
              ),
              chords: (
                <ChordsWidget
                  songKey={songKey}
                  onSongKey={setSongKey}
                  canPlay={output !== null}
                  noteOn={noteOn}
                  noteOff={noteOff}
                  target={chordTarget}
                  onNotes={(notes, label) => selected && execute({ type: "setPatternNotes", clipId: selected.clip.id, notes }, label)}
                  nextChord={nextChord}
                />
              ),
              noteTools: selected ? (
                <NoteToolsWidget
                  key={`note-tools:${selected.clip.id}`}
                  clip={selected.clip}
                  trackName={selected.track.name}
                  songKey={songKey}
                  onSongKey={setSongKey}
                  barTicks={clipBar}
                  onNotes={(notes, label) => execute({ type: "setPatternNotes", clipId: selected.clip.id, notes }, label)}
                />
              ) : null,
              meters: <MetersWidget project={project} meters={meters} />,
              overview: (
                <OverviewWidget
                  project={project}
                  position={position}
                  onSeek={output ? (tick) => send({ type: "seek", tick }) : undefined}
                />
              ),
              eq: (
                <EqWidget
                  project={project}
                  preferTrackId={selected?.track.id ?? selectedAudio?.track.id ?? null}
                  onCommand={(command, label) => execute(command, label)}
                />
              ),
            }}
          />
        </section>
      </div>

      <DjPages
        view={view}
        panelId={viewPanelId}
        output={output}
        onStart={() => void start()}
        starting={starting}
        saver={djRecordings}
        headphones={headphones}
        timecodeInput={timecodeInput}
        samples={sampleSource}
        library={library}
        mixingGrid={mixingGrid}
        padsGrid={padsGrid}
        onAddToSong={addTakeToSong}
      />

      <div id={viewPanelId("settings")} className="page" hidden={view !== "settings"} aria-labelledby="settings-title">
        <h1 id="settings-title" className="page-title">
          Settings
        </h1>
        <SettingsPage
          browserVersion={desktopOnly.length > 0 && <BrowserVersionSettings lacks={desktopOnly} />}
          assistant={keyStore && <AssistantSettings keyStore={keyStore} />}
          audio={
            audioDevice && (
              <AudioSettings
                {...audioDevice}
                preferences={audioPreferences}
                onChange={(next) => void changeAudio(next)}
                output={output}
                locked={recording || recordingAudio ? "Stop recording to change the audio host or buffer size." : null}
                error={startError}
              />
            )
          }
          plugins={pluginFolder && <PluginSettings folder={pluginFolder} />}
          vst3={vst3 ? <Vst3Settings vst3={vst3} /> : vst3Unavailable && <Vst3Unavailable reason={vst3Unavailable} />}
          collaboration={<CollaborationSettings key={history.copy} history={history} />}
          updates={updater && <UpdateSettings updates={updates} />}
          diagnostics={
            latencyTest &&
            (showLatency ? (
              <div className="stack">
                <div className="row">
                  <button type="button" onClick={() => setLatencyOpen(false)}>
                    Close latency test
                  </button>
                </div>
                <LoadTestPage
                  openOutput={openOutput}
                  openMidi={openMidi ?? noMidi}
                  initialHost={audioPreferences.host}
                  initialBufferFrames={audioPreferences.bufferFrames}
                  {...latencyTest}
                />
              </div>
            ) : (
              <div className="stack">
                <p className="hint">
                  Plays 16 Tracks of Synth, EQ, Compressor and Reverb and reports the output latency, dropouts and frame
                  rate. The song&apos;s audio stops while it runs.
                </p>
                <div className="row">
                  <button type="button" onClick={() => void openLatencyTest()}>
                    Open latency test
                  </button>
                </div>
              </div>
            ))
          }
          onShowCookiePolicy={onShowCookiePolicy}
          onShowAccessibility={onShowAccessibility}
        />
      </div>
    </Vst3Provider>
  );
}

// The new Widgets are drawn again only when their data changes, not on every meter reading (`ui/memo.ts`).
const KeyboardWidget = memoWidget(PianoKeyboard);
const ChordsWidget = memoWidget(ChordPads);
const NoteToolsWidget = memoWidget(NoteTools);
const MetersWidget = memoWidget(MeterBridge);
const OverviewWidget = memoWidget(SongOverview);
const EqWidget = memoWidget(EqEditor);

/** Where there is no MIDI to open, the latency test gets none. */
const noMidi: OpenMidiInput = () => Promise.resolve({ close: () => {} });
