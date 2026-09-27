// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { StemSeparationPanel } from "./StemSeparationPanel";
import type { StemSeparationRun, StemSeparationStatus } from "./useStemSeparation";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function run(status: StemSeparationStatus, cancel = () => {}): StemSeparationRun {
  return { separator: { kind: "installed" }, status, busy: true, start: async () => {}, install: async () => {}, cancel };
}

const overlay = () => screen.getByRole("group", { name: "Stem Separation" });

test("while it separates, a spinner in the centre says what it's doing, how far it has got, and how long is left", () => {
  vi.useFakeTimers({ now: 10_000 });
  const cancel = vi.fn<() => void>();
  const status: StemSeparationStatus = {
    state: "separating",
    name: "song",
    progress: 0.3,
    stage: "separating",
    since: { at: 0, progress: 0.1 },
  };
  const { container } = render(<StemSeparationPanel run={run(status, cancel)} />);

  const card = overlay();
  expect(card.closest(".separation-overlay")).toBeInTheDocument();
  expect(card).toHaveAttribute("aria-busy", "true");
  expect(container.querySelector(".separation-spinner")).toBeInTheDocument();
  expect(card).toHaveTextContent("Separating song into Stems…");
  expect(card).toHaveTextContent("Separating the drums, bass, other and vocals…");
  expect(within(card).getByRole("progressbar", { name: "Stem Separation progress" })).toHaveAttribute("value", "0.3");
  // A fifth done in 10 s, so the 70% left takes about 35 s.
  expect(card).toHaveTextContent("30% · about 35 s left");
  expect(card).toHaveTextContent("You can keep working while it runs.");

  // The time left counts down as the clock moves on, at the same rate.
  act(() => vi.advanceTimersByTime(5_000));
  expect(card).toHaveTextContent("30% · about 53 s left");

  fireEvent.click(within(card).getByRole("button", { name: "Cancel Stem Separation" }));
  expect(cancel).toHaveBeenCalledOnce();
});

test("before the chunks start, it says the stage and no time left", () => {
  render(
    <StemSeparationPanel run={run({ state: "separating", name: "song", progress: 0, stage: "loadingModel", since: null })} />,
  );
  expect(overlay()).toHaveTextContent("Loading the model (about 300 MB)…");
  const [percent] = overlay().querySelectorAll(".separation-detail");
  expect(percent).toHaveTextContent(/^0%$/);
});

test("installing the model shows the spinner too, and what it's doing", () => {
  render(<StemSeparationPanel run={run({ state: "installing" })} />);
  expect(overlay()).toHaveTextContent("Installing the Stem Separation model…");
  expect(overlay()).toHaveTextContent("Checking it's htdemucs, then keeping a copy (about 300 MB).");
  expect(screen.queryByRole("button", { name: "Cancel Stem Separation" })).not.toBeInTheDocument();
});

test("nothing is over the screen when no separation is under way", () => {
  render(<StemSeparationPanel run={run({ state: "done", name: "song" })} />);
  expect(screen.queryByRole("group", { name: "Stem Separation" })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Separated song into its Stems");
});
