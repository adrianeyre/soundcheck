// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { sampleProject } from "../project/fixtures";
import { ProjectHistory } from "../project/history";
import { CollaborationSettings } from "./CollaborationSettings";
import { relayFor, yourName } from "./identity";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("your name is kept on this machine and signs your Changes from then on", () => {
  const history = new ProjectHistory(sampleProject());
  render(<CollaborationSettings history={history} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), { target: { value: "Sam " } });

  expect(yourName()).toBe("Sam");
  history.execute({ type: "setTempo", tempo: 90 });
  expect(history.log.at(-1)?.by).toBe("Sam");
  cleanup();
  render(<CollaborationSettings history={history} />);
  expect(screen.getByRole("textbox", { name: "Your name" })).toHaveValue("Sam");
});

test("the Relay a Live Session goes through can be one of your own, and an address that isn't one is said", () => {
  render(<CollaborationSettings history={new ProjectHistory(sampleProject())} />);
  const field = screen.getByRole("textbox", { name: "Relay address" });
  fireEvent.change(field, { target: { value: "not a relay://" } });
  expect(field).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByText(/That isn't a Relay's address/)).toBeInTheDocument();

  fireEvent.change(field, { target: { value: "https://relay.example.com" } });
  expect(field).toHaveAttribute("aria-invalid", "false");
  expect(relayFor()).toBe("wss://relay.example.com");
});
