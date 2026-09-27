import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { TrackKind } from "../project/model";

export type MenuItem =
  | { kind: "choice"; id: string; label: string; icon?: ReactNode; checked: boolean; onSelect: () => void }
  | {
      kind: "action";
      id: string;
      label: string;
      icon?: ReactNode;
      onSelect: () => void;
      /** Shown but not chosen, such as Save while a save is under way. */
      disabled?: boolean;
      /** The key that does the same from anywhere, shown beside it: "Ctrl+S". */
      shortcut?: string;
      /** Shown under the label and read out after it, such as why it is disabled. */
      description?: string;
      /** The kind of Track it adds, whose coloured stripe it has down its left edge. */
      trackKind?: TrackKind;
    }
  | {
      kind: "checkbox";
      id: string;
      label: string;
      icon?: ReactNode;
      checked: boolean;
      onToggle: () => void;
      /** Said beside it, and read out with it: why ticking it shows nothing yet, such as "Empty". */
      note?: string;
    }
  | { kind: "submenu"; id: string; label: string; icon?: ReactNode; items: readonly MenuItem[] }
  | { kind: "separator"; id: string };

export interface MenuProps {
  /** What the button says, such as the view being shown. */
  label: ReactNode;
  /** What the button is to a screen reader, such as "Menu, Editor". */
  ariaLabel: string;
  items: readonly MenuItem[];
}

/**
 * A menu button (WAI-ARIA APG): Enter, Space or the down arrow open it on
 * its first item, the up arrow on its last; the arrows, Home and End move
 * between items; Escape and Tab close it, and Escape hands focus back to
 * the button. A click outside closes it too.
 *
 * A submenu opens to the side on the right arrow, Enter, Space, a click or
 * the pointer resting on it, and the left arrow or Escape closes it again.
 * Its checkboxes toggle without closing anything, so several can be changed
 * in one visit. A disabled item can still be reached, so it can be read out,
 * but does nothing.
 */
export function Menu({ label, ariaLabel, items }: MenuProps) {
  const [open, setOpen] = useState<"first" | "last" | null>(null);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpen(null);
    if (returnFocus) buttonRef.current?.focus();
  };

  const onButtonKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen("first");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen("last");
    }
  };

  return (
    <div className="menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="menu-button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : setOpen("first"))}
        onKeyDown={onButtonKey}
      >
        {label}
        <ChevronDown size={16} aria-hidden className="menu-chevron" />
      </button>
      {open && (
        <MenuList id={menuId} ariaLabel={ariaLabel} items={items} focusFirst={open} onClose={close} className="menu-list" />
      )}
    </div>
  );
}

export interface MenuListProps {
  id: string;
  ariaLabel: string;
  items: readonly MenuItem[];
  /** Which item has focus when it opens; null leaves focus where it is (a submenu opened by the pointer). */
  focusFirst: "first" | "last" | null;
  /** Close the whole menu. */
  onClose: (returnFocus: boolean) => void;
  /** Close just this submenu, handing focus back to the item that opened it. */
  onBack?: () => void;
  className: string;
}

export function MenuList({ id, ariaLabel, items, focusFirst, onClose, onBack, className }: MenuListProps) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const actionable = items.flatMap((item, index) => (item.kind === "separator" ? [] : [index]));
  const [focusAt, setFocusAt] = useState<number | null>(
    focusFirst === "first" ? actionable[0]! : focusFirst === "last" ? actionable.at(-1)! : null,
  );
  const [submenu, setSubmenu] = useState<{ index: number; focus: boolean } | null>(null);
  const baseId = useId();

  useEffect(() => {
    if (focusAt !== null && !submenu?.focus) itemRefs.current[focusAt]?.focus();
  }, [focusAt, submenu]);

  const openSubmenu = (index: number, focus: boolean) => {
    setFocusAt(index);
    setSubmenu({ index, focus });
  };

  const onKey = (event: KeyboardEvent) => {
    // Keys pressed inside an open submenu are its own.
    const current = itemRefs.current.indexOf(event.target as HTMLButtonElement);
    if (current === -1) return;
    const at = actionable.indexOf(current);
    const item = items[current];
    const to =
      event.key === "ArrowDown"
        ? actionable[(at + 1) % actionable.length]
        : event.key === "ArrowUp"
          ? actionable[(at - 1 + actionable.length) % actionable.length]
          : event.key === "Home"
            ? actionable[0]
            : event.key === "End"
              ? actionable.at(-1)
              : undefined;
    if (to !== undefined) {
      event.preventDefault();
      setSubmenu(null);
      setFocusAt(to);
    } else if (item?.kind === "submenu" && (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openSubmenu(current, true);
    } else if (onBack && (event.key === "ArrowLeft" || event.key === "Escape")) {
      event.preventDefault();
      event.stopPropagation();
      onBack();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose(true);
    } else if (event.key === "Tab") {
      onClose(false);
    }
  };

  return (
    <div role="menu" id={id} aria-label={ariaLabel} className={className} onKeyDown={onKey}>
      {items.map((item, index) => {
        if (item.kind === "separator") return <div key={item.id} role="separator" className="menu-separator" />;
        const ref = (element: HTMLButtonElement | null) => {
          itemRefs.current[index] = element;
        };
        // An item without an icon, such as each Widget in the Grid menu, keeps no space for one before its label.
        const icon = item.icon !== undefined && (
          <span className="menu-icon" aria-hidden>
            {item.icon}
          </span>
        );
        if (item.kind === "submenu") {
          const expanded = submenu?.index === index;
          const subId = `${baseId}-${item.id}`;
          return (
            <div
              key={item.id}
              className="menu-submenu-anchor"
              onPointerEnter={(event) => event.pointerType === "mouse" && openSubmenu(index, false)}
              onPointerLeave={(event) => event.pointerType === "mouse" && !submenu?.focus && setSubmenu(null)}
            >
              <button
                ref={ref}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={expanded}
                aria-controls={expanded ? subId : undefined}
                tabIndex={-1}
                className="menu-item"
                onClick={() => openSubmenu(index, true)}
              >
                {icon}
                <span className="menu-label">{item.label}</span>
                <ChevronRight size={16} aria-hidden />
              </button>
              {expanded && (
                <MenuList
                  id={subId}
                  ariaLabel={item.label}
                  items={item.items}
                  focusFirst={submenu.focus ? "first" : null}
                  onClose={onClose}
                  onBack={() => {
                    setSubmenu(null);
                    itemRefs.current[index]?.focus();
                  }}
                  className="menu-list menu-submenu"
                />
              )}
            </div>
          );
        }
        const checkable = item.kind === "choice" || item.kind === "checkbox";
        const disabled = item.kind === "action" && item.disabled === true;
        const shortcut = item.kind === "action" ? item.shortcut : undefined;
        const note = item.kind === "checkbox" ? item.note : undefined;
        const description = item.kind === "action" ? item.description : undefined;
        const descriptionId = `${id}-${item.id}-description`;
        const kind = item.kind === "action" ? item.trackKind : undefined;
        return (
          <button
            key={item.id}
            ref={ref}
            type="button"
            role={item.kind === "choice" ? "menuitemradio" : item.kind === "checkbox" ? "menuitemcheckbox" : "menuitem"}
            aria-checked={checkable ? item.checked : undefined}
            aria-disabled={disabled || undefined}
            aria-keyshortcuts={shortcut?.replace("Ctrl", "Control")}
            aria-label={description ? item.label : undefined}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
            className={kind ? "menu-item kind-stripe" : "menu-item"}
            data-track-kind={kind}
            onPointerEnter={() => setSubmenu(null)}
            onClick={() => {
              if (disabled) return;
              if (item.kind === "checkbox") {
                setFocusAt(index);
                item.onToggle();
                return;
              }
              // Focus goes back to the button, so a dialog the item opens hands it back there too.
              onClose(true);
              item.onSelect();
            }}
          >
            {icon}
            <span className="menu-label">
              {item.label}
              {description && (
                <span id={descriptionId} className="menu-description">
                  {description}
                </span>
              )}
            </span>
            {shortcut && (
              <kbd className="menu-shortcut" aria-hidden>
                {shortcut}
              </kbd>
            )}
            {note && <span className="menu-shortcut">{` (${note})`}</span>}
            {checkable && item.checked && <Check size={16} aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
