import { useEffect, useState } from "react";

import { defaultLayout } from "../grid/layout";
import { WidgetGrid } from "../grid/WidgetGrid";
import { SessionBrowser, type SessionPageProps, StartAudio } from "./DjPage";
import { PadController } from "./PadController";

/**
 * The Pads page: the **Pad Controller** across the whole width, and a
 * **Track browser** under it to load its Sampler Slots and the Decks from.
 * It shares the Mixer page's session (`dj-session.ts`), so its pads play the
 * same Decks and the same Sampler, into the same mix and recording.
 */
export function PadsPage(props: SessionPageProps) {
  const { session, onStart, starting = false, samples = null, library = null, grid } = props;
  const [ownLayout, setOwnLayout] = useState(() => defaultLayout("pads"));
  // Nothing on this page steps aside.
  const onEmpty = grid?.onEmpty;
  useEffect(() => {
    onEmpty?.([]);
  }, [onEmpty]);
  return (
    <div className="dj-page">
      <div className="dj-toolbar row">
        <StartAudio session={session} onStart={onStart} starting={starting} />
        <p className="hint">
          The pads play the Mixer page&apos;s Decks and the Sampler. The Editor&apos;s song stops while this page is open.
        </p>
      </div>
      <WidgetGrid
        layout={grid?.layout ?? ownLayout}
        onLayout={grid?.onLayout ?? setOwnLayout}
        pinned={grid?.pinned}
        widgets={{
          padController: <PadController session={session} id="pads" timecode={props.timecode} />,
          padsBrowser: <SessionBrowser session={session} number={3} title="Track browser" samples={samples} library={library} />,
        }}
      />
    </div>
  );
}
