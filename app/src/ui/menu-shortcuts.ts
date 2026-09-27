/**
 * A menu's shortcuts, working from anywhere in the app: the keys each action
 * item says it has ("Ctrl+S", "Ctrl+Shift+T") choose it, submenus included,
 * so what the menu shows and what the keyboard does can't drift apart.
 */
import { useEffect, useRef } from "react";

import type { MenuItem } from "./Menu";

interface Keys {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** "Ctrl+Shift+S" as the keys it means. Ctrl is ⌘ on a Mac too. */
export function parseShortcut(shortcut: string): Keys {
  const parts = shortcut.split("+");
  const key = parts.pop()!.toLowerCase();
  return { key, ctrl: parts.includes("Ctrl"), shift: parts.includes("Shift"), alt: parts.includes("Alt") };
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const keys = parseShortcut(shortcut);
  return (
    event.key.toLowerCase() === keys.key &&
    (event.ctrlKey || event.metaKey) === keys.ctrl &&
    event.shiftKey === keys.shift &&
    event.altKey === keys.alt
  );
}

function* actions(items: readonly MenuItem[]): Generator<Extract<MenuItem, { kind: "action" }>> {
  for (const item of items) {
    if (item.kind === "action") yield item;
    else if (item.kind === "submenu") yield* actions(item.items);
  }
}

/** Chooses an item when its shortcut is pressed; a disabled one takes the key and does nothing. */
export function useMenuShortcuts(items: readonly MenuItem[]): void {
  // The items change with every render (a Save disabled while one runs), and the listener stays.
  const latest = useRef(items);
  useEffect(() => {
    latest.current = items;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      for (const item of actions(latest.current)) {
        if (!item.shortcut || !matchesShortcut(event, item.shortcut)) continue;
        // Held down, the browser's own Save or New Window is still kept away, but it isn't chosen again.
        event.preventDefault();
        if (!item.disabled && !event.repeat) item.onSelect();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
