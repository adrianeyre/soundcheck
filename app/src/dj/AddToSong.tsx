import { Menu, type MenuItem } from "../ui/Menu";
import type { TakePlace, TakeTrack } from "../song/take-placement";

export interface AddToSongProps {
  /** Where the take goes: kept by the session, so the Mixer page's and the Pads page's buttons agree. */
  place: { place: TakePlace; track: TakeTrack };
  onPlace: (place: { place: TakePlace; track: TakeTrack }) => void;
  onAdd: () => void;
  disabled: boolean;
  /** The song's tempo to be set to the mix's, offered as the last take went in. */
  tempoOffer: { bpm: number } | null;
  onSetTempo: () => void;
}

const PLACES: { id: TakePlace; label: string; said: string }[] = [
  { id: "playhead", label: "At the playhead", said: "at the playhead" },
  { id: "bar", label: "At the start of the playhead's bar", said: "at the start of the playhead's bar" },
  { id: "start", label: "At the start of the song", said: "at the start of the song" },
];
const TRACKS: { id: TakeTrack; label: string; said: string }[] = [
  { id: "new", label: "On a new Audio Track", said: "on a new Audio Track" },
  { id: "selected", label: "On the selected Audio Track", said: "on the selected Audio Track" },
];

/**
 * ADD TO SONG, with where the take goes beside it: at the Editor's playhead
 * (the start of its bar, or the song's start), on a new Audio Track or the
 * selected one. Once a take is in, an offer to set the song's tempo to the
 * mix's, where they differed.
 */
export function AddToSong({ place, onPlace, onAdd, disabled, tempoOffer, onSetTempo }: AddToSongProps) {
  const where = PLACES.find((p) => p.id === place.place)!.said;
  const onWhat = TRACKS.find((t) => t.id === place.track)!.said;
  const items: MenuItem[] = [
    ...PLACES.map(
      (p): MenuItem => ({ kind: "choice", id: p.id, label: p.label, checked: place.place === p.id, onSelect: () => onPlace({ ...place, place: p.id }) }),
    ),
    { kind: "separator", id: "tracks" },
    ...TRACKS.map(
      (t): MenuItem => ({ kind: "choice", id: t.id, label: t.label, checked: place.track === t.id, onSelect: () => onPlace({ ...place, track: t.id }) }),
    ),
  ];
  return (
    <div className="dj-add-song" role="group" aria-label="Add to song">
      <button
        type="button"
        className="dj-hw-button"
        data-tone="green"
        aria-label={`Add the recording to the song, ${where}, ${onWhat}`}
        title={`Add it ${where}, ${onWhat}`}
        disabled={disabled}
        onClick={onAdd}
      >
        ADD TO SONG
      </button>
      <Menu label={<span aria-hidden>WHERE</span>} ariaLabel="Where Add to song puts the take" items={items} />
      {tempoOffer && (
        <button
          type="button"
          className="dj-hw-button"
          data-tone="amber"
          aria-label={`Set the song's tempo to ${tempoOffer.bpm} BPM, the mix's`}
          onClick={onSetTempo}
        >
          SONG TO {tempoOffer.bpm} BPM
        </button>
      )}
    </div>
  );
}
