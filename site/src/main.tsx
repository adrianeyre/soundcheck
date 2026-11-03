import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

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
  if (root) {
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  }
}
