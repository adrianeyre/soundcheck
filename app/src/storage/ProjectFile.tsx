import { X } from "lucide-react";

import type { ProjectHistory } from "../project/history";
import type { ProjectFile } from "./useProjectFile";

export interface ProjectTitleProps {
  file: ProjectFile;
  history: ProjectHistory;
  /** In a Live Session, where every edit reaches the others as it is made. */
  live?: boolean;
}

/**
 * What the Project is called, edited where it is shown, and whether it is
 * saved. The name is part of the Project, so renaming undoes like any edit.
 */
export function ProjectTitle({ file, history, live = false }: ProjectTitleProps) {
  const { project } = history;
  const { folder, dirty, shared } = file;
  const state = live ? "Live" : !folder ? "Not saved yet" : shared ? "Shared" : dirty ? "Unsaved changes" : "Saved";

  return (
    <div className="project-title">
      <input
        className="project-name"
        aria-label="Project name"
        title={project.name}
        // Where `field-sizing` isn't supported, roughly the name's width.
        size={Math.max(8, project.name.length + 1)}
        // Re-keyed on the name, so undo, redo and opening show through.
        key={project.name}
        defaultValue={project.name}
        onBlur={(event) => {
          const name = event.target.value.trim();
          if (name && name !== project.name) history.execute({ type: "setProjectName", name });
          else event.target.value = project.name;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "Escape") {
            if (event.key === "Escape") event.currentTarget.value = project.name;
            event.currentTarget.blur();
          }
        }}
      />
      <span className="save-state" aria-live="polite" data-dirty={dirty} title={folder?.label}>
        {state}
        {folder && <span className="visually-hidden"> ({folder.label})</span>}
      </span>
    </div>
  );
}

/** What went wrong with the Project's file, until the musician dismisses it. */
export function ProjectFileAlerts({ file }: { file: ProjectFile }) {
  const { error, missingAudio, syncTrouble, dismiss } = file;
  if (!error && missingAudio.length === 0 && !syncTrouble) return null;
  return (
    <div className="file-alerts">
      {syncTrouble && (
        <p role="alert" className="alert">
          <span>The shared folder can't be reached, so your Changes wait here and are tried again: {syncTrouble}</span>
        </p>
      )}
      {error && (
        <p role="alert" className="alert">
          <span>{error}</span>
          <DismissButton onClick={dismiss} />
        </p>
      )}
      {missingAudio.length > 0 && (
        <p role="alert" className="alert">
          <span>Audio missing from the Project folder: {missingAudio.join(", ")}</span>
          <DismissButton onClick={dismiss} />
        </p>
      )}
    </div>
  );
}

export function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn-ghost btn-icon" aria-label="Dismiss" onClick={onClick}>
      <X size={16} aria-hidden />
    </button>
  );
}
