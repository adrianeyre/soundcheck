import { useCallback, useState } from "react";

import { readLocal, writeLocal } from "../settings/local-settings";
import { defaultLayout, type GridPage, gridKey, parseLayout, serialiseLayout, type WidgetLayout } from "./layout";

export interface WidgetLayoutState {
  layout: WidgetLayout;
  setLayout: (layout: WidgetLayout) => void;
  reset: () => void;
}

/** A page's Grid layout, remembered in local storage so the page opens as it was left. */
export function useWidgetLayout(page: GridPage = "editor"): WidgetLayoutState {
  const [layout, setState] = useState(() => parseLayout(readLocal(gridKey(page)), page));
  const setLayout = useCallback(
    (next: WidgetLayout) => {
      setState(next);
      writeLocal(gridKey(page), serialiseLayout(next));
    },
    [page],
  );
  const reset = useCallback(() => setLayout(defaultLayout(page)), [setLayout, page]);
  return { layout, setLayout, reset };
}
