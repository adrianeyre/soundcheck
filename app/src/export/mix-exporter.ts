/**
 * Exporting the mix, or one Audio Clip's own audio, as a WAV or MP3 file,
 * behind one interface so the desktop app and the browser dev host both fit
 * behind it (ADR 0002: the desktop comes first).
 *
 * Either way the Audio Engine renders the song offline on an Engine of its
 * own, built from the same commands that keep the playing engine in step
 * with the Project, so playback carries on while it exports. A Clip is
 * written raw: the stretch of its file it plays, past the mixer.
 */
import type { EngineCommand } from "../audio/audio-output";
import { EngineSync, type LoadedSamples } from "../project/engine-sync";
import { type AudioClip, clipEnd, type Project } from "../project/model";
import { tempoMapOf } from "../project/time";

export type BitDepth = 16 | 24 | 32;
export type ExportSampleRate = 44_100 | 48_000;
/** Constant bitrates, in kbps. Matches `MP3_BITRATES` in `engine/src/mp3_writer.rs`. */
export type Mp3Bitrate = 128 | 192 | 256 | 320;

export const BIT_DEPTHS: readonly BitDepth[] = [16, 24, 32];
export const SAMPLE_RATES: readonly ExportSampleRate[] = [44_100, 48_000];
export const MP3_BITRATES: readonly Mp3Bitrate[] = [128, 192, 256, 320];

/** What kind of file, and its format. Mirrors `Encoding` in `desktop/src/export.rs`. */
export type Encoding = { kind: "wav"; bits: BitDepth } | { kind: "mp3"; kbps: Mp3Bitrate };
export type ExportKind = Encoding["kind"];

/** The file extension, without its dot. */
export const EXTENSIONS: Record<ExportKind, string> = { wav: "wav", mp3: "mp3" };

/**
 * How long reverb and release tails may run past the range's end; the
 * render stops sooner once the sound has died away. Matches `TAIL_SECONDS`
 * in `desktop/src/export.rs`.
 */
export const TAIL_SECONDS = 10;

/** What to render. Mirrors `ExportRequest` in `desktop/src/export.rs`. */
export interface ExportRequest {
  /** The commands that build the Project into a fresh Engine. */
  commands: EngineCommand[];
  /** The range, in ticks: the whole song or the loop region. */
  startTick: number;
  endTick: number;
  sampleRate: ExportSampleRate;
  encoding: Encoding;
}

/**
 * One Audio Clip's own audio to export: the stretch of its file it plays,
 * with no fader, pan, Effects, Sends or Automation. Mirrors
 * `ClipExportRequest` in `desktop/src/export.rs`, beside the file.
 */
export interface ClipExportRequest {
  /** The bytes of the Clip's audio file. */
  audio: Uint8Array;
  /** Seconds into the file where the Clip starts playing. */
  fileOffset: number;
  /** Seconds of the file the Clip plays. */
  duration: number;
  sampleRate: ExportSampleRate;
  encoding: Encoding;
}

/** What is being exported, for the save dialog to say. */
export type ExportSubject = "mix" | "clip";

/** A file the musician has chosen to export to. */
export interface ExportTarget {
  /** What the musician is shown: its path, on the desktop. */
  readonly label: string;
}

/** A folder the musician has chosen to export several files into, such as an Audio Clip's Slices. */
export interface ExportFolder {
  /** What the musician is shown: its path, on the desktop. */
  readonly label: string;
}

export interface ExportOptions {
  /** How far the range has got, 0 to 1. */
  onProgress: (fraction: number) => void;
  /** Aborting cancels the export, and nothing is written. */
  signal: AbortSignal;
}

export interface MixExporter {
  /** Ask where to save a file of `kind`, or null if the musician cancels. The mix, unless `subject` says. */
  chooseFile: (suggestedName: string, kind: ExportKind, subject?: ExportSubject) => Promise<ExportTarget | null>;
  /** Render and write the file: true once written, false if cancelled. */
  exportMix: (target: ExportTarget, request: ExportRequest, options: ExportOptions) => Promise<boolean>;
  /** Write one Audio Clip's own audio: true once written, false if cancelled, when nothing is written. */
  exportClip: (target: ExportTarget, request: ClipExportRequest, options: ExportOptions) => Promise<boolean>;
  /** Ask for a folder to export several files into, or null if the musician cancels. */
  chooseFolder: () => Promise<ExportFolder | null>;
  /** The file called `name` of `kind` in `folder`, to export to; one already there is replaced. */
  fileIn: (folder: ExportFolder, name: string, kind: ExportKind) => Promise<ExportTarget>;
}

/** Where the song ends: the end of its last Clip, or 0 with none. */
export function songEndTick(project: Project): number {
  const map = tempoMapOf(project);
  let end = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) end = Math.max(end, Math.ceil(clipEnd(clip, map)));
  }
  return end;
}

/** The request that renders `project` from `startTick` to `endTick`. */
export function exportRequest(
  project: Project,
  samples: LoadedSamples,
  range: { startTick: number; endTick: number },
  format: { sampleRate: ExportSampleRate; encoding: Encoding },
): ExportRequest {
  return { commands: new EngineSync().update(project, samples), ...range, ...format };
}

/**
 * The request that exports `clip`'s own audio, or null while its file isn't
 * in memory. Only the Clip is read, never its Track, so nothing of the mix
 * can reach the file.
 */
export function clipExportRequest(
  clip: AudioClip,
  samples: LoadedSamples,
  format: { sampleRate: ExportSampleRate; encoding: Encoding },
): ClipExportRequest | null {
  const loaded = samples.get(clip.file);
  if (!loaded) return null;
  return { audio: Uint8Array.from(loaded.bytes), fileOffset: clip.fileOffset, duration: clip.duration, ...format };
}

/** What a Clip's file is suggested to be called: the name the Clip shows, its audio file's, without its extension. */
export function clipFileName(clip: AudioClip): string {
  const name = clip.file.split("/").at(-1) ?? clip.file;
  return name.replace(/\.[^.]+$/, "") || name;
}
