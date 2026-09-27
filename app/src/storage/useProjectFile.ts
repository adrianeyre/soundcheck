import { useEffect, useRef, useState } from "react";

import { copyFor, rememberCopy, yourName } from "../collab/identity";
import { FolderSync, openFolder, type ReadSoFar, shareFolder } from "../collab/shared-folder";
import type { LoadedSamples } from "../project/engine-sync";
import { ProjectHistory } from "../project/history";
import { createProject, type Project } from "../project/model";
import type { FileStorage, ProjectFolder } from "./file-storage";
import { nameAudioByContent, saveProject } from "./project-folder";

export interface ProjectFileOptions {
  /** Null where this platform can't read Project folders. */
  storage: FileStorage | null;
  history: ProjectHistory;
  /**
   * The WAVs loaded onto pads, so saving can write the ones the folder
   * hasn't got into its `audio/`.
   */
  samples?: LoadedSamples;
  /**
   * A new Project, from New or Open, to play and edit from now on, with the
   * samples its pads play: read back out of the folder by Open, and none at
   * all by New.
   */
  onProject: (history: ProjectHistory, samples: LoadedSamples) => void;
  /**
   * Audio a Collaborator's Changes name, read from a Shared Project's
   * folder once it has arrived there, to add to what the Project has loaded.
   */
  onAudio?: (samples: LoadedSamples) => void;
  /**
   * Something else is changing the Project — a Request being carried out —
   * so it can't be replaced out from under it.
   */
  disabled?: boolean;
  /**
   * The Project as it is to be written, when more of it lives outside the
   * history: each VST3 Plugin's state, which its instance holds (ADR 0008).
   * The history's own Project is what counts as saved.
   */
  beforeSave?: (project: Project) => Promise<Project>;
  /** Asks before unsaved changes are lost; the browser's own dialog by default. */
  confirmDiscard?: (message: string) => boolean;
}

/** New, Open, Save and Save As, for the File menu, and what they have left behind. */
export interface ProjectFile {
  /** Where the Project was last saved or opened from; null until it has been. */
  folder: ProjectFolder | null;
  /**
   * The Project isn't the one last written to its folder. Never, in a
   * Shared Project: every change is written as it is made.
   */
  dirty: boolean;
  /** The folder is a Shared Project's (ADR 0007), kept in step with Collaborators' Changes. */
  shared: boolean;
  /** Why the shared folder can't be written or read just now; it is tried again until it can. */
  syncTrouble: string | null;
  /** Opening or saving is under way. */
  busy: boolean;
  /** New and Open would replace the Project, which can't happen now. */
  replaceBlocked: boolean;
  /** What went wrong last, until the next command or `dismiss`. */
  error: string | null;
  /** Audio the Project uses that its folder hadn't got. */
  missingAudio: string[];
  newProject: () => void;
  open: () => void;
  /** Save where the Project already lives, or ask where for its first save. */
  save: () => void;
  saveAs: () => void;
  /**
   * Make the Project a Shared Project, in its folder or, before its first
   * save, one the musician picks: put the folder somewhere Collaborators
   * share, such as a synced or network folder, and they open it there.
   */
  share: () => void;
  /**
   * Edit `history` from now on: a Live Session's Project, taken on joining
   * it. It is saved nowhere yet, so it counts as unsaved.
   */
  adopt: (history: ProjectHistory) => void;
  dismiss: () => void;
  /**
   * Asks before something else would lose unsaved changes, such as an
   * update restarting the app; true to go on.
   */
  mayDiscard: () => boolean;
}

const UNSAVED = "This Project has changes that haven't been saved. Lose them?";
export const NO_STORAGE = "This browser can't open or save Project folders; Chrome, Edge and the Desktop App can.";

/** A Project name the filesystem will take, as a folder name. */
export function folderNameFor(projectName: string): string {
  // The characters Windows refuses, which covers the other platforms too.
  return projectName.replace(/[\\/:*?"<>|]/g, " ").trim() || "Untitled";
}

/** A Shared Project's folder as it was opened or shared: how far each file was read, and this copy's last Change there. */
interface Shared {
  read: ReadSoFar;
  written: number;
}

/**
 * The Project's file: New, Open, Save and Save As, the warning before
 * unsaved changes are lost, and Ctrl+S (⌘S) saving from anywhere. A Shared
 * Project's folder is followed while it is open: this person's Changes are
 * written there as they make them, and their Collaborators' taken in.
 *
 * A Project is never changed in place, so "unsaved changes" is simply the
 * Project not being the one last written to the folder.
 */
export function useProjectFile({
  storage,
  history,
  samples = new Map(),
  onProject,
  onAudio,
  confirmDiscard,
  beforeSave,
  disabled = false,
}: ProjectFileOptions): ProjectFile {
  const [folder, setFolder] = useState<ProjectFolder | null>(null);
  // Null for a Project never written anywhere by this copy.
  const [saved, setSaved] = useState<Project | null>(history.project);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingAudio, setMissingAudio] = useState<string[]>([]);
  const [shared, setShared] = useState<Shared | null>(null);
  const [syncTrouble, setSyncTrouble] = useState<string | null>(null);
  const project = history.project;
  const dirty = !shared && project !== saved;

  // What the folder's sync reads when it writes audio or brings more in.
  const latest = useRef({ samples, onAudio });
  useEffect(() => {
    latest.current = { samples, onAudio };
  });

  // A Shared Project's folder is followed for as long as it is the one open.
  useEffect(() => {
    if (!storage || !folder || !shared) return;
    nameAudioByContent(true);
    const sync = new FolderSync(storage, folder, history, {
      samples: () => latest.current.samples,
      onAudio: (added) => latest.current.onAudio?.(added),
      onTrouble: setSyncTrouble,
      ...shared,
    });
    sync.start();
    void sync.poll();
    return () => {
      void sync.stop();
      nameAudioByContent(false);
      setSyncTrouble(null);
    };
  }, [storage, folder, shared, history]);

  // The last warning, when the window itself is closing.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const mayDiscard = () => !dirty || (confirmDiscard ?? window.confirm.bind(window))(UNSAVED);

  const run = (action: () => Promise<void>) => {
    if (busy) return;
    if (!storage) {
      setError(NO_STORAGE);
      return;
    }
    setBusy(true);
    setError(null);
    action()
      .catch((reason: unknown) => setError(String(reason)))
      .finally(() => setBusy(false));
  };

  const take = (next: Project | null, its: ProjectFolder | null, missing: string[], sharing: Shared | null = null) => {
    setFolder(its);
    setSaved(next);
    setMissingAudio(missing);
    setShared(sharing);
  };

  const newProject = () => {
    if (busy || disabled || !mayDiscard()) return;
    const fresh = new ProjectHistory(createProject(), { by: yourName() });
    setError(null);
    take(fresh.project, null, []);
    onProject(fresh, new Map());
  };

  const open = () => {
    if (disabled) return;
    run(async () => {
      if (!storage || !mayDiscard()) return;
      const chosen = await storage.chooseFolderToOpen();
      if (!chosen) return;
      const result = await openFolder(storage, chosen, { copy: copyFor(chosen), by: yourName() });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const opened = result.history;
      if (result.shared) rememberCopy(chosen, opened.copy);
      const sharing = result.shared && { read: result.shared, written: opened.have[opened.copy] ?? 0 };
      take(opened.project, chosen, result.missingAudio, sharing);
      onProject(opened, result.samples);
    });
  };

  /** Save where the Project already lives, or somewhere the musician picks. */
  const saveTo = (to: ProjectFolder | null) =>
    run(async () => {
      if (!storage) return;
      if (to && shared) {
        // Every edit is in the folder already. A VST3 Plugin's state lives
        // in its instance, so saving is when it joins the Project.
        if (beforeSave) history.record(await beforeSave(history.project), "Save Plugin state");
        return;
      }
      const target = to ?? (await storage.chooseFolderToSave(folderNameFor(project.name)));
      if (!target) return;
      const written = beforeSave ? await beforeSave(project) : project;
      const result = await saveProject(storage, written, target, folder, samples);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Save As from a Shared Project leaves a Project of this person's own.
      take(project, target, result.missingAudio);
    });

  const share = () => {
    if (shared || disabled) return;
    run(async () => {
      if (!storage) return;
      const target = folder ?? (await storage.chooseFolderToSave(folderNameFor(project.name)));
      if (!target) return;
      if (beforeSave) history.record(await beforeSave(history.project), "Save Plugin state");
      const result = await shareFolder(storage, target, history, (base) =>
        saveProject(storage, base, target, folder, latest.current.samples),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      rememberCopy(target, history.copy);
      take(history.project, target, result.missingAudio, { read: new Map(), written: 0 });
    });
  };

  return {
    folder,
    dirty,
    shared: shared !== null,
    syncTrouble,
    busy,
    replaceBlocked: busy || disabled,
    error,
    missingAudio,
    newProject,
    open,
    save: () => saveTo(folder),
    saveAs: () => saveTo(null),
    share,
    adopt: (adopted) => {
      setError(null);
      take(null, null, []);
      onProject(adopted, new Map());
    },
    dismiss: () => {
      setError(null);
      setMissingAudio([]);
    },
    mayDiscard,
  };
}
