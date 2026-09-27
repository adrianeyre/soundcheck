// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { Credits } from "./Credits";
import { REPOSITORY_URL } from "./links";

afterEach(cleanup);

/** The list item that credits `name`. */
function credit(name: string): HTMLElement {
  return screen.getByRole("link", { name: new RegExp(`^${name}\\b`) }).closest("li")!;
}

test("the credits open with Soundcheck's author, its source and its licence", () => {
  render(<Credits />);
  const own = screen.getByRole("region", { name: "Soundcheck" });
  expect(own).toHaveTextContent(`Soundcheck by ${import.meta.env.VITE_APP_AUTHOR}`);
  expect(import.meta.env.VITE_APP_AUTHOR).toBe("Adrian Eyre");
  expect(within(own).getByRole("link", { name: /Soundcheck on GitHub/ })).toHaveAttribute("href", REPOSITORY_URL);
  expect(own).toHaveTextContent("GPL-3.0-or-later");
  // It comes before anyone else's work.
  expect(screen.getAllByRole("heading", { level: 3 })[0]).toHaveTextContent("Soundcheck");
});

test("Stem Separation credits Demucs, Mixxx's export and ONNX Runtime, and says the weights aren't shipped", () => {
  render(<Credits />);
  const demucs = credit("Demucs");
  expect(within(demucs).getByRole("link", { name: /^Demucs/ })).toHaveAttribute(
    "href",
    "https://github.com/facebookresearch/demucs",
  );
  expect(demucs).toHaveTextContent("Meta");
  expect(demucs).toHaveTextContent("Licence: MIT");

  const mixxx = credit("Mixxx's ONNX export of Demucs");
  expect(within(mixxx).getByRole("link", { name: /^Mixxx's ONNX export/ })).toHaveAttribute(
    "href",
    "https://github.com/mixxxdj/demucs",
  );
  expect(within(mixxx).getByRole("link", { name: /write-up/ })).toHaveAttribute(
    "href",
    "https://mixxx.org/news/2025-10-27-gsoc2025-demucs-to-onnx-dhunstack/",
  );
  expect(mixxx).toHaveTextContent("Google Summer of Code 2025");
  expect(mixxx).toHaveTextContent("Licence: MIT");

  const onnx = credit("ONNX Runtime");
  expect(onnx).toHaveTextContent("Microsoft");
  expect(onnx).toHaveTextContent("Licence: MIT");

  const weights = screen.getByRole("note", { name: "The model's weights" });
  expect(weights).toHaveTextContent("Meta's");
  expect(weights).toHaveTextContent("personal use only");
  expect(weights).toHaveTextContent("not shipped with Soundcheck");
});

test("the Desktop App's own foundations are credited, with Steinberg's trademark line", () => {
  render(<Credits />);
  for (const [name, licence] of [
    ["Tauri", "MIT or Apache-2.0"],
    ["cpal", "Apache-2.0"],
    ["midir", "MIT"],
    ["Wasmtime", "Apache-2.0 with LLVM exception"],
    ["VST 3 SDK", "MIT"],
  ]) {
    expect(credit(name!)).toHaveTextContent(`Licence: ${licence}`);
  }
  expect(screen.getByText("VST is a registered trademark of Steinberg Media Technologies GmbH.")).toBeInTheDocument();
});

test("every credit names its licence, and every link opens safely in a new tab", () => {
  render(<Credits />);
  for (const item of screen.getAllByRole("listitem")) expect(item).toHaveTextContent(/Licence: \S/);
  for (const link of screen.getAllByRole("link")) {
    expect(link.getAttribute("href")).toMatch(/^https:\/\//);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAccessibleName(/opens in a new tab/);
  }
});
