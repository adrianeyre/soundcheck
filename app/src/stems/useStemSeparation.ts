import { useCallback, useEffect, useRef, useState } from "react";

import type { LoadedSample, LoadedSamples } from "../project/engine-sync";
import type { ProjectHistory } from "../project/history";
import type { AudioClip } from "../project/model";
import { clipFileName } from "../export/mix-exporter";
import { clipAudio } from "./clip-audio";
import { IMPORT_LABEL, importedFileName, placeImportedStems, placeStems, SEPARATE_LABEL } from "./place-stems";
import type { SeparationStage, SeparatorStatus, StemSeparator } from "./stem-separator";

/**
 * What is separated: an Audio Clip in the Project, whose Stems take its
 * place, or, for Import as Stems…, a whole audio file (WAV, FLAC or MP3)
 * that isn't in the Project, whose Stems go on new Tracks at the end of the
 * list from tick `start`, the playhead when it was chosen.
 */
export type StemSource =
  | { kind: "clip"; clip: AudioClip }
  | { kind: "file"; name: string; bytes: Uint8Array; duration: number; start: number };

/** What a source is called while it is separated, and after. */
const sourceName = (source: StemSource) =>
  source.kind === "clip" ? clipFileName(source.clip) : importedFileName(source);

export type StemSeparationStatus =
  | { state: "idle" }
  /**
   * The model isn't installed and wasn't found where the app looks first:
   * the musician is offered to install it from a file. `problem` is why a
   * model that was found there wasn't installed.
   */
  | { state: "offerInstall"; source: StemSource; problem?: string }
  /** Installing the model, from `from` where it was found without asking. */
  | { state: "installing"; from?: string }
  /**
   * Under way: what it's doing and how far it has got. `since` is when the
   * model started on the song's chunks (`Date.now()`) and how far it had got
   * then, which the time left is worked out from; null until then.
   */
  | {
      state: "separating";
      name: string;
      progress: number;
      stage: SeparationStage;
      since: { at: number; progress: number } | null;
    }
  | { state: "done"; name: string }
  | { state: "cancelled"; name: string }
  /** It failed, or its result was discarded: why. */
  | { state: "failed"; error: string };

export interface StemSeparationRun {
  /** Whether separation can run here, once asked; null until then. */
  separator: SeparatorStatus | null;
  /** Where the model is kept once installed, where the separator says. */
  modelKeptIn?: string;
  status: StemSeparationStatus;
  /** Whether one is under way: only one runs at a time. */
  busy: boolean;
  /** Separate `source` into its Stems, first offering to install the model if it isn't. */
  start: (source: StemSource) => Promise<void>;
  /** Install the model from a file the musician chooses, then separate what it was offered for. */
  install: () => Promise<void>;
  /** Stop: the Project stays as it was. Declines an offer to install, too. */
  cancel: () => void;
}

export interface UseStemSeparationOptions {
  separator: StemSeparator | null;
  history: ProjectHistory;
  /** The audio loaded now, which a Clip's file is read from and the Stems' paths are kept clear of. */
  samples: () => LoadedSamples;
  /** Put the Stems' audio with the rest, before the Clips naming it are added. */
  addSamples: (added: ReadonlyMap<string, LoadedSample>) => void;
}

/** Why an error is what it is, as a sentence. */
const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/**
 * One Stem Separation at a time, in the background while the musician keeps
 * editing, with its progress and a Cancel. When it finishes, its Stems take
 * the source Clip's place as one undo step (`placeStems`), or, if that Clip
 * has gone, are discarded with a message; an imported file's go on new Tracks
 * at the end of the list (`placeImportedStems`), also as one undo step. One still running when the page
 * goes is cancelled; so is one whose Project is closed, by `cancel`.
 */
export function useStemSeparation({ separator, history, samples, addSamples }: UseStemSeparationOptions): StemSeparationRun {
  const [status, setStatus] = useState<StemSeparationStatus>({ state: "idle" });
  const [separatorStatus, setSeparatorStatus] = useState<SeparatorStatus | null>(null);
  const abort = useRef<AbortController | null>(null);
  // Read when a separation ends, not when it began.
  const latest = useRef({ history, samples, addSamples });
  useEffect(() => {
    latest.current = { history, samples, addSamples };
  });

  useEffect(() => {
    if (!separator) return;
    let live = true;
    separator.status().then(
      (known) => live && setSeparatorStatus(known),
      (reason) => live && setSeparatorStatus({ kind: "unavailable", reason: message(reason) }),
    );
    return () => {
      live = false;
    };
  }, [separator]);

  useEffect(() => () => abort.current?.abort(), []);

  const separate = useCallback(
    async (source: StemSource, controller: AbortController) => {
      if (!separator) return;
      const name = sourceName(source);
      const { signal } = controller;
      setStatus({ state: "separating", name, progress: 0, stage: "reading", since: null });
      /** Change the separation under way, and nothing once it has ended. */
      const update = (change: (now: Extract<StemSeparationStatus, { state: "separating" }>) => StemSeparationStatus) =>
        setStatus((now) => (!signal.aborted && now.state === "separating" && now.name === name ? change(now) : now));
      try {
        const audio = source.kind === "clip" ? await clipAudio(source.clip, latest.current.samples()) : source.bytes;
        const stems = await separator.separate(audio, {
          onProgress: (progress) => update((now) => ({ ...now, progress })),
          onStage: (stage) =>
            update((now) => ({
              ...now,
              stage,
              since: stage === "separating" && !now.since ? { at: Date.now(), progress: now.progress } : now.since,
            })),
          signal,
        });
        if (!stems || signal.aborted) {
          setStatus({ state: "cancelled", name });
          return;
        }
        const { history: now, samples: loaded, addSamples: add } = latest.current;
        const placed =
          source.kind === "clip"
            ? placeStems(now.project, loaded(), source.clip, stems)
            : placeImportedStems(now.project, loaded(), source, stems, source.start);
        if (!placed.ok) {
          setStatus({ state: "failed", error: placed.error });
          return;
        }
        add(placed.samples);
        const result = now.execute(placed.commands, source.kind === "clip" ? SEPARATE_LABEL : IMPORT_LABEL);
        setStatus(
          result.ok
            ? { state: "done", name }
            : { state: "failed", error: `${name}'s Stems couldn't be added: ${result.error}` },
        );
      } catch (reason) {
        setStatus(
          signal.aborted ? { state: "cancelled", name } : { state: "failed", error: message(reason) },
        );
      } finally {
        if (abort.current === controller) abort.current = null;
      }
    },
    [separator],
  );

  const start = async (source: StemSource) => {
    if (!separator || abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    let known: SeparatorStatus;
    try {
      known = await separator.status();
    } catch (reason) {
      abort.current = null;
      setStatus({ state: "failed", error: message(reason) });
      return;
    }
    setSeparatorStatus(known);
    if (controller.signal.aborted) {
      if (abort.current === controller) abort.current = null;
      return;
    }
    if (known.kind === "unavailable") {
      abort.current = null;
      setStatus({ state: "failed", error: known.reason });
    } else if (known.kind === "notInstalled") {
      // Where the app looks first, `pnpm htdemucs:export`'s `model/` folder;
      // the musician is asked only if it isn't there, or isn't htdemucs.
      const found = await separator.findModel?.().catch(() => null);
      if (controller.signal.aborted) {
        if (abort.current === controller) abort.current = null;
        return;
      }
      let problem: string | undefined;
      if (found) {
        setStatus({ state: "installing", from: found.label });
        try {
          await separator.installModel(found);
          setSeparatorStatus({ kind: "installed" });
          if (controller.signal.aborted) {
            if (abort.current === controller) abort.current = null;
            setStatus({ state: "idle" });
            return;
          }
          await separate(source, controller);
          return;
        } catch (reason) {
          problem = `${found.label} wasn't installed: ${message(reason)}`;
        }
      }
      // Still one at a time: the offer holds the slot until it is taken or declined.
      setStatus({ state: "offerInstall", source, problem });
    } else {
      await separate(source, controller);
    }
  };

  const install = async () => {
    const controller = abort.current;
    if (!separator || status.state !== "offerInstall" || !controller) return;
    const { source } = status;
    const decline = () => {
      if (abort.current === controller) abort.current = null;
      setStatus({ state: "idle" });
    };
    const file = await separator.chooseModelFile().catch((reason: unknown) => {
      setStatus({ state: "failed", error: message(reason) });
      return undefined;
    });
    if (file === undefined) {
      if (abort.current === controller) abort.current = null;
      return;
    }
    if (!file || controller.signal.aborted) return decline();
    setStatus({ state: "installing" });
    try {
      await separator.installModel(file);
    } catch (reason) {
      if (abort.current === controller) abort.current = null;
      setStatus({ state: "failed", error: `The model wasn't installed: ${message(reason)}` });
      return;
    }
    setSeparatorStatus({ kind: "installed" });
    if (controller.signal.aborted) return decline();
    await separate(source, controller);
  };

  const cancel = () => {
    abort.current?.abort();
    if (status.state === "offerInstall") {
      abort.current = null;
      setStatus({ state: "idle" });
    } else if (status.state === "separating") {
      setStatus({ state: "cancelled", name: status.name });
    }
  };

  const busy = status.state === "offerInstall" || status.state === "installing" || status.state === "separating";
  return { separator: separatorStatus, modelKeptIn: separator?.modelKeptIn, status, busy, start, install, cancel };
}
