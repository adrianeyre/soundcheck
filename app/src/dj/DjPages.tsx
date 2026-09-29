import { useState } from "react";
import { createPortal } from "react-dom";

import type { PageGrid } from "./DjPage";
import { MixerPage } from "./DjPage";
import { type DjSessionProps, useDjSession } from "./dj-session";
import type { HeadphoneOutput } from "./headphone-output";
import { PadsPage } from "./PadsPage";

export type DjView = "mixing" | "pads";

export interface DjPagesProps extends DjSessionProps {
  /** The page showing: one of these two, or another page of the app's. */
  view: string;
  onStart?: () => void;
  starting?: boolean;
  headphones?: HeadphoneOutput | null;
  mixingGrid?: PageGrid;
  padsGrid?: PageGrid;
  /** Each page's panel id, for the app's menu to point at. */
  panelId: (view: DjView) => string;
}

/**
 * The two pages that share the DJ's session: the Mixer page and the Pads
 * page. Each is drawn once it is first opened and kept, and the session they
 * share starts with the first of them, so the Decks, the Sampler and a
 * recording carry on whichever page shows.
 */
export function DjPages(props: DjPagesProps) {
  const { view, panelId } = props;
  const [mixing, setMixing] = useState<HTMLElement | null>(null);
  const [pads, setPads] = useState<HTMLElement | null>(null);
  const [opened, setOpened] = useState({ mixing: view === "mixing", pads: view === "pads" });
  if ((view === "mixing" && !opened.mixing) || (view === "pads" && !opened.pads)) {
    setOpened({ mixing: opened.mixing || view === "mixing", pads: opened.pads || view === "pads" });
  }
  return (
    <>
      <div id={panelId("mixing")} className="page dj-page-wrap" hidden={view !== "mixing"} aria-labelledby="mixing-title">
        <h1 id="mixing-title" className="page-title">
          Mixer
        </h1>
        <div ref={setMixing} />
      </div>
      <div id={panelId("pads")} className="page dj-page-wrap" hidden={view !== "pads"} aria-labelledby="pads-title">
        <h1 id="pads-title" className="page-title">
          Pads
        </h1>
        <div ref={setPads} />
      </div>
      {(opened.mixing || opened.pads) && (
        <DjSessionPages {...props} mixingSlot={opened.mixing ? mixing : null} padsSlot={opened.pads ? pads : null} />
      )}
    </>
  );
}

function DjSessionPages(props: DjPagesProps & { mixingSlot: HTMLElement | null; padsSlot: HTMLElement | null }) {
  const { view, mixingSlot, padsSlot, onStart, starting, headphones, samples = null, library = null } = props;
  const session = useDjSession(props);
  const shared = { session, onStart, starting, headphones, samples, library };
  return (
    <>
      {mixingSlot && createPortal(<MixerPage {...shared} active={view === "mixing"} grid={props.mixingGrid} />, mixingSlot)}
      {padsSlot && createPortal(<PadsPage {...shared} active={view === "pads"} grid={props.padsGrid} />, padsSlot)}
    </>
  );
}
