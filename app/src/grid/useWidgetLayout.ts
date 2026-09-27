import { useCallback, useState } from "react";

import { readLocal, writeLocal } from "../settings/local-settings";
import { defaultLayout, GRID_KEY, parseLayout, serialiseLayout, type WidgetLayout } from "./layout";

export interface WidgetLayoutState {
  layout: WidgetLayout;
  setLayout: (layout: WidgetLayout) => void;
  reset: () => void;
}

/** The Grid's layout, remembered in local storage so the Editor opens as it was left. */
export function useWidgetLayout(): WidgetLayoutState {
  const [layout, setState] = useState(() => parseLayout(readLocal(GRID_KEY)));
  const setLayout = useCallback((next: WidgetLayout) => {
    setState(next);
    writeLocal(GRID_KEY, serialiseLayout(next));
  }, []);
  const reset = useCallback(() => setLayout(defaultLayout()), [setLayout]);
  return { layout, setLayout, reset };
}
