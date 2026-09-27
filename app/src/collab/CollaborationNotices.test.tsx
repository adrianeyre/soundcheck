// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { sampleProject } from "../project/fixtures";
import { ProjectHistory } from "../project/history";
import { CollaborationNotices } from "./CollaborationNotices";

afterEach(cleanup);

test("says when an undo leaves what a Collaborator changed, until dismissed", () => {
  const mine = new ProjectHistory(sampleProject(), { copy: "alice", by: "Alice" });
  const theirs = new ProjectHistory(sampleProject(), { copy: "bob", by: "Bob" });
  render(<CollaborationNotices history={mine} />);

  mine.execute({ type: "setTempo", tempo: 90 });
  theirs.receive(mine.log);
  theirs.execute({ type: "setTempo", tempo: 100 });
  act(() => {
    mine.receive(theirs.log);
    mine.undo();
  });

  expect(screen.getByRole("status")).toHaveTextContent("Undo of “Set tempo” left the tempo as Bob changed it since.");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("says who has to update when a Collaborator's copy uses other rules", () => {
  const mine = new ProjectHistory(sampleProject(), { copy: "alice" });
  render(<CollaborationNotices history={mine} />);
  act(() => {
    mine.receive([{ id: "bob:1", copy: "bob", seq: 1, clock: 1, kind: "edit", sync: "0.1", by: "Bob", writes: [] }]);
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Bob is using an older Soundcheck, and needs to update it");
});
