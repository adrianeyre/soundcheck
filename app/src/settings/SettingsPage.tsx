import { AudioLines, Download, Gauge, Globe, Palette, PersonStanding, Plug, Puzzle, Sparkles, Users } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";

import { AppearanceSettings } from "./AppearanceSettings";

export interface SettingsPageProps {
  /** What only the Desktop App has; absent in the Desktop App itself. */
  browserVersion?: ReactNode;
  /** The Assistant's connection; absent where there is no key store. */
  assistant?: ReactNode;
  /** The audio host and buffer size; absent where the platform doesn't let you choose. */
  audio?: ReactNode;
  /** The installed WASM Plugins; absent where there is no Plugins folder. */
  plugins?: ReactNode;
  /** The VST3 Plugins installed on this machine; absent where they can't be hosted (the Browser Version). */
  vst3?: ReactNode;
  /** Your name, as Collaborators on a Shared Project see it. */
  collaboration?: ReactNode;
  /** The latency test, where the platform offers it. */
  diagnostics?: ReactNode;
  /** The version running, and installing a newer one; absent where there is nothing to install. */
  updates?: ReactNode;
  onShowCookiePolicy?: () => void;
  onShowAccessibility?: () => void;
}

/** A section, or what `&&` leaves when its platform part is absent. */
type Maybe<T> = T | false | null | undefined | "" | 0 | 0n;

interface Section {
  id: string;
  title: string;
  lead: string;
  icon: typeof Sparkles;
  body: ReactNode;
}

/**
 * Everything that isn't making music or the Project's file (which is the
 * File menu's): in the Browser Version, what only the Desktop App has; the
 * Assistant's connection, the audio device, Plugins, VST3 Plugins,
 * collaboration, appearance, diagnostics and, in the Desktop App, updates.
 * Each section is a labelled region, listed at the side so it can be jumped
 * to, and the one being read is marked there.
 */
export function SettingsPage(props: SettingsPageProps) {
  const listed: Maybe<Section>[] = [
    props.browserVersion && {
      id: "settings-browser-version",
      title: "Browser version",
      lead: "This is the lighter version of Soundcheck, with nothing to install. The Desktop App has everything it has, and these too.",
      icon: Globe,
      body: props.browserVersion,
    },
    props.assistant && {
      id: "settings-assistant",
      title: "Assistant",
      lead: "The AI model the Assistant talks to, and how it reaches it.",
      icon: Sparkles,
      body: props.assistant,
    },
    props.audio && {
      id: "settings-audio",
      title: "Audio",
      lead: "The audio host and buffer size the song plays through. Smaller buffers are heard sooner, but need more of the machine.",
      icon: AudioLines,
      body: props.audio,
    },
    props.plugins && {
      id: "settings-plugins",
      title: "Plugins",
      lead: "WASM Plugin Effects and Instruments, installed once for every Project.",
      icon: Puzzle,
      body: props.plugins,
    },
    props.vst3 && {
      id: "settings-vst3",
      title: "VST3 Plugins",
      lead: "The Effects and Instruments installed on this machine for other music software. Each one runs in a process of its own, so one that crashes stops only itself.",
      icon: Plug,
      body: props.vst3,
    },
    props.collaboration && {
      id: "settings-collaboration",
      title: "Collaboration",
      lead: "Share a Project from the File menu, into a folder your Collaborators sync or share, or start a Live Session and send them its link. Each of you edits it at once.",
      icon: Users,
      body: props.collaboration,
    },
    {
      id: "settings-appearance",
      title: "Appearance",
      lead: "The theme, and a colour palette for the backgrounds, the accent, the logo and the backdrop. Every combination meets the same contrast standard.",
      icon: Palette,
      body: <AppearanceSettings />,
    },
    props.diagnostics && {
      id: "settings-diagnostics",
      title: "Diagnostics",
      lead: "Measure how quickly this machine plays what you play.",
      icon: Gauge,
      body: props.diagnostics,
    },
    props.updates && {
      id: "settings-updates",
      title: "Updates",
      lead: "The version you have, and installing a newer one from Soundcheck's releases.",
      icon: Download,
      body: props.updates,
    },
    (props.onShowCookiePolicy || props.onShowAccessibility) && {
      id: "settings-privacy",
      title: "Privacy and accessibility",
      lead: "What the app keeps on this machine, and how it is built to be usable by everyone.",
      icon: PersonStanding,
      body: (
        <div className="row">
          {props.onShowCookiePolicy && (
            <button type="button" onClick={props.onShowCookiePolicy}>
              Cookie Policy
            </button>
          )}
          {props.onShowAccessibility && (
            <button type="button" onClick={props.onShowAccessibility}>
              Accessibility statement
            </button>
          )}
        </div>
      ),
    },
  ];
  const sections = listed.filter((section): section is Section => Boolean(section));
  const root = useRef<HTMLDivElement>(null);
  const [current, jumpedTo] = useCurrentSection(root, sections.map((section) => section.id).join(" "));

  return (
    <div className="settings" ref={root}>
      <nav className="settings-nav" aria-label="Settings sections">
        <ul>
          {sections.map(({ id, title, icon: Icon }) => (
            <li key={id}>
              <a
                href={`#${id}`}
                aria-current={id === current ? "location" : undefined}
                onClick={(event) => {
                  // Jump without changing the page's own address, and take focus along.
                  event.preventDefault();
                  jumpedTo(id);
                  const target = document.getElementById(id);
                  target?.scrollIntoView({ block: "start" });
                  target?.focus({ preventScroll: true });
                }}
              >
                <Icon size={16} aria-hidden />
                {title}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-sections">
        {sections.map(({ id, title, lead, icon: Icon, body }) => (
          <section key={id} id={id} tabIndex={-1} className="panel" aria-labelledby={`${id}-heading`}>
            <div className="panel-head">
              <h2 id={`${id}-heading`}>
                <Icon size={18} aria-hidden />
                {title}
              </h2>
            </div>
            <p className="hint settings-lead">{lead}</p>
            {body}
          </section>
        ))}
      </div>
    </div>
  );
}

/** How far below the top of the view a section's top can be and still be the one being read. */
const READING_LINE = 80;

/**
 * The id of the section being read, out of `ids` (space-separated, so the same
 * sections in a new array change nothing): the last whose top has scrolled up
 * to the reading line, or the last of all once the page is scrolled to its
 * end, since a short last section never reaches the line. One jumped to from
 * the nav stays marked while it is in view, though near the end another
 * would be. Worked out again whenever the page is shown, since it may be
 * drawn hidden.
 */
function useCurrentSection(root: RefObject<HTMLElement | null>, ids: string): [string | undefined, (id: string) => void] {
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const jumped = useRef<string | null>(null);

  useEffect(() => {
    const scroller = scrollParent(root.current);
    const box = scroller ?? document.documentElement;
    const update = () => {
      const sections = ids
        .split(" ")
        .map((id) => document.getElementById(id))
        .filter((section) => section !== null);
      if (sections.length === 0) return;
      const top = scroller ? scroller.getBoundingClientRect().top : 0;
      const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
      const kept = sections.find((section) => section.id === jumped.current);
      const keptTop = kept?.getBoundingClientRect().top;
      if (kept && keptTop! >= top - 1 && keptTop! < bottom) return setCurrent(kept.id);
      jumped.current = null;
      const atEnd = box.scrollHeight > box.clientHeight && box.scrollTop + box.clientHeight >= box.scrollHeight - 1;
      const reached = sections.filter((section) => section.getBoundingClientRect().top <= top + READING_LINE);
      setCurrent((atEnd ? sections.at(-1) : (reached.at(-1) ?? sections[0]))!.id);
    };
    update();
    const target = scroller ?? window;
    target.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const shown = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (root.current) shown?.observe(root.current);
    return () => {
      target.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      shown?.disconnect();
    };
  }, [root, ids]);

  const jumpedTo = (id: string) => {
    jumped.current = id;
    setCurrent(id);
  };
  return [current, jumpedTo];
}

/** The nearest ancestor that scrolls, or null when it is the page itself. */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let parent = element?.parentElement ?? null; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}
