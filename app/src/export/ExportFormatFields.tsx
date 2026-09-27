import { useState } from "react";

import { readLocal, writeLocal, type LocalStore } from "../settings/local-settings";
import {
  BIT_DEPTHS,
  type BitDepth,
  type Encoding,
  type ExportKind,
  type ExportSampleRate,
  MP3_BITRATES,
  type Mp3Bitrate,
  SAMPLE_RATES,
} from "./mix-exporter";

/** Where the last format picked is kept, so the next export, of the mix or a Clip, starts on it. */
export const EXPORT_FORMAT_KEY = "soundcheck.export-format";

/** The file format an export is picked in: both kinds' settings, so switching kind keeps each. */
export interface ExportFormat {
  kind: ExportKind;
  bits: BitDepth;
  kbps: Mp3Bitrate;
  sampleRate: ExportSampleRate;
}

export const DEFAULT_EXPORT_FORMAT: ExportFormat = { kind: "wav", bits: 24, kbps: 320, sampleRate: 48_000 };

const BIT_DEPTH_LABELS: Record<BitDepth, string> = { 16: "16-bit", 24: "24-bit", 32: "32-bit float" };
export const KIND_LABELS: Record<ExportKind, string> = { wav: "WAV", mp3: "MP3" };

export function encodingOf({ kind, bits, kbps }: ExportFormat): Encoding {
  return kind === "wav" ? { kind, bits } : { kind, kbps };
}

/** `value` if it is one of those offered, or else `fallback`. */
function pick<T>(offered: readonly T[], value: unknown, fallback: T): T {
  return offered.includes(value as T) ? (value as T) : fallback;
}

/** The last format picked, or the default; anything saved that isn't offered any more falls back to it. */
export function readExportFormat(store?: LocalStore | null): ExportFormat {
  const saved = readLocal(EXPORT_FORMAT_KEY, store);
  if (!saved) return DEFAULT_EXPORT_FORMAT;
  try {
    const { kind, bits, kbps, sampleRate } = JSON.parse(saved) as Partial<Record<keyof ExportFormat, unknown>>;
    return {
      kind: pick<ExportKind>(["wav", "mp3"], kind, DEFAULT_EXPORT_FORMAT.kind),
      bits: pick(BIT_DEPTHS, bits, DEFAULT_EXPORT_FORMAT.bits),
      kbps: pick(MP3_BITRATES, kbps, DEFAULT_EXPORT_FORMAT.kbps),
      sampleRate: pick(SAMPLE_RATES, sampleRate, DEFAULT_EXPORT_FORMAT.sampleRate),
    };
  } catch {
    return DEFAULT_EXPORT_FORMAT;
  }
}

/** The format an export is picked in, starting on the last one picked and remembering each change. */
export function useExportFormat(): [ExportFormat, (format: ExportFormat) => void] {
  const [format, setState] = useState(readExportFormat);
  const setFormat = (next: ExportFormat) => {
    setState(next);
    writeLocal(EXPORT_FORMAT_KEY, JSON.stringify(next));
  };
  return [format, setFormat];
}

export interface ExportFormatFieldsProps {
  format: ExportFormat;
  onChange: (format: ExportFormat) => void;
  disabled: boolean;
}

/** The file's kind, then its bit depth or bitrate, and its sample rate. */
export function ExportFormatFields({ format, onChange, disabled }: ExportFormatFieldsProps) {
  const set = (change: Partial<ExportFormat>) => onChange({ ...format, ...change });
  return (
    <>
      <label className="field">
        Format
        <select value={format.kind} disabled={disabled} onChange={(event) => set({ kind: event.target.value as ExportKind })}>
          <option value="wav">WAV (lossless)</option>
          <option value="mp3">MP3 (compressed)</option>
        </select>
      </label>
      {format.kind === "wav" ? (
        <label className="field">
          Bit depth
          <select
            value={format.bits}
            disabled={disabled}
            onChange={(event) => set({ bits: Number(event.target.value) as BitDepth })}
          >
            {BIT_DEPTHS.map((depth) => (
              <option key={depth} value={depth}>
                {BIT_DEPTH_LABELS[depth]}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="field">
          Bitrate
          <select
            value={format.kbps}
            disabled={disabled}
            onChange={(event) => set({ kbps: Number(event.target.value) as Mp3Bitrate })}
          >
            {MP3_BITRATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate} kbps
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        Sample rate
        <select
          value={format.sampleRate}
          disabled={disabled}
          onChange={(event) => set({ sampleRate: Number(event.target.value) as ExportSampleRate })}
        >
          {SAMPLE_RATES.map((rate) => (
            <option key={rate} value={rate}>
              {rate / 1000} kHz
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
