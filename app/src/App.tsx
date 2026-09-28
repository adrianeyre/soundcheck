import { Award, Cookie, Disc3, LayoutGrid, Music, PersonStanding, RotateCcw, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { renderOffline } from "./audio/offline-render";
import { loadEngine } from "./engine";
import { PAGE_WIDGETS, setWidgetHidden, type WidgetId } from "./grid/layout";
import { useWidgetLayout } from "./grid/useWidgetLayout";
import { AccessibilityStatement } from "./legal/AccessibilityStatement";
import { acknowledgeCookies, hasAcknowledgedCookies } from "./legal/consent";
import { CookieBanner } from "./legal/CookieBanner";
import { CookiePolicy } from "./legal/CookiePolicy";
import { Credits } from "./legal/Credits";
import { REPOSITORY_URL } from "./legal/links";
import { currentPlatform } from "./platform";
import { PresetLibraryProvider } from "./preset/PresetLibraryProvider";
import { desktopOnly } from "./settings/desktop-only";
import { applyPalette, applyTheme, readPalette, readThemePreference } from "./settings/theme";
import { SongPage, type SongView } from "./song/SongPage";
import { Dialog } from "./ui/Dialog";
import { Logo } from "./ui/Logo";
import type { MenuItem } from "./ui/Menu";

/** The dialogs about the app itself. */
type Policy = "cookies" | "accessibility" | "credits";

const VIEW_NAMES: Record<SongView, string> = { editor: "Editor", mixing: "Mixer", settings: "Settings" };

/** The page the address asks for, so Settings can be linked to directly. */
function viewFromHash(): SongView {
  if (typeof location === "undefined") return "editor";
  if (location.hash === "#settings") return "settings";
  return location.hash === "#mixing" ? "mixing" : "editor";
}

export function App() {
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<SongView>(viewFromHash);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [cookieNotice, setCookieNotice] = useState(() => !hasAcknowledgedCookies());
  const [platform] = useState(currentPlatform);
  // Each page with a Grid keeps its own layout; the Grid menu shows the open page's.
  const editorGrid = useWidgetLayout("editor");
  const mixingGrid = useWidgetLayout("mixing");
  const gridPage = view === "mixing" ? "mixing" : view === "editor" ? "editor" : null;
  const grid = gridPage === "mixing" ? mixingGrid : editorGrid;
  // The Widgets with nothing to show just now, which the Grid keeps off the page until they have something.
  const [emptyWidgets, setEmptyWidgets] = useState<readonly WidgetId[]>([]);
  const [emptyMixingWidgets, setEmptyMixingWidgets] = useState<readonly WidgetId[]>([]);
  // Where the Editor draws its pinned Widgets: flush against the title bar and the footer, outside the page that scrolls.
  const [pinnedTop, setPinnedTop] = useState<HTMLElement | null>(null);
  const [pinnedBottom, setPinnedBottom] = useState<HTMLElement | null>(null);
  // Where the Editor draws the menu and the Project's name, at the start of the title bar.
  const [headerStart, setHeaderStart] = useState<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const firstView = useRef(true);

  useEffect(() => {
    // Loaded up front, so the first sound needn't wait for it. The footer gives the version.
    loadEngine().catch((reason: unknown) => setError(String(reason)));
  }, []);

  // The theme and palette chosen last time; `index.html` already painted them, and "system" follows the OS from here.
  useEffect(() => {
    applyTheme(readThemePreference());
    applyPalette(readPalette());
  }, []);

  // The address follows the page, and the back button moves between pages.
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    document.title = `${VIEW_NAMES[view]} — Soundcheck`;
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    // A new page: a screen reader starts reading it from the top.
    mainRef.current?.scrollTo?.({ top: 0 });
    mainRef.current?.focus();
  }, [view]);

  const go = (next: SongView) => {
    if (next === view) return;
    if (location.hash !== `#${next}`) history.pushState(null, "", `#${next}`);
    setView(next);
  };

  /** The Grid menu for `page`: a checkbox for each of its Widgets, and Reset layout. */
  const gridMenu = (page: "editor" | "mixing"): MenuItem => {
    const empty = page === "mixing" ? emptyMixingWidgets : emptyWidgets;
    return {
      kind: "submenu",
      id: "grid",
      label: "Grid",
      icon: <LayoutGrid size={16} />,
      items: [
        ...PAGE_WIDGETS[page].map((widget) => ({
          kind: "checkbox" as const,
          id: widget.id,
          label: widget.title,
          checked: !grid.layout[widget.id].hidden,
          note: empty.includes(widget.id) ? "empty" : undefined,
          onToggle: () => grid.setLayout(setWidgetHidden(grid.layout, widget.id, !grid.layout[widget.id].hidden)),
        })),
        { kind: "separator", id: "reset-separator" },
        {
          kind: "action",
          id: "reset",
          label: "Reset layout",
          icon: <RotateCcw size={16} />,
          onSelect: grid.reset,
        },
      ],
    };
  };

  const menuItems: MenuItem[] = [
    {
      kind: "choice",
      id: "editor",
      label: "Editor",
      icon: <Music size={16} />,
      checked: view === "editor",
      onSelect: () => go("editor"),
    },
    {
      kind: "choice",
      id: "mixing",
      label: "Mixer",
      icon: <Disc3 size={16} />,
      checked: view === "mixing",
      onSelect: () => go("mixing"),
    },
    {
      kind: "choice",
      id: "settings",
      label: "Settings",
      icon: <Settings size={16} />,
      checked: view === "settings",
      onSelect: () => go("settings"),
    },
    ...(gridPage ? [gridMenu(gridPage)] : []),
    { kind: "separator", id: "legal" },
    {
      kind: "action",
      id: "cookies",
      label: "Cookie Policy",
      icon: <Cookie size={16} />,
      onSelect: () => setPolicy("cookies"),
    },
    {
      kind: "action",
      id: "accessibility",
      label: "Accessibility",
      icon: <PersonStanding size={16} />,
      onSelect: () => setPolicy("accessibility"),
    },
    {
      kind: "action",
      id: "credits",
      label: "Credits",
      icon: <Award size={16} />,
      onSelect: () => setPolicy("credits"),
    },
  ];

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div ref={setHeaderStart} className="header-start" />
        <div className="brand">
          <Logo className="brand-mark" />
          <span>Soundcheck</span>
        </div>
        <div className="header-end">
          {error && (
            <p className="alert header-alert" role="alert">
              Audio Engine failed to load: {error}
            </p>
          )}
        </div>
      </header>

      <div ref={setPinnedTop} className="pinned-slot" />

      <main id="main" ref={mainRef} tabIndex={-1} className="app-main">
        <PresetLibraryProvider storage={platform.library}>
          <SongPage
            view={view}
            onView={go}
            header={headerStart}
            menu={{
              ariaLabel: `Menu, ${VIEW_NAMES[view]}`,
              label: (
                <>
                  {view === "editor" ? (
                    <Music size={16} aria-hidden />
                  ) : view === "mixing" ? (
                    <Disc3 size={16} aria-hidden />
                  ) : (
                    <Settings size={16} aria-hidden />
                  )}
                  {VIEW_NAMES[view]}
                </>
              ),
              items: menuItems,
            }}
            grid={{
              layout: editorGrid.layout,
              onLayout: editorGrid.setLayout,
              // Only the open page's pinned Widgets are drawn in the slots by the title bar and the footer.
              pinned: view === "editor" ? { top: pinnedTop, bottom: pinnedBottom } : undefined,
              onEmpty: setEmptyWidgets,
            }}
            mixingGrid={{
              layout: mixingGrid.layout,
              onLayout: mixingGrid.setLayout,
              pinned: view === "mixing" ? { top: pinnedTop, bottom: pinnedBottom } : undefined,
              onEmpty: setEmptyMixingWidgets,
            }}
            openOutput={platform.openOutput}
            openMidi={platform.openMidi}
            storage={platform.storage}
            exporter={platform.exporter}
            djRecordings={platform.djRecordings}
            headphones={platform.headphones}
            stems={platform.stems}
            updater={platform.updater}
            keyStore={platform.keyStore}
            fetch={platform.fetch}
            analyseAudio={platform.analyseAudio}
            audioInputs={platform.audioInputs}
            samples={platform.samples}
            reference={platform.reference}
            library={platform.library}
            plugins={platform.plugins}
            vst3={platform.vst3}
            vst3Unavailable={platform.vst3Unavailable}
            inviteSite={platform.inviteSite}
            audioDevice={
              platform.bufferSizes && platform.listAudioHosts
                ? { bufferSizes: platform.bufferSizes, listAudioHosts: platform.listAudioHosts }
                : undefined
            }
            desktopOnly={desktopOnly(platform)}
            latencyTest={{
              renderOffline,
              bufferSizes: platform.bufferSizes,
              listAudioHosts: platform.listAudioHosts,
            }}
            onShowCookiePolicy={() => setPolicy("cookies")}
            onShowAccessibility={() => setPolicy("accessibility")}
          />
        </PresetLibraryProvider>
      </main>

      {cookieNotice && (
        <CookieBanner
          onAccept={() => {
            acknowledgeCookies();
            setCookieNotice(false);
          }}
          onLearnMore={() => setPolicy("cookies")}
        />
      )}

      <div ref={setPinnedBottom} className="pinned-slot" />

      <footer className="app-footer">
        <nav aria-label="About this app">
          <a className="footer-link" href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer">
            <GitHubMark />
            Website design
            <span className="visually-hidden"> (source on GitHub, opens in a new tab)</span>
          </a>
          <span className="num">Version: {import.meta.env.VITE_APP_VERSION}</span>
          <button type="button" className="link-button" onClick={() => setPolicy("cookies")}>
            Cookie Policy
          </button>
          <button type="button" className="link-button" onClick={() => setPolicy("accessibility")}>
            Accessibility
          </button>
        </nav>
      </footer>

      <Dialog
        open={policy === "cookies"}
        onClose={() => setPolicy(null)}
        title="Cookie Policy"
        closeLabel="Close cookie policy"
      >
        <CookiePolicy />
      </Dialog>
      <Dialog
        open={policy === "accessibility"}
        onClose={() => setPolicy(null)}
        title="Accessibility"
        closeLabel="Close accessibility statement"
      >
        <AccessibilityStatement />
      </Dialog>
      <Dialog open={policy === "credits"} onClose={() => setPolicy(null)} title="Credits" closeLabel="Close credits">
        <Credits />
      </Dialog>
    </div>
  );
}

/** GitHub's mark, as GitHub publishes it for linking to a repository. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden focusable="false">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.42c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.36-3.88-1.36-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.79 2.73 1.27 3.4.97.1-.76.41-1.27.74-1.56-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.2-3.1-.12-.29-.52-1.46.11-3.05 0 0 .98-.31 3.2 1.18a11.1 11.1 0 0 1 5.82 0c2.22-1.5 3.2-1.18 3.2-1.18.63 1.59.23 2.76.11 3.05.75.81 1.2 1.84 1.2 3.1 0 4.43-2.7 5.41-5.26 5.69.42.36.8 1.08.8 2.18v3.23c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z" />
    </svg>
  );
}
