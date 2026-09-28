import { Activity } from "lucide-react";
import { useState } from "react";

import type { Meters } from "../audio/audio-output";
import type { Project } from "../project/model";
import { CLIP_GAIN, FLOOR_DB, formatDb, gainToDb, levelFraction } from "./level";

/** How many readings the history holds: at the page's polling rate, about the last 10 seconds. */
export const HISTORY = 200;
/** How long a peak is held before it falls, in readings. */
const HOLD = 30;
/** How far a held peak falls each reading after that, in dB. */
const FALL_DB = 0.6;

export interface PeakHold {
  db: number;
  age: number;
}

/**
 * The peak a meter holds after `reading`: a louder one takes over at once,
 * a held one stays for `HOLD` readings and then falls.
 */
export function holdPeak(held: PeakHold, readingDb: number): PeakHold {
  if (readingDb >= held.db) return { db: readingDb, age: 0 };
  if (held.age < HOLD) return { db: held.db, age: held.age + 1 };
  return { db: Math.max(readingDb, held.db - FALL_DB), age: held.age + 1 };
}

const SCALE_DB = [0, -3, -6, -12, -18, -24, -36, -48, -60];

export interface MeterBridgeProps {
  project: Project;
  /** The engine's own peak levels, or null when no audio is running. */
  meters: Meters | null;
}

/**
 * A meter bridge, as a mixing desk's: the Master's level large, on a dB
 * scale, with its peak held and a count of the times it reached full scale,
 * its level over the last seconds as a graph, and a small meter for every
 * Track and Bus, so what is playing is seen at a glance. It only shows what
 * the engine measured.
 */
export function MeterBridge({ project, meters }: MeterBridgeProps) {
  const [history, setHistory] = useState<number[]>([]);
  const [peak, setPeak] = useState<PeakHold>({ db: -Infinity, age: 0 });
  const [clips, setClips] = useState(0);
  // Each new reading from the engine is added as it arrives: state kept from the props, updated while rendering.
  const [seen, setSeen] = useState<Meters | null>(null);
  if (meters && meters !== seen) {
    setSeen(meters);
    setHistory((readings) => [...readings.slice(-(HISTORY - 1)), meters.master]);
    setPeak((held) => holdPeak(held, gainToDb(meters.master)));
    if (meters.master >= CLIP_GAIN) setClips((count) => count + 1);
  }

  const level = meters?.master ?? 0;
  const channels = [
    ...project.tracks.map((track, index) => ({ id: track.id, name: track.name, level: meters?.tracks[index] ?? 0, bus: false })),
    ...project.buses.map((bus, index) => ({ id: bus.id, name: bus.name, level: meters?.buses?.[index] ?? 0, bus: true })),
  ];
  const peakFraction = Number.isFinite(peak.db) ? levelFraction(10 ** (peak.db / 20)) : 0;

  return (
    <section aria-label="Meters" className="panel">
      <div className="panel-head">
        <h2>
          <Activity size={18} aria-hidden />
          Meters
        </h2>
        <div className="row">
          <span className="hint num" aria-label="Master peak held">
            Peak {Number.isFinite(peak.db) && peak.db > FLOOR_DB ? `${peak.db > 0 ? "+" : ""}${peak.db.toFixed(1)} dB` : "-∞ dB"}
          </span>
          <button
            type="button"
            className="btn-sm"
            data-clipping={clips > 0}
            aria-label={clips > 0 ? `Clipped ${clips} times: reset` : "No clipping"}
            onClick={() => {
              setClips(0);
              setPeak({ db: -Infinity, age: 0 });
            }}
          >
            {clips > 0 ? `Clip ×${clips}` : "No clips"}
          </button>
        </div>
      </div>
      {!meters && <p className="hint">Start audio to see the levels.</p>}
      <div className="meter-bridge">
        <div className="meter-scale" aria-hidden>
          {SCALE_DB.map((db) => (
            <span key={db} style={{ bottom: `${((db - FLOOR_DB) / -FLOOR_DB) * 100}%` }}>
              {db}
            </span>
          ))}
        </div>
        <div
          role="meter"
          aria-label="Master level, large meter"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={Number(levelFraction(level).toFixed(3))}
          aria-valuetext={level >= CLIP_GAIN ? `${formatDb(level)}, clipping` : formatDb(level)}
          className="meter meter-master"
          data-clipping={level >= CLIP_GAIN}
        >
          <div aria-hidden className="meter-fill meter-gradient" style={{ bottom: 0, width: "100%", height: `${levelFraction(level) * 100}%` }} />
          {peakFraction > 0 && <div aria-hidden className="meter-peak" style={{ bottom: `${peakFraction * 100}%` }} />}
        </div>
        <LevelHistory readings={history} />
        <div className="channel-meters" role="group" aria-label="Channel levels">
          {channels.map((channel) => (
            <div key={channel.id} className="channel-meter" data-bus={channel.bus}>
              <div
                role="meter"
                aria-label={`${channel.name} activity`}
                aria-valuemin={0}
                aria-valuemax={1}
                aria-valuenow={Number(levelFraction(channel.level).toFixed(3))}
                aria-valuetext={formatDb(channel.level)}
                className="meter"
                data-clipping={channel.level >= CLIP_GAIN}
              >
                <div
                  aria-hidden
                  className="meter-fill meter-gradient"
                  style={{ bottom: 0, width: "100%", height: `${levelFraction(channel.level) * 100}%` }}
                />
              </div>
              <span className="channel-meter-name" title={channel.name}>
                {channel.name}
              </span>
            </div>
          ))}
          {channels.length === 0 && <p className="hint">No Tracks yet.</p>}
        </div>
      </div>
    </section>
  );
}

/** The Master's level over the last readings, newest on the right, on the meters' dB scale. */
function LevelHistory({ readings }: { readings: readonly number[] }) {
  const width = 400;
  const height = 120;
  const x = (index: number) => ((index + HISTORY - readings.length) / (HISTORY - 1)) * width;
  const y = (gain: number) => height - levelFraction(gain) * height;
  const line = readings.map((gain, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(gain).toFixed(1)}`).join(" ");
  const area = readings.length > 1 ? `${line} L${x(readings.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z` : "";
  return (
    <svg role="img" aria-label="Master level over the last seconds" className="level-history" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {SCALE_DB.map((db) => (
        <line key={db} x1={0} x2={width} y1={height - ((db - FLOOR_DB) / -FLOOR_DB) * height} y2={height - ((db - FLOOR_DB) / -FLOOR_DB) * height} stroke="var(--lane-line)" />
      ))}
      {area && <path d={area} fill="var(--meter-low)" opacity={0.25} />}
      {line && <path d={line} fill="none" stroke="var(--meter-low)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
