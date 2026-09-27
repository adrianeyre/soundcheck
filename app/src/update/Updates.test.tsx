// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";

import { fakeUpdater, NEWER } from "./fake-updater";
import type { Updater } from "./updater";
import { UpdateNotice } from "./UpdateNotice";
import { UpdateSettings } from "./UpdateSettings";
import { CHECK_AT_START_KEY, useUpdates } from "./useUpdates";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

/** The notice and the Settings section, sharing the app's updates as SongPage does. */
function Harness({ updater, mayDiscard }: { updater: Updater | null; mayDiscard?: () => boolean }) {
  const updates = useUpdates(updater, { mayDiscard });
  return (
    <>
      <UpdateNotice updates={updates} />
      <section aria-label="Settings">
        <UpdateSettings updates={updates} />
      </section>
    </>
  );
}

const settings = () => within(screen.getByRole("region", { name: "Settings" }));

test("at start it checks, and a newer version shows the notice", async () => {
  const fake = fakeUpdater();
  render(<Harness updater={fake.updater} />);
  const notice = await screen.findByRole("region", { name: "Update" });
  expect(notice).toHaveTextContent("Soundcheck 1.2.3 is out. You have 0.1.0.");
  expect(fake.calls).toEqual(["status", "check"]);
  // Settings has it too, with what's new.
  expect(settings().getByText("Faster exports.")).toBeInTheDocument();
});

test("Later puts the notice off, and Settings keeps the update", async () => {
  render(<Harness updater={fakeUpdater().updater} />);
  fireEvent.click(await screen.findByRole("button", { name: "Later" }));
  expect(screen.queryByRole("region", { name: "Update" })).not.toBeInTheDocument();
  expect(settings().getByRole("button", { name: "Install and restart" })).toBeInTheDocument();
});

test("turned off, it doesn't check at start, and Check for updates still does", async () => {
  localStorage.setItem(CHECK_AT_START_KEY, "false");
  const fake = fakeUpdater({ found: null });
  render(<Harness updater={fake.updater} />);
  const checkbox = await settings().findByRole("checkbox", { name: /when Soundcheck starts/ });
  expect(checkbox).not.toBeChecked();
  expect(fake.calls).toEqual(["status"]);

  fireEvent.click(settings().getByRole("button", { name: "Check for updates" }));
  expect(await settings().findByText("Soundcheck is up to date.")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Update" })).not.toBeInTheDocument();

  fireEvent.click(checkbox);
  expect(localStorage.getItem(CHECK_AT_START_KEY)).toBe("true");
});

test("a check at start that fails shows no notice, only the reason in Settings", async () => {
  render(<Harness updater={fakeUpdater({ found: new Error("Couldn't check for an update: offline") }).updater} />);
  expect(await settings().findByRole("alert")).toHaveTextContent("Couldn't check for an update: offline");
  expect(screen.queryByRole("region", { name: "Update" })).not.toBeInTheDocument();
});

test("installing shows the download, and a failed install can be tried again", async () => {
  const fake = fakeUpdater();
  render(<Harness updater={fake.updater} />);
  const notice = await screen.findByRole("region", { name: "Update" });
  fireEvent.click(within(notice).getByRole("button", { name: "Install and restart" }));
  act(() => fake.progress(0.5));
  expect(within(notice).getByRole("progressbar", { name: "Update download" })).toHaveAttribute("value", "0.5");

  await act(async () => fake.fail("Couldn't install the update: the signature doesn't match"));
  expect(notice).toHaveTextContent("the signature doesn't match");
  fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));
  expect(fake.calls.filter((call) => call === "install")).toHaveLength(2);
});

test("with unsaved changes it asks first, and installs nothing if told not to", async () => {
  const fake = fakeUpdater();
  let asked = 0;
  render(<Harness updater={fake.updater} mayDiscard={() => (asked++, false)} />);
  const notice = await screen.findByRole("region", { name: "Update" });
  fireEvent.click(within(notice).getByRole("button", { name: "Install and restart" }));
  expect(asked).toBe(1);
  expect(fake.calls).not.toContain("install");
});

test("a copy that doesn't update itself says why, and never checks", async () => {
  const fake = fakeUpdater({ status: { version: "0.1.0", off: "no-key" } });
  render(<Harness updater={fake.updater} />);
  expect(await settings().findByText(/built before Soundcheck's releases were signed/)).toBeInTheDocument();
  expect(settings().getByRole("link", { name: /Releases/ })).toBeInTheDocument();
  expect(settings().queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument();
  expect(fake.calls).toEqual(["status"]);
});

test("where there is no updater, as in the Browser Version, nothing is asked", () => {
  render(<Harness updater={null} />);
  expect(screen.queryByRole("region", { name: "Update" })).not.toBeInTheDocument();
});

test("the release date is shown when the Release gives one", async () => {
  render(<Harness updater={fakeUpdater({ found: { ...NEWER, notes: null } }).updater} />);
  expect(await settings().findByText(/released/)).toBeInTheDocument();
});
