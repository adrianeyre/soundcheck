import { type MusicalKey, PITCH_CLASSES, SCALES } from "./theory";

/**
 * The song's key as the Keyboard, Chords and Note Tools share it: a root and
 * a scale, picked from two lists.
 */
export function KeySelect({
  value,
  onChange,
  label = "Key",
}: {
  value: MusicalKey;
  onChange: (key: MusicalKey) => void;
  label?: string;
}) {
  return (
    <span className="field-inline" role="group" aria-label={label}>
      {label}
      <select
        aria-label={`${label} root`}
        value={value.root}
        onChange={(event) => onChange({ ...value, root: Number(event.target.value) })}
      >
        {PITCH_CLASSES.map((name, index) => (
          <option key={name} value={index}>
            {name}
          </option>
        ))}
      </select>
      <select
        aria-label={`${label} scale`}
        value={value.scale}
        onChange={(event) => onChange({ ...value, scale: event.target.value })}
      >
        {SCALES.map((scale) => (
          <option key={scale.id} value={scale.id}>
            {scale.name}
          </option>
        ))}
      </select>
    </span>
  );
}
