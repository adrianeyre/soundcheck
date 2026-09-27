import { AudioWaveform, ChevronDown, ChevronUp, Drum, Piano, Plus, Scissors, Trash2, type LucideIcon } from "lucide-react";

import { isMissingInstrument } from "../instrument/instrument-table";
import { PresetPicker } from "../instrument/SynthPanel";
import type { ListedPreset } from "../preset/preset-library";
import { type AudioTrack, type InstrumentTrack, type Track, trackKind, type TrackKind } from "../project/model";
import { AUDIO_FILE_TYPES } from "./import-audio";

export interface TrackListProps {
  tracks: Track[];
  onRename: (trackId: string, name: string) => void;
  onMove: (trackId: string, index: number) => void;
  onDelete: (trackId: string) => void;
  onAddClip: (track: InstrumentTrack) => void;
  onPickPreset: (trackId: string, preset: ListedPreset) => void;
  /** Import a WAV, FLAC or MP3 onto an Audio Track as an Audio Clip. */
  onImportAudio: (track: AudioTrack, file: File) => void;
  /** Open an Audio Track's Clip in the Audio Editor; absent where there is none. */
  onEditAudio?: (track: AudioTrack) => void;
  /** The Audio Track whose Clip the Audio Editor has open. */
  editingTrackId?: string | null;
}

/** A press on the row itself, or on its label, rather than one of its controls. */
const onControl = (target: EventTarget) => target instanceof Element && target.closest("input, button, select, label, a") !== null;

/** The Tracks and what can be done to each. Their Clips are on the Timeline. */
export function TrackList(props: TrackListProps) {
  const { tracks } = props;
  if (tracks.length === 0) return <p className="hint">No Tracks yet. Choose a kind below to add one.</p>;

  return (
    <ol aria-label="Tracks" className="track-list">
      {tracks.map((track, index) => (
        <li
          key={track.id}
          className="track-row"
          data-kind={track.kind}
          data-track-kind={trackKind(track)}
          data-editing={(track.kind === "audio" && track.id === props.editingTrackId) || undefined}
          // Clicking an Audio Track opens its audio; the Edit audio button is the way there by keyboard.
          onClick={(event) => {
            if (track.kind === "audio" && track.clips.length > 0 && !onControl(event.target)) props.onEditAudio?.(track);
          }}
        >
          <input
            aria-label="Track name"
            className="track-name"
            // Re-keyed on the name, so undo and redo show through.
            key={track.name}
            defaultValue={track.name}
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (name && name !== track.name) props.onRename(track.id, name);
              else event.target.value = track.name;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span className="track-kind">{kindOf(track)}</span>
          <button
            type="button"
            className="btn-ghost btn-sm btn-icon"
            aria-label={`Move ${track.name} up`}
            title="Move up"
            disabled={index === 0}
            onClick={() => props.onMove(track.id, index - 1)}
          >
            <ChevronUp size={14} aria-hidden />
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm btn-icon"
            aria-label={`Move ${track.name} down`}
            title="Move down"
            disabled={index === tracks.length - 1}
            onClick={() => props.onMove(track.id, index + 1)}
          >
            <ChevronDown size={14} aria-hidden />
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm btn-icon"
            aria-label={`Delete ${track.name}`}
            title="Delete Track"
            onClick={() => props.onDelete(track.id)}
          >
            <Trash2 size={14} aria-hidden />
          </button>
          <div className="row" style={{ flexBasis: "100%" }}>
            {track.kind === "audio" && props.onEditAudio && (
              <button
                type="button"
                className="btn-sm"
                aria-pressed={track.id === props.editingTrackId}
                disabled={track.clips.length === 0}
                title={track.clips.length === 0 ? "Import or record audio onto this Track first" : `Cut ${track.name}'s audio in the Audio Editor`}
                onClick={() => props.onEditAudio?.(track)}
              >
                <Scissors size={16} aria-hidden />
                Edit audio
              </button>
            )}
            {track.kind === "audio" ? (
              <input
                type="file"
                accept={AUDIO_FILE_TYPES}
                aria-label={`Import audio onto ${track.name}`}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) props.onImportAudio(track, file);
                  // The same file can be imported again, as a second Clip.
                  event.target.value = "";
                }}
              />
            ) : (
              <button type="button" onClick={() => props.onAddClip(track)}>
                <Plus size={16} aria-hidden />
                Add Pattern Clip
              </button>
            )}
            {track.kind === "instrument" && track.instrument.type === "synth" && (
              <PresetPicker
                trackName={track.name}
                preset={track.instrument.preset}
                onPick={(preset) => props.onPickPreset(track.id, preset)}
              />
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function kindOf(track: Track): string {
  if (track.kind === "audio") return "Audio";
  if (track.instrument.type === "plugin") return isMissingInstrument(track.instrument) ? "Missing Plugin" : "Plugin";
  return track.instrument.type === "drumSampler" ? "Drums" : "Synth";
}

/** One way to add a Track: what kind it is, what it says, and the icon beside it. */
export interface AddTrackChoice {
  id: string;
  kind: TrackKind;
  label: string;
  onAdd: () => void;
}

const KIND_ICONS: Record<TrackKind, LucideIcon> = { instrument: Piano, drum: Drum, audio: AudioWaveform };

/**
 * The empty place at the end of the Track list, outlined where the next
 * Track goes and as big as one, where the musician picks the kind to add:
 * each choice with that kind's stripe and icon.
 */
export function AddTrack({ choices }: { choices: readonly AddTrackChoice[] }) {
  return (
    <div role="group" aria-labelledby="add-track-title" className="track-add">
      <p id="add-track-title" className="track-add-title">
        <Plus size={16} aria-hidden />
        Add a Track
      </p>
      <div className="track-add-choices">
        {choices.map((choice) => {
          const Icon = KIND_ICONS[choice.kind];
          return (
            <button
              key={choice.id}
              type="button"
              className="track-add-choice kind-stripe"
              data-track-kind={choice.kind}
              aria-label={`Add ${choice.label} Track`}
              onClick={choice.onAdd}
            >
              <Icon size={16} aria-hidden />
              {choice.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
