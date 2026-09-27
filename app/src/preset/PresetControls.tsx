import { Check, Library, Pencil, Save, Trash2 } from "lucide-react";
import { useState } from "react";

import { Dialog } from "../ui/Dialog";
import { presetsFor, targetName, type ListedPreset, type PresetSettings, type PresetTarget } from "./preset-library";
import { usePresetLibrary } from "./PresetLibraryProvider";

export interface PresetSelectProps {
  target: PresetTarget;
  /** The select's accessible name, such as "Synth 1 preset". */
  label: string;
  /** The Preset loaded last, shown as chosen while it is still listed. */
  value: string | null;
  /** The first, empty option. */
  placeholder: string;
  onPick: (preset: ListedPreset) => void;
}

/**
 * Every Preset for a Synth or an Effect, Factory and User together, each
 * group marked: the Synth's Factory Presets by category, then "User
 * presets". Picking one loads it; the User group only shows once there is one.
 */
export function PresetSelect({ target, label, value, placeholder, onPick }: PresetSelectProps) {
  const { userPresets } = usePresetLibrary();
  const listed = presetsFor(target, userPresets);
  const factory = listed.filter((preset) => preset.source === "factory");
  const user = listed.filter((preset) => preset.source === "user");
  const groups = [...new Set(factory.map((preset) => preset.category ?? "Factory presets"))];
  const chosen = listed.some((preset) => preset.name === value) ? (value as string) : "";

  return (
    <select
      aria-label={label}
      value={chosen}
      onChange={(event) => {
        const preset = listed.find((candidate) => candidate.name === event.target.value);
        if (preset) onPick(preset);
      }}
    >
      <option value="">{placeholder}</option>
      {groups.map((group) => (
        <optgroup key={group} label={group}>
          {options(factory.filter((preset) => (preset.category ?? "Factory presets") === group))}
        </optgroup>
      ))}
      {user.length > 0 && <optgroup label="User presets">{options(user)}</optgroup>}
    </select>
  );
}

function options(presets: ListedPreset[]) {
  return presets.map((preset) => (
    <option key={preset.name} value={preset.name} title={preset.description}>
      {preset.name}
    </option>
  ));
}

export interface PresetActionsProps {
  target: PresetTarget;
  /** Names the Synth or Effect to a screen reader, such as "Delay (slot 1)". */
  label: string;
  /** The settings "Save preset" keeps. */
  settings: PresetSettings;
}

/**
 * Save the Synth's or Effect's settings as a User Preset, and rename or
 * delete User Presets. Factory Presets are listed, marked, with nothing to
 * change them by. Hidden where there is no library.
 */
export function PresetActions({ target, label, settings }: PresetActionsProps) {
  const { available } = usePresetLibrary();
  const [open, setOpen] = useState<"save" | "manage" | null>(null);
  if (!available) return null;
  const close = () => setOpen(null);
  return (
    <>
      <button type="button" className="btn-sm" aria-label={`Save preset for ${label}`} onClick={() => setOpen("save")}>
        <Save size={14} aria-hidden />
        Save preset
      </button>
      <button type="button" className="btn-sm" aria-label={`Manage ${label} presets`} onClick={() => setOpen("manage")}>
        <Library size={14} aria-hidden />
        Presets
      </button>
      <Dialog
        open={open === "save"}
        onClose={close}
        title={`Save ${targetName(target)} preset`}
        closeLabel="Close without saving"
      >
        <SaveForm target={target} settings={settings} onSaved={close} />
      </Dialog>
      <Dialog
        open={open === "manage"}
        onClose={close}
        title={`${targetName(target)} presets`}
        closeLabel={`Close ${targetName(target)} presets`}
      >
        <PresetList target={target} />
      </Dialog>
    </>
  );
}

function SaveForm({
  target,
  settings,
  onSaved,
}: {
  target: PresetTarget;
  settings: PresetSettings;
  onSaved: () => void;
}) {
  const { save } = usePresetLibrary();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        save(target, name, settings).then(onSaved, (reason: Error) => setError(reason.message));
      }}
    >
      <p className="hint">
        A User Preset is kept in the app, not the Project, so every Project can load it.
      </p>
      <label className="field">
        Preset name
        <input value={name} onChange={(event) => setName(event.target.value)} required />
      </label>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit">
          <Save size={16} aria-hidden />
          Save
        </button>
      </div>
    </form>
  );
}

/** Every Preset for `target`, marked Factory or User; the User ones can be renamed and deleted. */
function PresetList({ target }: { target: PresetTarget }) {
  const { userPresets, rename, remove } = usePresetLibrary();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const failed = (reason: Error) => setError(reason.message);

  return (
    <div className="stack">
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <ul className="stack" aria-label={`${targetName(target)} presets`}>
        {presetsFor(target, userPresets).map((preset) => (
          <li key={preset.name} className="row">
            {renaming === preset.name ? (
              <form
                className="row"
                onSubmit={(event) => {
                  event.preventDefault();
                  rename(target, preset.name, newName).then(() => {
                    setRenaming(null);
                    setError(null);
                  }, failed);
                }}
              >
                <input
                  aria-label={`New name for ${preset.name}`}
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  required
                />
                <button type="submit" className="btn-sm">
                  <Check size={14} aria-hidden />
                  Rename
                </button>
                <button type="button" className="btn-sm" onClick={() => setRenaming(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <span>{preset.name}</span>
                <span className="hint">{preset.source === "factory" ? "Factory" : "User"}</span>
                {preset.source === "user" && (
                  <>
                    <button
                      type="button"
                      className="btn-sm"
                      aria-label={`Rename ${preset.name}`}
                      onClick={() => {
                        setRenaming(preset.name);
                        setNewName(preset.name);
                      }}
                    >
                      <Pencil size={14} aria-hidden />
                      Rename
                    </button>
                    <button
                      type="button"
                      className="btn-sm"
                      aria-label={`Delete ${preset.name}`}
                      onClick={() => remove(target, preset.name).then(() => setError(null), failed)}
                    >
                      <Trash2 size={14} aria-hidden />
                      Delete
                    </button>
                  </>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {userPresets.every((preset) => preset.target !== target) && (
        <p className="hint">No User Presets yet: save one from the {targetName(target)}’s settings.</p>
      )}
    </div>
  );
}
