import {
  AudioWaveform,
  Blocks,
  BookOpen,
  Download,
  FileAudio,
  Globe,
  KeyRound,
  Mic,
  Piano,
  RotateCcw,
  SlidersHorizontal,
  Grid3x3,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { DjTile, LiveTile, MixHelperTile, StemsTile } from "./demos/Features";
import HeroDemo, { HERO_DESCRIPTION } from "./demos/HeroDemo";
import { BROWSER_VERSION, CHANGELOG, ISSUES, LICENCE, RELEASES, REPOSITORY } from "./links";

function Logo() {
  return (
    <svg viewBox="0 0 64 64" width="28" height="28" aria-hidden>
      <defs>
        <linearGradient id="logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b7cff" />
          <stop offset="1" stopColor="#3ddc97" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#logo)" />
      <path d="M26 44V20l20-5v24" fill="none" stroke="#0b0d17" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="21" cy="44" r="6" fill="#0b0d17" />
      <circle cx="41" cy="39" r="6" fill="#0b0d17" />
      <path d="M50 10l1.6 3.4L55 15l-3.4 1.6L50 20l-1.6-3.4L45 15l3.4-1.6z" fill="#ffffff" />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function Header() {
  return (
    <header className="nav">
      <div className="nav__inner">
        <a className="nav__brand" href="./">
          <Logo />
          Soundcheck
        </a>
        <nav aria-label="Site" className="nav__links">
          <a href="#features">Features</a>
          <a href="#download">Download</a>
          <a href={`${REPOSITORY}#readme`}>Docs</a>
          <a href={REPOSITORY} className="nav__github">
            <GitHubMark />
            <span>GitHub</span>
          </a>
        </nav>
        <a className="btn btn--small" href={BROWSER_VERSION}>
          Open in browser
        </a>
      </div>
    </header>
  );
}

function Hero() {
  const [run, setRun] = useState(0);
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero__copy">
        <p className="eyebrow">Free and open source · Desktop and web</p>
        <h1 id="hero-title">
          Make music with a co&#8209;producer <span className="grad">that listens.</span>
        </h1>
        <p className="lede">
          Soundcheck is a DAW whose Assistant can edit your song and hear it. Ask for a change in words, and it makes the
          edit, renders the bars and listens back before it tells you what it did. Every change undoes.
        </p>
        <div className="cta">
          <a className="btn" href="#download">
            <Download size={18} strokeWidth={2} aria-hidden />
            Download
          </a>
          <a className="btn btn--ghost" href={BROWSER_VERSION}>
            <Globe size={18} strokeWidth={2} aria-hidden />
            Open in your browser
          </a>
        </div>
      </div>
      <figure className="hero__demo">
        <div role="img" aria-label={HERO_DESCRIPTION}>
          <HeroDemo key={run} />
        </div>
        <button type="button" className="replay" onClick={() => setRun((n) => n + 1)}>
          <RotateCcw size={14} strokeWidth={2} aria-hidden />
          Replay
        </button>
      </figure>
    </section>
  );
}

function Tile({ title, children, demo, label }: { title: string; children: ReactNode; demo: ReactNode; label: string }) {
  return (
    <article className="tile">
      <div className="tile__copy">
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
      <div className="tile__demo" role="img" aria-label={label}>
        {demo}
      </div>
    </article>
  );
}

function Features() {
  return (
    <section id="features" className="section" aria-labelledby="features-title">
      <p className="eyebrow">What it does</p>
      <h2 id="features-title">A whole studio, and an ear in it.</h2>
      <div className="tiles">
        <Tile
          title="It tells you what it hears"
          demo={<MixHelperTile />}
          label="The Mix Helper over the Master's spectrum: Kick and Bass both peak around 70 Hz; cut the Bass 3 dB there? With Apply and Not now."
        >
          The Mix Helper listens to the Master as you work and points out what a second pair of ears would: clashing low
          end, a mix that's too loud, a part that's lost. Apply it, or don't.
        </Tile>
        <Tile
          title="Split any song into Stems"
          demo={<StemsTile />}
          label="An Audio Clip of the full mix, separated into four Stems: Vocals, Drums, Bass and Other, each on its own lane."
        >
          Separate a recording into vocals, drums, bass and the rest, on your own machine, each Stem on a Track of its
          own to remix, sample or mute.
        </Tile>
        <Tile
          title="DJ with two or four Decks"
          demo={<DjTile />}
          label="The Mixer page: Deck 1 playing Night Drive and Deck 2 Low Tide, both at 124 BPM and synced, with the crossfader between them."
        >
          The Mixer page beat-matches Tracks with Sync, a crossfader, EQ and kills, and runs in the same Audio Engine as
          your song. A pad controller plays it from the keyboard.
        </Tile>
        <Tile
          title="Make music together, live"
          demo={<LiveTile />}
          label="A Live Session in Night Drive with three people: Sam has the Bass Clip in the Chorus selected and Maya the Lead Clip."
        >
          Invite someone with a link and edit one song at once, each of you with your own colour, through a small
          Relay you run or the public one.
        </Tile>
      </div>
    </section>
  );
}

const MORE: { icon: ReactNode; title: string; text: string }[] = [
  { icon: <Piano size={18} />, title: "Synth, Keys and Drum Sampler", text: "Instruments with Presets, and a kit of pads for your own samples." },
  { icon: <Grid3x3 size={18} />, title: "Step Sequencer", text: "Program drums and parts on a grid, or play them in from MIDI." },
  { icon: <Mic size={18} />, title: "Recording", text: "Record audio and MIDI on the desktop, with ASIO on Windows." },
  { icon: <SlidersHorizontal size={18} />, title: "Mixer and effects", text: "EQ, compressor, reverb, delay and more, on Tracks, Buses and the Master." },
  { icon: <Blocks size={18} />, title: "VST3 and WASM Plugins", text: "Host the VST3 Plugins you own, or write your own against the SDK." },
  { icon: <BookOpen size={18} />, title: "Skills", text: "Forty-odd recipes the Assistant follows, from a trance build-up to a vocal chain." },
  { icon: <KeyRound size={18} />, title: "Your model, your key", text: "Claude, OpenAI, Gemini or a Local model. The key stays on your machine." },
  { icon: <FileAudio size={18} />, title: "Export", text: "The song or the loop as WAV or MP3, at 44.1 or 48 kHz." },
];

function More() {
  return (
    <section className="section section--tight" aria-labelledby="more-title">
      <h2 id="more-title" className="h2--small">
        And the rest of what a DAW needs
      </h2>
      <ul className="more">
        {MORE.map((item) => (
          <li key={item.title}>
            <span className="more__icon" aria-hidden>
              {item.icon}
            </span>
            <span>
              <strong>{item.title}</strong>
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const PLATFORMS = [
  { name: "Windows", detail: "10 and 11, 64-bit · installer", primary: true },
  { name: "macOS", detail: "Apple silicon · disk image" },
  { name: "Linux", detail: "x64 · AppImage or .deb" },
];

function DownloadSection() {
  return (
    <section id="download" className="section" aria-labelledby="download-title">
      <p className="eyebrow">Download</p>
      <h2 id="download-title">Free, on every desktop. Or no install at all.</h2>
      <p className="section__lede">
        The Desktop App plays with low latency on your audio device, records, and updates itself from each release.
      </p>
      <div className="platforms">
        {PLATFORMS.map((p) => (
          <a key={p.name} className="platform" data-primary={p.primary || undefined} href={RELEASES}>
            <span className="platform__name">{p.name}</span>
            <span className="platform__detail">{p.detail}</span>
            <span className="platform__go">
              <Download size={16} strokeWidth={2} aria-hidden />
              Latest release
            </span>
          </a>
        ))}
        <a className="platform platform--web" href={BROWSER_VERSION}>
          <span className="platform__name">Browser Version</span>
          <span className="platform__detail">Chrome, Edge, Firefox, Safari</span>
          <span className="platform__go">
            <AudioWaveform size={16} strokeWidth={2} aria-hidden />
            Open it now
          </span>
        </a>
      </div>
      <p className="fine">
        The Browser Version is the lighter one: what you play is heard later, and it can't record or host VST3 Plugins.
        Everything else is the same app and the same Audio Engine.
      </p>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer__inner">
        <span className="footer__brand">
          <Logo />
          Soundcheck
        </span>
        <nav aria-label="Project" className="footer__links">
          <a href={REPOSITORY}>Source</a>
          <a href={CHANGELOG}>Changelog</a>
          <a href={ISSUES}>Report a problem</a>
          <a href={LICENCE}>Licence: GPL-3.0-or-later</a>
        </nav>
        <p className="footer__credit">
          Made by Adrian Eyre. The illustrations are drawn with{" "}
          <a href="https://github.com/benjitaylor/skills/tree/main/stageshow">Stageshow</a> (MIT).
        </p>
      </div>
    </footer>
  );
}

export function App() {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main">
        <Hero />
        <Features />
        <More />
        <DownloadSection />
      </main>
      <Footer />
    </>
  );
}
