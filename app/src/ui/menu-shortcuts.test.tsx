// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { MenuItem } from "./Menu";
import { matchesShortcut, useMenuShortcuts } from "./menu-shortcuts";

afterEach(cleanup);

function Harness({ items }: { items: MenuItem[] }) {
  useMenuShortcuts(items);
  return null;
}

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

test("a shortcut matches its keys exactly, with ⌘ for Ctrl", () => {
  expect(matchesShortcut(key({ key: "s", ctrlKey: true }), "Ctrl+S")).toBe(true);
  expect(matchesShortcut(key({ key: "s", metaKey: true }), "Ctrl+S")).toBe(true);
  expect(matchesShortcut(key({ key: "S", ctrlKey: true, shiftKey: true }), "Ctrl+S")).toBe(false);
  expect(matchesShortcut(key({ key: "S", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+S")).toBe(true);
  expect(matchesShortcut(key({ key: "s" }), "Ctrl+S")).toBe(false);
  expect(matchesShortcut(key({ key: "s", ctrlKey: true, altKey: true }), "Ctrl+S")).toBe(false);
});

test("an item's shortcut chooses it from anywhere, in a submenu too, and once while held", () => {
  const save = vi.fn<() => void>();
  const add = vi.fn<() => void>();
  const blocked = vi.fn<() => void>();
  render(
    <Harness
      items={[
        { kind: "action", id: "save", label: "Save", shortcut: "Ctrl+S", onSelect: save },
        { kind: "action", id: "new", label: "New", shortcut: "Ctrl+N", disabled: true, onSelect: blocked },
        { kind: "submenu", id: "tracks", label: "Tracks", items: [{ kind: "action", id: "add", label: "Add", shortcut: "Ctrl+T", onSelect: add }] },
      ]}
    />,
  );

  expect(fireEvent.keyDown(window, { key: "s", ctrlKey: true })).toBe(false);
  fireEvent.keyDown(window, { key: "s", ctrlKey: true, repeat: true });
  expect(save).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(window, { key: "t", metaKey: true });
  expect(add).toHaveBeenCalledTimes(1);

  // A disabled item keeps the browser's own action away and does nothing.
  expect(fireEvent.keyDown(window, { key: "n", ctrlKey: true })).toBe(false);
  expect(blocked).not.toHaveBeenCalled();

  // Keys no item has are left alone.
  expect(fireEvent.keyDown(window, { key: "q", ctrlKey: true })).toBe(true);
});
