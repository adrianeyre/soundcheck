// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";

import { App } from "./App";

// jsdom has no layout: none of what the demos watch the page with.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class Unobserved {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.ResizeObserver ??= Unobserved as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= Unobserved as unknown as typeof IntersectionObserver;
window.matchMedia ??= (query: string) =>
  ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) as unknown as MediaQueryList;

test("the page the build draws ahead of time hydrates without a mismatch", async () => {
  const markup = renderToString(<App />);
  expect(markup).toContain("Make music with a co");

  const root = document.createElement("div");
  root.innerHTML = markup;
  document.body.append(root);

  const errors: unknown[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    await act(async () => {
      hydrateRoot(
        root,
        <StrictMode>
          <App />
        </StrictMode>,
        { onRecoverableError: (error) => errors.push(error) },
      );
    });
  } finally {
    console.error = consoleError;
  }
  expect(errors).toEqual([]);
});
