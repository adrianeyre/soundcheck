/**
 * For tests: the File menu, as the musician reaches it. Through the app's
 * menu, where File is a side menu at its head, or through the Editor's own
 * File menu where the Editor is rendered alone.
 */
import { fireEvent, screen } from "@testing-library/react";

/** An item of the open menus, by the words it shows (the shortcut beside it aside). */
export function menuItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find(
    (item) => item.querySelector(".menu-label")?.textContent === label,
  );
  if (!found) throw new Error(`No menu item ${label}`);
  return found;
}

/** Open the File menu, showing its items. */
export function openFileMenu(): void {
  const alone = document.querySelector<HTMLElement>('button[aria-label="File menu"]');
  if (alone) {
    if (alone.getAttribute("aria-expanded") !== "true") fireEvent.click(alone);
    return;
  }
  const button = screen.getByRole("button", { name: /^Menu, / });
  if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
  fireEvent.click(menuItem("File"));
}

/** Choose `label` from the File menu: "New", "Open…", "Save", "Save As…" or "Export…". */
export function chooseFromFileMenu(label: string): void {
  openFileMenu();
  fireEvent.click(menuItem(label));
}

/** Whether `label` on the File menu can be chosen now; the menu is left closed. */
export function fileMenuEnabled(label: string): boolean {
  openFileMenu();
  const enabled = menuItem(label).getAttribute("aria-disabled") !== "true";
  fireEvent.keyDown(menuItem(label), { key: "Escape" });
  return enabled;
}
