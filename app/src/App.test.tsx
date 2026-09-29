// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { App } from "./App";
import { loadEngine } from "./engine";
import { CONSENT_KEY } from "./legal/consent";
import { REPOSITORY_URL } from "./legal/links";
import { menuItem, openFileMenu } from "./ui/file-menu-testing";

vi.mock("./engine", () => ({
  loadEngine: vi.fn<() => Promise<{ version: string }>>(() => Promise.resolve({ version: "9.9.9" })),
}));

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
});
afterEach(cleanup);

const menu = () => screen.getByRole("button", { name: /^Menu, / });

function choose(item: string) {
  fireEvent.click(menu());
  fireEvent.click(screen.getByRole("menuitemradio", { name: item }));
}

test("the title bar has the menu and the Project at its start and the app's name in the middle", async () => {
  render(<App />);
  const header = screen.getByRole("banner");
  const start = header.querySelector(".header-start")!;
  expect(within(start as HTMLElement).getByRole("button", { name: "Menu, Editor" })).toBeInTheDocument();
  expect(within(start as HTMLElement).getByLabelText("Project name")).toHaveValue("Untitled");
  expect(header.querySelector(".brand")).toHaveTextContent("Soundcheck");
  // The version is the footer's to give; the title bar only speaks up if the engine fails.
  await vi.waitFor(() => expect(loadEngine).toHaveBeenCalled());
  expect(header).not.toHaveTextContent("Audio Engine");
});

test("the title bar says so when the Audio Engine fails to load", async () => {
  vi.mocked(loadEngine).mockRejectedValueOnce(new Error("no WASM"));
  render(<App />);
  expect(await within(screen.getByRole("banner")).findByRole("alert")).toHaveTextContent(
    "Audio Engine failed to load: Error: no WASM",
  );
});

test("the File menu heads the menu: New, Open, Save, Save As, Share, Live Session, Tracks, Import as Stems and Export", async () => {
  render(<App />);
  openFileMenu();
  const file = screen.getByRole("menu", { name: "File" });
  const items = [...file.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  // Each item's own words, without the reason under one that can't be chosen.
  expect(items.map((item) => item.querySelector(".menu-label")?.firstChild?.textContent)).toEqual([
    "New",
    "Open…",
    "Save",
    "Save As…",
    "Share this Project…",
    "Live Session…",
    "Tracks",
    "Import as Stems…",
    "Export…",
  ]);
  expect(menuItem("Save")).toHaveAttribute("aria-keyshortcuts", "Control+S");

  // Export opens its own dialog, with WAV and MP3 to choose between.
  fireEvent.click(menuItem("Export…"));
  const dialog = await screen.findByRole("dialog", { name: "Export" });
  const format = within(dialog).getByLabelText("Format");
  expect([...format.querySelectorAll("option")].map((option) => option.value)).toEqual(["wav", "mp3"]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Close export" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Menu, / })).toHaveFocus();
});

const addTrackFromMenu = (label: string) => {
  openFileMenu();
  fireEvent.click(menuItem("Tracks"));
  expect(
    [...screen.getByRole("menu", { name: "Tracks" }).querySelectorAll(".menu-label")].map((item) => item.textContent),
  ).toEqual(["Add Instrument Track", "Add Drum Track", "Add Keys Track", "Add Audio Track"]);
  fireEvent.click(menuItem(label));
};

test("File, then Tracks, adds an Instrument, Drum, Keys or Audio Track", async () => {
  render(<App />);
  addTrackFromMenu("Add Instrument Track");
  addTrackFromMenu("Add Drum Track");
  addTrackFromMenu("Add Audio Track");
  addTrackFromMenu("Add Keys Track");
  expect(await screen.findByLabelText("Synth 1 lane")).toBeInTheDocument();
  expect(screen.getByLabelText("Drums 2 lane")).toBeInTheDocument();
  expect(screen.getByLabelText("Audio 3 lane")).toBeInTheDocument();
  expect(screen.getByLabelText(/^Keys \d lane$/)).toBeInTheDocument();
});

test("the Editor shows only music-making; the AI settings are on Settings", async () => {
  render(<App />);
  await screen.findByRole("button", { name: /^Menu, / });

  expect(screen.getByRole("heading", { level: 1, name: /Editor/ })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Mixer" })).toBeVisible();
  // Settings stays mounted, so nothing typed there is lost, but is hidden from everyone.
  expect(screen.getByLabelText("Provider")).not.toBeVisible();

  choose("Settings");
  expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
  expect(menu()).toHaveAccessibleName("Menu, Settings");
  expect(location.hash).toBe("#settings");
  expect(screen.getByLabelText("Provider")).toBeVisible();
  // The Project's file and exporting are the File menu's now.
  expect(screen.queryByRole("region", { name: "Project file" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Export" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Mixer" })).not.toBeInTheDocument();

  // The song is still there when the Editor comes back.
  choose("Editor");
  expect(screen.getByRole("region", { name: "Mixer" })).toBeVisible();
});

test("the Assistant's set-up button takes the musician to its settings", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Set up the Assistant" }));
  expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
});

test("the menu opens and moves with the keyboard, and Escape hands focus back", async () => {
  render(<App />);
  await screen.findByRole("button", { name: /^Menu, / });
  const button = menu();
  expect(button).toHaveAttribute("aria-expanded", "false");

  fireEvent.keyDown(button, { key: "ArrowDown" });
  expect(button).toHaveAttribute("aria-expanded", "true");
  const items = [...screen.getByRole("menu").querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  expect(items.map((item) => item.textContent)).toEqual([
    "File",
    "Editor",
    "Mixer",
    "Settings",
    "Grid",
    "Cookie Policy",
    "Accessibility",
    "Credits",
  ]);
  expect(items[0]).toHaveFocus();
  expect(items[1]).toHaveAttribute("aria-checked", "true");

  fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
  expect(items[1]).toHaveFocus();
  fireEvent.keyDown(items[1]!, { key: "End" });
  expect(items[7]).toHaveFocus();
  fireEvent.keyDown(items[7]!, { key: "ArrowDown" });
  expect(items[0]).toHaveFocus();

  fireEvent.keyDown(items[0]!, { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(button).toHaveFocus();
});

test("Credits, last in the menu, opens a dialog with the credits, and Close closes it", async () => {
  render(<App />);
  await screen.findByRole("button", { name: /^Menu, / });
  const button = menu();
  fireEvent.click(button);
  const items = [...screen.getByRole("menu").querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  expect(items.at(-1)).toHaveTextContent("Credits");

  fireEvent.click(screen.getByRole("menuitem", { name: "Credits" }));
  const credits = await screen.findByRole("dialog", { name: "Credits" });
  expect(credits).toHaveTextContent("Soundcheck by Adrian Eyre");
  expect(within(credits).getByRole("link", { name: /Soundcheck on GitHub/ })).toHaveAttribute("href", REPOSITORY_URL);
  expect(credits).toHaveTextContent("Demucs");
  // It is an action: the page behind it stays where it was.
  expect(menu()).toHaveAccessibleName("Menu, Editor");

  fireEvent.click(within(credits).getByRole("button", { name: "Close credits" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("the footer credits the design, shows the version and opens the policies", async () => {
  render(<App />);
  const footer = screen.getByRole("contentinfo");
  const credit = within(footer).getByRole("link", { name: /Website design/ });
  expect(credit).toHaveAttribute("href", REPOSITORY_URL);
  expect(credit).toHaveAttribute("target", "_blank");
  expect(within(footer).getByText(`Version: ${import.meta.env.VITE_APP_VERSION}`)).toBeInTheDocument();
  expect(within(footer).getAllByRole("button").map((button) => button.textContent)).toEqual([
    "Cookie Policy",
    "Accessibility",
  ]);

  const opener = within(footer).getByRole("button", { name: "Accessibility" });
  opener.focus();
  fireEvent.click(opener);
  const statement = await screen.findByRole("dialog", { name: "Accessibility" });
  expect(within(statement).getByText(/WCAG\) 2\.2/)).toBeInTheDocument();
  const close = within(statement).getByRole("button", { name: "Close accessibility statement" });
  expect(close).toHaveFocus();

  fireEvent.keyDown(statement, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(within(footer).getByRole("button", { name: "Accessibility" })).toHaveFocus();
});

test("the cookie notice is shown until it is accepted, and the policy lists what is stored", async () => {
  render(<App />);
  const notice = screen.getByRole("region", { name: "Cookie notice" });

  fireEvent.click(within(notice).getByRole("button", { name: "Learn more" }));
  const policy = await screen.findByRole("dialog", { name: "Cookie Policy" });
  expect(within(policy).getByRole("table")).toHaveTextContent(CONSENT_KEY);
  fireEvent.click(within(policy).getByRole("button", { name: "Close cookie policy" }));

  fireEvent.click(within(notice).getByRole("button", { name: "Accept" }));
  expect(screen.queryByRole("region", { name: "Cookie notice" })).not.toBeInTheDocument();
  expect(localStorage.getItem(CONSENT_KEY)).not.toBeNull();

  cleanup();
  render(<App />);
  expect(screen.queryByRole("region", { name: "Cookie notice" })).not.toBeInTheDocument();
});

test("the theme chosen in Settings is shown and remembered", async () => {
  render(<App />);
  choose("Settings");
  fireEvent.click(screen.getByRole("radio", { name: "Light" }));
  expect(document.documentElement).toHaveAttribute("data-theme", "light");
  expect(localStorage.getItem("soundcheck.theme")).toBe("light");
  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
});

test("the colour palette chosen in Settings is shown, and is there again next visit", async () => {
  render(<App />);
  choose("Settings");
  const palettes = screen.getByRole("group", { name: "Colour palette" });
  expect(within(palettes).getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual([
    "violet",
    "ocean",
    "aqua",
    "rose",
    "tangerine",
    "slate",
  ]);
  expect(within(palettes).getByRole("radio", { name: "Violet" })).toBeChecked();

  fireEvent.click(within(palettes).getByRole("radio", { name: "Rose" }));
  expect(document.documentElement).toHaveAttribute("data-palette", "rose");
  expect(localStorage.getItem("soundcheck.palette")).toBe("rose");

  cleanup();
  document.documentElement.removeAttribute("data-palette");
  render(<App />);
  expect(document.documentElement).toHaveAttribute("data-palette", "rose");
  choose("Settings");
  expect(screen.getByRole("radio", { name: "Rose" })).toBeChecked();

  // Violet is the stylesheet's own.
  fireEvent.click(screen.getByRole("radio", { name: "Violet" }));
  expect(document.documentElement).not.toHaveAttribute("data-palette");
});

test("the Grid menu lists every Widget, hides and shows them, and remembers the layout", async () => {
  render(<App />);
  await screen.findByRole("button", { name: /^Menu, / });
  expect(screen.queryByText("Start audio to play, record and hear the song.")).not.toBeInTheDocument();

  fireEvent.keyDown(menu(), { key: "ArrowDown" });
  const gridItem = screen.getByRole("menuitem", { name: "Grid" });
  expect(gridItem).toHaveAttribute("aria-haspopup", "menu");
  gridItem.focus();
  fireEvent.keyDown(gridItem, { key: "ArrowRight" });
  const side = screen.getByRole("menu", { name: "Grid" });
  const boxes = within(side).getAllByRole("menuitemcheckbox");
  expect(boxes.map((box) => box.textContent)).toEqual([
    "Transport",
    "Assistant",
    "Tracks",
    "Timeline",
    // With no Clip selected, and in a browser, which can't record audio.
    "Audio Editor (empty)",
    "Step Sequencer (empty)",
    "Piano Roll (empty)",
    "Instrument (empty)",
    "Record audio (empty)",
    "Samples",
    "Mixer",
    "Keyboard",
    "Chords",
    "Note Tools (empty)",
    "Meters",
    "Song Overview",
    "EQ",
  ]);
  expect(boxes[0]).toHaveFocus();
  expect(boxes.every((box) => box.getAttribute("aria-checked") === "true")).toBe(true);

  // Unchecked, the Mixer goes, and the menu stays open for the next one.
  fireEvent.click(within(side).getByRole("menuitemcheckbox", { name: "Mixer" }));
  expect(screen.queryByRole("region", { name: "Mixer" })).not.toBeInTheDocument();
  expect(within(side).getByRole("menuitemcheckbox", { name: "Mixer" })).toHaveAttribute("aria-checked", "false");
  expect(JSON.parse(localStorage.getItem("soundcheck.grid")!).widgets.mixer.hidden).toBe(true);

  // The left arrow goes back to the Grid item.
  fireEvent.keyDown(within(side).getByRole("menuitemcheckbox", { name: "Mixer" }), { key: "ArrowLeft" });
  expect(screen.queryByRole("menu", { name: "Grid" })).not.toBeInTheDocument();
  expect(gridItem).toHaveFocus();
  fireEvent.keyDown(gridItem, { key: "Escape" });

  // A Widget's own cross hides it too; one is pinned, one moved and resized from its grip.
  fireEvent.click(screen.getByRole("button", { name: "Hide Timeline" }));
  fireEvent.click(screen.getByRole("button", { name: "Pin Transport to top" }));
  const grip = screen.getByRole("button", { name: "Move Tracks" });
  fireEvent.keyDown(grip, { key: "ArrowDown" });
  fireEvent.keyDown(grip, { key: "ArrowRight", shiftKey: true });
  const tracks = { ...JSON.parse(localStorage.getItem("soundcheck.grid")!).widgets.tracks };

  // The next visit opens with everything where it was left.
  cleanup();
  render(<App />);
  await screen.findByRole("button", { name: /^Menu, / });
  expect(screen.queryByRole("region", { name: "Mixer" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Hide Timeline" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pin Transport to top" })).toHaveAttribute("aria-pressed", "true");
  const tracksWidget = screen.getByRole("button", { name: "Move Tracks" }).closest<HTMLElement>(".widget")!;
  expect(tracksWidget.style.gridRow).toBe(`${tracks.y + 1} / span ${tracks.h}`);
  expect(tracksWidget.style.gridColumn).toBe(`${tracks.x + 1} / span 8`);

  // Reset puts every Widget back.
  fireEvent.click(menu());
  fireEvent.click(screen.getByRole("menuitem", { name: "Grid" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Reset layout" }));
  expect(screen.getByRole("region", { name: "Mixer" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Hide Timeline" })).toBeVisible();
});

test("the Browser Version's Settings say what only the Desktop App has, and link to it", async () => {
  render(<App />);
  await screen.findByRole("button", { name: /^Menu, / });
  choose("Settings");
  const section = screen.getByRole("region", { name: "Browser version" });
  expect(section).toBeVisible();
  const lacks = within(section).getAllByRole("listitem").map((item) => item.querySelector("strong")?.textContent);
  expect(lacks).toContain("Low latency");
  expect(lacks).toContain("Recording audio");
  expect(within(section).getByRole("link", { name: /Get the Desktop App/ })).toHaveAttribute(
    "href",
    `${REPOSITORY_URL}/releases`,
  );
  // It is listed with the other sections, so it can be jumped to.
  const sections = screen.getByRole("navigation", { name: "Settings sections" });
  expect(within(sections).getByRole("link", { name: "Browser version" })).toBeInTheDocument();
});

/** The Grid menu's Widgets, opened from the app's menu. */
function gridMenuItems(): string[] {
  fireEvent.keyDown(menu(), { key: "ArrowDown" });
  const gridItem = screen.getByRole("menuitem", { name: "Grid" });
  gridItem.focus();
  fireEvent.keyDown(gridItem, { key: "ArrowRight" });
  const items = within(screen.getByRole("menu", { name: "Grid" }))
    .getAllByRole("menuitemcheckbox")
    .map((box) => box.textContent ?? "");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  return items;
}

test("the Grid menu lists the open page's Widgets, and each page keeps its own layout", async () => {
  render(<App />);
  await screen.findByRole("button", { name: /^Menu, / });
  expect(gridMenuItems()).toContain("Transport");

  choose("Mixer");
  expect(screen.getByRole("heading", { level: 1, name: "Mixer" })).toBeInTheDocument();
  expect(menu()).toHaveAccessibleName("Menu, Mixer");
  // With two Decks, the third and fourth have nothing to show.
  expect(gridMenuItems()).toEqual([
    "Waveforms",
    "Deck 1",
    "Mixer",
    "Deck 2",
    "Deck 3 (empty)",
    "Deck 4 (empty)",
    "Track browser 1",
    "Track browser 2",
  ]);

  // Hiding the Mixer page's mixer leaves the Editor's Mixer where it is.
  fireEvent.keyDown(menu(), { key: "ArrowDown" });
  const gridItem = screen.getByRole("menuitem", { name: "Grid" });
  gridItem.focus();
  fireEvent.keyDown(gridItem, { key: "ArrowRight" });
  fireEvent.click(within(screen.getByRole("menu", { name: "Grid" })).getByRole("menuitemcheckbox", { name: "Mixer" }));
  expect(JSON.parse(localStorage.getItem("soundcheck.grid.mixing")!).widgets.djMixer.hidden).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  choose("Editor");
  expect(screen.getByRole("region", { name: "Mixer" })).toBeVisible();

  // Settings has no Grid, so no Grid menu.
  choose("Settings");
  fireEvent.keyDown(menu(), { key: "ArrowDown" });
  expect(screen.queryByRole("menuitem", { name: "Grid" })).not.toBeInTheDocument();
});
