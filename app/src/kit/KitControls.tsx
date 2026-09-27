import { Library, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { LoadedSample, LoadedSamples } from "../project/engine-sync";
import type { DrumPad } from "../project/model";
import { Dialog } from "../ui/Dialog";
import { BUNDLED_KIT, type KitLibrary, type SavedKit } from "./kit-library";

export interface KitControlsProps {
  library: KitLibrary;
  trackName: string;
  /** The Kit the pads were loaded from last, shown as chosen while it is still listed. */
  kit: string | null;
  /** The pads "Save kit" keeps, and the Project's loaded audio their samples are in. */
  pads: readonly DrumPad[];
  samples: LoadedSamples;
  /** Put a Kit's pads on the Drum Sampler, with its samples read from the library. */
  onLoad: (kit: SavedKit, samples: ReadonlyMap<string, LoadedSample>) => void;
  /** While the Assistant has the Project, a Kit can't be loaded. */
  disabled?: boolean;
}

/**
 * Load the bundled Starter Kit or a saved Kit onto a Drum Sampler, save its
 * pads as a Kit, and delete saved Kits. Kits live in the app-level library,
 * so a Kit saved in one Project loads into any other (#51).
 */
export function KitControls({ library, trackName, kit, pads, samples, onLoad, disabled = false }: KitControlsProps) {
  const [kits, setKits] = useState<readonly SavedKit[]>(library.savedKits);
  const [open, setOpen] = useState<"save" | "manage" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read again when a Request finishes, as it may have saved a Kit.
  useEffect(() => {
    if (disabled) return;
    let current = true;
    library.load().then(
      (loaded) => current && setKits([...loaded]),
      // An unreadable library leaves only the bundled Kit.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [library, disabled]);

  const listed = [BUNDLED_KIT, ...kits];
  const chosen = listed.some((candidate) => candidate.name === kit) ? (kit as string) : "";
  const close = () => setOpen(null);
  const failed = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));

  const load = async (name: string) => {
    const picked = listed.find((candidate) => candidate.name === name);
    if (!picked) return;
    try {
      onLoad(picked, picked === BUNDLED_KIT ? new Map() : await library.samples(picked));
      setError(null);
    } catch (reason) {
      failed(reason);
    }
  };

  return (
    <>
      <select
        aria-label={`${trackName} kit`}
        value={chosen}
        disabled={disabled}
        onChange={(event) => void load(event.target.value)}
      >
        <option value="">Load a kit</option>
        <optgroup label="Bundled">
          <option value={BUNDLED_KIT.name}>{BUNDLED_KIT.name}</option>
        </optgroup>
        {kits.length > 0 && (
          <optgroup label="Saved kits">
            {kits.map((saved) => (
              <option key={saved.id} value={saved.name}>
                {saved.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <button type="button" className="btn-sm" aria-label={`Save kit of ${trackName}'s pads`} onClick={() => setOpen("save")}>
        <Save size={14} aria-hidden />
        Save kit
      </button>
      <button type="button" className="btn-sm" aria-label="Manage kits" onClick={() => setOpen("manage")}>
        <Library size={14} aria-hidden />
        Kits
      </button>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <Dialog open={open === "save"} onClose={close} title="Save kit" closeLabel="Close without saving">
        <SaveKitForm
          save={(name) => library.save(name, pads, samples)}
          onSaved={() => {
            setKits([...library.savedKits]);
            close();
          }}
        />
      </Dialog>
      <Dialog open={open === "manage"} onClose={close} title="Kits" closeLabel="Close kits">
        <KitList
          kits={kits}
          remove={(name) => library.delete(name).then(() => setKits([...library.savedKits]))}
        />
      </Dialog>
    </>
  );
}

function SaveKitForm({ save, onSaved }: { save: (name: string) => Promise<unknown>; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        save(name).then(onSaved, (reason: Error) => setError(reason.message));
      }}
    >
      <p className="hint">
        A Kit is kept in the app, not the Project, with a copy of every sample its pads play, so every Project can load
        it.
      </p>
      <label className="field">
        Kit name
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

/** The bundled Kit, marked, then every saved Kit, which can be deleted. */
function KitList({ kits, remove }: { kits: readonly SavedKit[]; remove: (name: string) => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="stack">
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <ul className="stack" aria-label="Kits">
        <li className="row">
          <span>{BUNDLED_KIT.name}</span>
          <span className="hint">Bundled</span>
        </li>
        {kits.map((kit) => (
          <li key={kit.id} className="row">
            <span>{kit.name}</span>
            <span className="hint">Saved</span>
            <button
              type="button"
              className="btn-sm"
              aria-label={`Delete ${kit.name}`}
              onClick={() => remove(kit.name).then(() => setError(null), (reason: Error) => setError(reason.message))}
            >
              <Trash2 size={14} aria-hidden />
              Delete
            </button>
          </li>
        ))}
      </ul>
      {kits.length === 0 && <p className="hint">No saved Kits yet: save one from a Drum Sampler’s pads.</p>}
    </div>
  );
}
