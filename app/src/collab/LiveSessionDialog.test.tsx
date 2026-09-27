// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";

import { sampleProject } from "../project/fixtures";
import { ProjectHistory } from "../project/history";
import { createProject } from "../project/model";
import { FakeRelay } from "./fake-relay";
import { LiveSessionDialog } from "./LiveSessionDialog";
import { NO_RELAY, NOT_AN_INVITE, useLiveSession } from "./useLiveSession";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** A page with a Project, and the Live Session dialog open over it. */
function Page({ start, relay, address }: { start: ProjectHistory; relay: FakeRelay; address: string | null }) {
  const [history, setHistory] = useState(start);
  const live = useLiveSession({
    history,
    samples: () => new Map(),
    onAudio: () => {},
    adopt: setHistory,
    shared: false,
    mayDiscard: () => true,
    site: "https://soundcheck.test/",
    relay: () => address,
    connect: relay.connect,
  });
  return (
    <section aria-label={start.by}>
      <p>Editing {history.project.name}</p>
      <LiveSessionDialog open onClose={() => {}} live={live} />
    </section>
  );
}

test("starting a Live Session gives a link that whoever gets it joins with, and both see who is there", async () => {
  const relay = new FakeRelay();
  render(
    <Page start={new ProjectHistory(sampleProject(), { by: "Alice" })} relay={relay} address="wss://relay.test" />,
  );
  render(<Page start={new ProjectHistory(createProject("Mine"), { by: "Bob" })} relay={relay} address={null} />);
  const alice = within(screen.getByRole("region", { name: "Alice" }));
  const bob = within(screen.getByRole("region", { name: "Bob" }));

  fireEvent.click(alice.getByRole("button", { name: "Start a Live Session" }));
  const link = (alice.getByRole("textbox", { name: "Invite link" }) as HTMLInputElement).value;
  expect(link).toMatch(/^https:\/\/soundcheck\.test\/#live=/);
  await waitFor(() => expect(alice.getByRole("status")).toHaveTextContent("Live. Nobody else is here yet."));

  // Bob's copy has no Relay of its own: the link says which.
  expect(bob.queryByRole("button", { name: "Start a Live Session" })).not.toBeInTheDocument();
  fireEvent.change(bob.getByRole("textbox", { name: "Invite link" }), { target: { value: link } });
  fireEvent.click(bob.getByRole("button", { name: "Join" }));
  await waitFor(() => expect(bob.getByText(`Editing ${sampleProject().name}`)).toBeInTheDocument());
  await waitFor(() => expect(bob.getByRole("status")).toHaveTextContent("Live with Alice."));
  await waitFor(() => expect(alice.getByRole("status")).toHaveTextContent("Live with Bob."));

  fireEvent.click(bob.getByRole("button", { name: "Leave" }));
  expect(bob.getByRole("button", { name: "Join" })).toBeInTheDocument();
  await waitFor(() => expect(alice.getByRole("status")).toHaveTextContent("Live. Nobody else is here yet."));
});

test("without a Relay a session can't be started, and a link that isn't an invite is said", () => {
  render(<Page start={new ProjectHistory(sampleProject())} relay={new FakeRelay()} address={null} />);
  expect(screen.getByText(/needs a Relay: type its address in Settings → Collaboration/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "Invite link" }), { target: { value: "https://example.com/" } });
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  expect(screen.getByRole("alert")).toHaveTextContent(NOT_AN_INVITE);
  expect(NO_RELAY).toMatch(/Settings → Collaboration/);
});
