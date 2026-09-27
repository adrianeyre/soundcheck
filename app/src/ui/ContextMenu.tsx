import { useEffect, useId, useRef, type MouseEvent } from "react";
import { createPortal } from "react-dom";

import { type MenuItem, MenuList } from "./Menu";

/** Where a context menu opens, and the element it was opened on, which gets focus back. */
export interface ContextMenuAnchor {
  x: number;
  y: number;
  opener: HTMLElement;
}

/**
 * Where a `contextmenu` event asks for a menu: at the pointer, or, from the
 * keyboard's Menu key or Shift+F10, which have no pointer, under the element.
 */
export function contextMenuAnchor(event: MouseEvent<HTMLElement>): ContextMenuAnchor {
  const opener = event.currentTarget;
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY, opener };
  const box = opener.getBoundingClientRect();
  return { x: box.left, y: box.bottom, opener };
}

export interface ContextMenuProps {
  anchor: ContextMenuAnchor;
  /** What the menu is to a screen reader, such as "Vocals Clip 1". */
  ariaLabel: string;
  items: readonly MenuItem[];
  onClose: () => void;
}

/**
 * A menu opened on something, such as a right-click on a Clip, with the
 * keys a menu button's has (see `Menu`): it opens on its first item, Escape
 * closes it and hands focus back to what it was opened on, and a click
 * outside or Tab closes it too.
 */
export function ContextMenu({ anchor, ariaLabel, items, onClose }: ContextMenuProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeRef.current();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);

  const close = (returnFocus: boolean) => {
    onClose();
    if (returnFocus) anchor.opener.focus();
  };

  return createPortal(
    <div ref={rootRef} className="context-menu" style={{ left: anchor.x, top: anchor.y }}>
      <MenuList id={id} ariaLabel={ariaLabel} items={items} focusFirst="first" onClose={close} className="menu-list" />
    </div>,
    document.body,
  );
}
