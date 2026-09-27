// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { SettingsPage } from "./SettingsPage";

/** Puts each section's top where the page has scrolled it to. */
function scrollTo(tops: Record<string, number>) {
  for (const [id, top] of Object.entries(tops)) {
    document.getElementById(id)!.getBoundingClientRect = () => ({ top }) as DOMRect;
  }
  act(() => void fireEvent.scroll(window));
}

afterEach(cleanup);

const link = (name: string) => screen.getByRole("link", { name });

test("the nav marks the section being read, as the page scrolls", () => {
  render(<SettingsPage assistant={<p>Key</p>} plugins={<p>None</p>} />);
  scrollTo({ "settings-assistant": 0, "settings-plugins": 400, "settings-appearance": 900 });
  expect(link("Assistant")).toHaveAttribute("aria-current", "location");
  expect(link("Plugins")).not.toHaveAttribute("aria-current");

  // Plugins has scrolled up to the top; Appearance is still below it.
  scrollTo({ "settings-assistant": -400, "settings-plugins": 20, "settings-appearance": 600 });
  expect(link("Plugins")).toHaveAttribute("aria-current", "location");
  expect(link("Assistant")).not.toHaveAttribute("aria-current");

  // Back at the top.
  scrollTo({ "settings-assistant": 0, "settings-plugins": 400, "settings-appearance": 900 });
  expect(link("Assistant")).toHaveAttribute("aria-current", "location");
});

test("at the end of the page the last section is marked, though too short to reach the top", () => {
  render(<SettingsPage assistant={<p>Key</p>} plugins={<p>None</p>} />);
  const page = document.documentElement;
  for (const [name, value] of Object.entries({ scrollHeight: 2000, clientHeight: 800, scrollTop: 1200 })) {
    Object.defineProperty(page, name, { value, configurable: true });
  }
  scrollTo({ "settings-assistant": -1200, "settings-plugins": -700, "settings-appearance": 300 });
  expect(link("Appearance")).toHaveAttribute("aria-current", "location");

  // Jumped to from the nav, a section in view stays marked, though the page is at its end.
  document.getElementById("settings-plugins")!.scrollIntoView = () => {};
  fireEvent.click(link("Plugins"));
  scrollTo({ "settings-assistant": -1200, "settings-plugins": 200, "settings-appearance": 700 });
  expect(link("Plugins")).toHaveAttribute("aria-current", "location");
  for (const name of ["scrollHeight", "clientHeight", "scrollTop"]) Reflect.deleteProperty(page, name);
});
