/**
 * Where the app is running, and the implementations of the platform
 * interfaces that go with it: the Desktop App (Tauri) or the Browser Version,
 * which `pnpm dev` serves too (ADR 0006). Where the browser has none, its part
 * is null, and `settings/desktop-only.ts` lists it as the Desktop App's.
 */
import init, { plugin_manifest } from "@engine";
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { browserKeyStore, desktopKeyStore, memoryKeyStore, type KeyStore } from "./assistant/key-store";
import { desktopAudioAnalyser, wasmAudioAnalyser, type AnalyseAudio } from "./audio/audio-analyser";
import type { AudioInputs } from "./audio/audio-input";
import { desktopAudioInputs } from "./audio/desktop-audio-input";
import type { OpenAudioOutput } from "./audio/audio-output";
import { desktopAudioHosts, desktopAudioOutput } from "./audio/desktop-audio-output";
import { openWorkletAudioOutput } from "./audio/worklet-audio-output";
import { browserMixExporter } from "./export/browser-mix-exporter";
import { desktopMixExporter } from "./export/desktop-mix-exporter";
import type { MixExporter } from "./export/mix-exporter";
import { browserRecordingSaver, desktopRecordingSaver, type DjRecordingSaver } from "./dj/recording-saver";
import { browserHeadphoneOutput, desktopHeadphoneOutput, type HeadphoneOutput } from "./dj/headphone-output";
import { desktopMidiInput } from "./midi/desktop-midi-input";
import { openWebMidiInput, type OpenMidiInput } from "./midi/midi-input";
import { browserLibraryStorage } from "./preset/browser-library-storage";
import { desktopLibraryStorage } from "./preset/desktop-library-storage";
import { memoryLibraryStorage, type LibraryStorage } from "./preset/library-storage";
import { desktopPluginFolder, libraryPluginFolder, type PluginFolder } from "./plugin/plugin-folder";
import { desktopVst3, type Vst3Host } from "./plugin/vst3";
import { browserReferencePlayer } from "./reference/browser-reference-player";
import { desktopReferencePlayer } from "./reference/desktop-reference-player";
import type { ReferencePlayer } from "./reference/reference-player";
import { browserSampleSource } from "./samples/browser-sample-source";
import { desktopSampleSource } from "./samples/desktop-sample-source";
import type { SampleSource } from "./samples/sample-source";
import { browserCapabilities, browserStemSeparator, fetchServedModel, startStemWorker } from "./stems/browser-stem-separator";
import { desktopStemSeparator } from "./stems/desktop-stem-separator";
import { browserModelStore } from "./stems/stem-model-store";
import { unavailableStemSeparator, type StemSeparator } from "./stems/stem-separator";
import { browserFileStorage } from "./storage/browser-file-storage";
import { desktopFileStorage } from "./storage/desktop-file-storage";
import type { FileStorage } from "./storage/file-storage";
import { desktopUpdater } from "./update/desktop-updater";
import type { Updater } from "./update/updater";

export interface Platform {
  name: "desktop" | "browser";
  openOutput: OpenAudioOutput;
  openMidi: OpenMidiInput;
  /** The audio inputs to record from, or null where there are none (the browser dev host). */
  audioInputs: AudioInputs | null;
  /** Buffer sizes to offer, where the platform lets you choose (desktop). */
  bufferSizes: readonly number[] | null;
  /** The audio hosts to choose from, where there is a choice (desktop). */
  listAudioHosts: (() => Promise<string[]>) | null;
  /** Where Project folders are read and written, or null where they can't be. */
  storage: FileStorage | null;
  /**
   * The app-level library, outside any Project, where User Presets and the
   * sample browser's folders are kept.
   */
  library: LibraryStorage;
  /** The app-level Plugins folder, where WASM Plugins are installed for every Project. */
  plugins: PluginFolder;
  /**
   * Scans for, loads and runs VST3 Plugins, each in a helper process of its
   * own (ADR 0008), or null where none can run: the browser, and macOS,
   * whose helper isn't built yet.
   */
  vst3: Vst3Host | null;
  /**
   * Why the Desktop App has no VST3 host on this machine, or null where it
   * has one, or where this is the Browser Version, whose Settings say what
   * only the Desktop App has.
   */
  vst3Unavailable: string | null;
  /** The sample browser's folders on this machine, or null where it can't reach any. */
  samples: SampleSource | null;
  /** Exports the mix as a WAV file. */
  exporter: MixExporter;
  /** Saves a recording of the Mixer page's DJ mix (ADR 0013). */
  djRecordings: DjRecordingSaver;
  /**
   * Plays the Mixer page's headphone cue out of a second output device
   * (ADR 0013), or null where it can't: a browser without `setSinkId`.
   */
  headphones: HeadphoneOutput | null;
  /** Chooses and auditions the Reference Track, past the mixer. */
  reference: ReferencePlayer;
  /** Where the Assistant's Claude API key is kept on this machine. */
  keyStore: KeyStore;
  /** How the Assistant listens: renders the Project offline and measures it. */
  analyseAudio: AnalyseAudio;
  /** How the Assistant's requests to Claude, or the musician's gateway, go out. */
  fetch: typeof fetch;
  /** Separates audio into its Stems, from a model the musician installs; where it can't, says so. */
  stems: StemSeparator;
  /**
   * Finds and installs a newer version of the installed app, or null where
   * there is nothing to install (the browser, whose every visit loads the
   * latest deploy).
   */
  updater: Updater | null;
  /**
   * The address an invite to a Live Session opens: the Browser Version, so
   * whoever gets one needn't have Soundcheck installed. Its own address in
   * the browser; the deployed Browser Version's on the desktop.
   */
  inviteSite: string;
}

/** Why a browser without Web Workers has no Stem Separation: it would stop the page for minutes. */
export const NO_STEMS_IN_BROWSER =
  "Stem Separation needs Web Workers, which this browser doesn't have, to run its model off the page. The Desktop App can separate Stems.";

/** Why the Desktop App on macOS has no VST3 Plugins: ADR 0008's macOS slice isn't built. */
export const NO_VST3_ON_MACOS = "VST3 Plugins aren't supported on macOS yet";

/**
 * Whether the webview is macOS's WKWebView, as its user agent says
 * ("Macintosh; Intel Mac OS X", on Apple silicon too). Windows' WebView2 and
 * Linux's WebKitGTK say "Windows NT" and "X11; Linux".
 */
export function isMacOs(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /\bMacintosh\b|\bMac OS X\b/.test(userAgent);
}

/** Powers of two, from what a good ASIO driver manages up to Windows' shared-mode period and beyond. */
export const DESKTOP_BUFFER_SIZES = [64, 128, 256, 512, 1024] as const;

/** Tauri puts this on the window of every page it serves. */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function currentPlatform(): Platform {
  if (isDesktop()) {
    const mac = isMacOs();
    return {
      name: "desktop",
      openOutput: desktopAudioOutput(invoke),
      openMidi: desktopMidiInput(invoke),
      audioInputs: desktopAudioInputs(invoke),
      bufferSizes: DESKTOP_BUFFER_SIZES,
      listAudioHosts: desktopAudioHosts(invoke),
      storage: desktopFileStorage(invoke),
      // A folder in the app-data folder.
      library: desktopLibraryStorage(invoke),
      // Another folder there, which the shell checks each Plugin into by
      // compiling it in wasmtime.
      plugins: desktopPluginFolder(invoke),
      // `soundcheck-vst3-host`, the helper beside the app. On macOS its
      // shared memory and windows aren't built yet (ADR 0008's slice 6), so
      // there is no helper to run, and the UI says why.
      vst3: mac ? null : desktopVst3(invoke),
      vst3Unavailable: mac ? NO_VST3_ON_MACOS : null,
      samples: desktopSampleSource(invoke),
      exporter: desktopMixExporter(invoke),
      // The system's save dialog; the shell writes the file.
      djRecordings: desktopRecordingSaver(invoke),
      // A second cpal stream in the shell, fed from the engine through a lock-free ring.
      headphones: desktopHeadphoneOutput(invoke),
      // The system's file dialog, and the native host's audition.
      reference: desktopReferencePlayer(invoke),
      keyStore: desktopKeyStore(invoke),
      analyseAudio: desktopAudioAnalyser(invoke),
      // Through Rust with Tauri's HTTP plugin, so CORS doesn't apply and a
      // gateway needn't allow the webview's origin.
      fetch: tauriFetch,
      // htdemucs on ONNX Runtime in the shell, on the CPU (ADR 0005), from
      // a model installed into the app-data folder.
      stems: desktopStemSeparator(invoke),
      // Tauri's updater in the shell, from the latest GitHub Release
      // (ADR 0011).
      updater: desktopUpdater(invoke),
      // The webview's own address is the app's, which no one else can open.
      inviteSite: import.meta.env.VITE_SITE_URL ? `${import.meta.env.VITE_SITE_URL.replace(/\/$/, "")}/` : "",
    };
  }
  // IndexedDB, which every Chromium and Firefox has; held in memory for
  // the session where there is none.
  const library = typeof indexedDB === "undefined" ? memoryLibraryStorage() : browserLibraryStorage(indexedDB);
  return {
    name: "browser",
    openOutput: openWorkletAudioOutput,
    openMidi: openWebMidiInput,
    // Recording is desktop-first (ADR 0002); getUserMedia into the worklet
    // would be the browser's version, and it isn't built yet.
    audioInputs: null,
    bufferSizes: null,
    listAudioHosts: null,
    // Chromium only; elsewhere the dev host can't open a Project folder.
    storage: browserFileStorage(),
    library,
    // Kept in the library, and checked with the browser's own WebAssembly
    // and the engine's manifest check.
    plugins: libraryPluginFolder(library, async (json) => {
      await init();
      return plugin_manifest(json);
    }),
    // The directory picker, its handles kept in IndexedDB, where there is
    // one (Chromium); a folder input for the session elsewhere. Auditions in
    // a Web Audio context beside the worklet's, so past the mixer.
    samples: browserSampleSource(),
    // Renders with the WASM engine on the main thread; saves through the
    // File System Access API where there is one, and downloads elsewhere.
    exporter: browserMixExporter(),
    // As an export saves: the save dialog where there is one, a download elsewhere.
    djRecordings: browserRecordingSaver(),
    // The worklet's cue channels to an audio element sent to the device with setSinkId (Chromium).
    headphones: browserHeadphoneOutput(),
    // A file input, and Web Audio in a context beside the worklet's.
    reference: browserReferencePlayer(),
    // Local storage is not a credential store, but a web page has nothing
    // better; Settings says so in the Browser Version (ADR 0006).
    keyStore: typeof localStorage === "undefined" ? memoryKeyStore() : browserKeyStore(localStorage),
    // A WASM Engine of its own on the main thread, which is cheap here.
    analyseAudio: wasmAudioAnalyser(),
    // The browser's own, so a gateway must allow CORS from the dev host.
    fetch: globalThis.fetch,
    // htdemucs on ONNX Runtime Web in a worker, on WebGPU where there is
    // one; the model the musician installs is kept in the Origin Private
    // File System, or IndexedDB (ADR 0005, ADR 0006).
    stems:
      typeof Worker === "undefined"
        ? unavailableStemSeparator(NO_STEMS_IN_BROWSER)
        : browserStemSeparator({
            store: browserModelStore(),
            startWorker: startStemWorker,
            capabilities: browserCapabilities,
            persist: () => navigator.storage?.persist?.() ?? Promise.resolve(false),
            fetchModel: () => fetchServedModel(),
          }),
    // Nothing to install: GitHub Pages serves the latest deploy (ADR 0006),
    // so it isn't one of the Desktop App's features either.
    updater: null,
    inviteSite: typeof location === "undefined" ? "" : `${location.origin}${location.pathname}`,
    // A web page can't run a native Plugin: a Project keeps its VST3
    // Plugins exactly, and each is missing (ADR 0008). Settings says so
    // among what only the Desktop App has.
    vst3: null,
    vst3Unavailable: null,
  };
}
