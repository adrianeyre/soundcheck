import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";

import { App } from "./App";
import { appAddressFor } from "./forward";
import "./site.css";

// An old link to the Browser Version, from when it was at the root, goes on
// to where it is now before anything draws (ADR 0017).
const forward = appAddressFor(location.hash);
if (forward) {
  location.replace(forward);
} else {
  const root = document.getElementById("root");
  const app = (
    <StrictMode>
      <App />
    </StrictMode>
  );
  // The build draws the page into the root ahead of time (`prerender` in
  // `vite.config.ts`); `pnpm dev` doesn't, and leaves it empty.
  if (root?.firstElementChild) hydrateRoot(root, app);
  else if (root) createRoot(root).render(app);
}
