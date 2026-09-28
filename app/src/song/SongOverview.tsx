import { Map as MapIcon } from "lucide-react";

import { clipEnd, type Project, trackKind } from "../project/model";
import { barStart, barTicks, formatPosition, tempoMapOf } from "../project/time";

export interface SongOverviewProps {
  project: Project;
  /** The playhead, in ticks, or null when no audio is running. */
  position: number | null;
  /** Move the playhead: absent when there is no audio to move. */
  onSeek?: (tick: number) => void;
}

const ROW = 10;
const SECTIONS = 14;
const WIDTH = 1000;

/**
 * The whole song at a glance, as Logic's and Cubase's overviews draw it:
 * every Track as a thin lane with its Clips in its kind's colour, the
 * Sections above, and the playhead. Clicking it moves the playhead there.
 */
export function SongOverview({ project, position, onSeek }: SongOverviewProps) {
  const map = tempoMapOf(project);
  const ends = project.tracks.flatMap((track) => track.clips.map((clip) => clipEnd(clip, map)));
  const sectionEnd = Math.max(0, ...project.sections.map((section) => barStart(map, section.startBar + section.bars)));
  const bar = barTicks(project.timeSignature);
  // At least eight bars, and a bar past the last thing in the song.
  const end = Math.max(8 * bar, ...ends.map((tick) => tick + bar), sectionEnd);
  const x = (tick: number) => (tick / end) * WIDTH;
  const height = SECTIONS + Math.max(1, project.tracks.length) * ROW + 2;
  const bars = Math.ceil(end / bar);
  const every = bars > 64 ? 8 : bars > 32 ? 4 : bars > 16 ? 2 : 1;

  return (
    <section aria-label="Song Overview" className="panel">
      <div className="panel-head">
        <h2>
          <MapIcon size={18} aria-hidden />
          Song Overview
        </h2>
        <span className="hint num">
          {project.tracks.length} Tracks · {bars} bars
          {position !== null && ` · ${formatPosition(position, map)}`}
        </span>
      </div>
      <svg
        role="img"
        aria-label={`The song: ${project.tracks.length} Tracks over ${bars} bars${project.sections.length ? `, in ${project.sections.map((s) => s.name).join(", ")}` : ""}`}
        className="song-overview"
        viewBox={`0 0 ${WIDTH} ${height}`}
        preserveAspectRatio="none"
        style={{ height: Math.min(240, height * 2) }}
        onClick={
          onSeek &&
          ((event) => {
            const box = event.currentTarget.getBoundingClientRect();
            if (box.width > 0) onSeek(Math.max(0, Math.round((((event.clientX - box.left) / box.width) * end) / bar) * bar));
          })
        }
      >
        {Array.from({ length: bars }, (_, index) =>
          index % every === 0 ? (
            <line key={index} x1={x(index * bar)} x2={x(index * bar)} y1={0} y2={height} stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
          ) : null,
        )}
        {project.sections.map((section, index) => {
          const from = barStart(map, section.startBar);
          const to = barStart(map, section.startBar + section.bars);
          return (
            <g key={section.id}>
              <rect x={x(from)} y={1} width={Math.max(1, x(to) - x(from) - 1)} height={SECTIONS - 3} rx={2} fill="var(--primary-soft)" />
              <text x={x(from) + 3} y={SECTIONS - 5} fontSize={9} fill="var(--text)" data-index={index}>
                {section.name}
              </text>
            </g>
          );
        })}
        {project.tracks.map((track, row) =>
          track.clips.map((clip) => (
            <rect
              key={clip.id}
              x={x(clip.start)}
              y={SECTIONS + row * ROW + 1}
              width={Math.max(1, x(clipEnd(clip, map)) - x(clip.start))}
              height={ROW - 2}
              rx={1.5}
              fill={`var(--kind-${trackKind(track)})`}
              opacity={track.mixer.mute ? 0.35 : 0.9}
            />
          )),
        )}
        {position !== null && (
          <line x1={x(position)} x2={x(position)} y1={0} y2={height} stroke="var(--playhead)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
    </section>
  );
}
