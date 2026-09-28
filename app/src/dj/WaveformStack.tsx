import { ZoomIn, ZoomOut } from "lucide-react";

import type { DjAnalysis } from "../audio/audio-output";
import { camelotName, formatBpm, formatTime, type HotCue, keyName, shiftKey } from "./dj-logic";
import type { DeckReport } from "./dj-report";
import { Zoom } from "./Waveform";

/** Seconds either side of the playhead the lanes can show. */
export const STACK_ZOOMS = [1, 2, 4, 8, 16, 32] as const;

export interface StackLane {
  deck: number;
  report: DeckReport;
  analysis: DjAnalysis | null;
  hotCues: readonly (HotCue | null)[];
  title: string | null;
  syncMaster: boolean;
}

export interface WaveformStackProps {
  lanes: readonly StackLane[];
  /** Seconds either side of the playhead. */
  span: number;
  onSpan: (span: number) => void;
}

/**
 * The waveforms of every Deck, one lane above the other across the top of
 * the page, as a club player's linked screen or DJ software shows them: each
 * a close-up of its three bands scrolling past a playhead fixed in the
 * middle, with its Beat Grid, so it is plain when two Decks' beats line up.
 * Beside each lane, the Deck's number in its colour, its BPM and its key.
 */
export function WaveformStack({ lanes, span, onSpan }: WaveformStackProps) {
  const zoom = STACK_ZOOMS.indexOf(span as (typeof STACK_ZOOMS)[number]);
  return (
    <section className="dj-stack dj-hw" aria-label="Waveforms">
      <div className="dj-stack-lanes">
        {lanes.map(({ deck, report, analysis, hotCues, title, syncMaster }) => {
          const key = analysis?.key ? shiftKey(analysis.key, report.keyShift) : null;
          return (
            <div key={deck} className="dj-stack-lane" data-deck={deck} data-playing={report.playing}>
              <div className="dj-stack-label">
                <span className="dj-deck-number">{deck + 1}</span>
                <div className="dj-stack-facts">
                  <span className="dj-stack-title">{title ?? "No track"}</span>
                  <span className="num">
                    {formatBpm(report.effectiveBpm)} <span className="dj-hw-caption">BPM</span>
                    {syncMaster && <span className="dj-badge" data-kind="master">MASTER</span>}
                    {report.sync && <span className="dj-badge" data-kind="sync">SYNC</span>}
                  </span>
                  <span className="num">
                    {key ? `${keyName(key)} · ${camelotName(key)}` : "—"}
                    {report.loaded && <span className="dj-stack-remain"> −{formatTime(report.duration - report.position)}</span>}
                  </span>
                </div>
              </div>
              {analysis && report.loaded ? (
                <Zoom
                  deck={deck}
                  analysis={analysis}
                  position={report.position}
                  span={span}
                  bpm={report.bpm}
                  firstBeat={report.firstBeat}
                  cue={report.cue}
                  hotCues={hotCues}
                  loop={report.loop}
                />
              ) : (
                <div className="dj-stack-empty">Deck {deck + 1} is empty</div>
              )}
            </div>
          );
        })}
      </div>
      <div className="dj-stack-zoom" role="group" aria-label="Waveform zoom">
        <button
          type="button"
          className="dj-hw-button"
          aria-label="Zoom the waveforms in"
          disabled={zoom <= 0}
          onClick={() => onSpan(STACK_ZOOMS[zoom - 1]!)}
        >
          <ZoomIn size={14} aria-hidden />
        </button>
        <span className="num dj-hw-caption" aria-label={`Showing ${span * 2} seconds`}>
          {span * 2}S
        </span>
        <button
          type="button"
          className="dj-hw-button"
          aria-label="Zoom the waveforms out"
          disabled={zoom >= STACK_ZOOMS.length - 1}
          onClick={() => onSpan(STACK_ZOOMS[zoom + 1]!)}
        >
          <ZoomOut size={14} aria-hidden />
        </button>
      </div>
    </section>
  );
}
