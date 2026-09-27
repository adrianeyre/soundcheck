import { Info } from "lucide-react";
import type { ReactNode } from "react";

import { REPOSITORY_URL } from "./links";

interface Credit {
  name: string;
  url: string;
  by: string;
  /** What Soundcheck uses it for. */
  use: ReactNode;
  licence: string;
}

/** A link out of the app, which says it opens a new tab. */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

const STEM_SEPARATION: readonly Credit[] = [
  {
    name: "Demucs",
    url: "https://github.com/facebookresearch/demucs",
    by: "Alexandre Défossez and the Demucs authors at Meta AI",
    use: (
      <>
        Its htdemucs model is what Stem Separation runs (<cite>Hybrid Transformers for Music Source
        Separation</cite>, Rouard, Massa and Défossez, ICASSP 2023).
      </>
    ),
    licence: "MIT",
  },
  {
    name: "Mixxx's ONNX export of Demucs",
    url: "https://github.com/mixxxdj/demucs",
    by: "Anmol Mishra, for Mixxx, in Google Summer of Code 2025, mentored by Jörg (JoergAtGithub) and Antoine (acolombier)",
    use: (
      <>
        Exports htdemucs as a self-contained ONNX model, with its STFT inside the graph. Its code is in
        Soundcheck&apos;s <code>tools/htdemucs-onnx/</code>, which you export the model with (
        <ExternalLink href="https://mixxx.org/news/2025-10-27-gsoc2025-demucs-to-onnx-dhunstack/">
          Mixxx&apos;s write-up
        </ExternalLink>
        ).
      </>
    ),
    licence: "MIT",
  },
  {
    name: "ONNX Runtime",
    url: "https://github.com/microsoft/onnxruntime",
    by: "Microsoft",
    use: (
      <>
        Runs the model: in the Desktop App through the <code>ort</code> crate by pyke (MIT or Apache-2.0), and
        in the Browser Version as ONNX Runtime Web.
      </>
    ),
    licence: "MIT",
  },
];

const DESKTOP_APP: readonly Credit[] = [
  {
    name: "Tauri",
    url: "https://tauri.app",
    by: "The Tauri Programme within The Commons Conservancy",
    use: "The Desktop App's window and installers, with its dialog, HTTP and updater plugins.",
    licence: "MIT or Apache-2.0",
  },
  {
    name: "cpal",
    url: "https://github.com/RustAudio/cpal",
    by: "the RustAudio contributors",
    use: "Plays and records audio on the machine's own audio driver: WASAPI, ASIO, CoreAudio, ALSA and JACK.",
    licence: "Apache-2.0",
  },
  {
    name: "midir",
    url: "https://github.com/Boddlnagg/midir",
    by: "Patrick Reisert",
    use: "Reads MIDI keyboards.",
    licence: "MIT",
  },
  {
    name: "Wasmtime",
    url: "https://wasmtime.dev",
    by: "the Bytecode Alliance",
    use: "Runs WASM Plugins.",
    licence: "Apache-2.0 with LLVM exception",
  },
  {
    name: "VST 3 SDK",
    url: "https://github.com/steinbergmedia/vst3sdk",
    by: "Steinberg Media Technologies GmbH",
    use: "The helper that hosts VST3 Plugins is built with it.",
    licence: "MIT",
  },
  {
    name: "ASIO SDK",
    url: "https://www.steinberg.net/developers/",
    by: "Steinberg Media Technologies GmbH",
    use: "Only in a Windows build with ASIO, which you make yourself: it isn't shipped with Soundcheck.",
    licence: "GPL-3.0, or Steinberg's own",
  },
];

const AUDIO_ENGINE: readonly Credit[] = [
  {
    name: "Symphonia",
    url: "https://github.com/pdeljanov/Symphonia",
    by: "Philip Deljanov and the Symphonia contributors",
    use: "Decodes the WAV, FLAC and MP3 files you import.",
    licence: "MPL-2.0",
  },
  {
    name: "rusty_mp3",
    url: "https://github.com/Remade-With-Rust/remade_ffmpeg_rs",
    by: "Mata Network",
    use: "Encodes the MP3s you export.",
    licence: "Apache-2.0",
  },
  {
    name: "wasm-bindgen",
    url: "https://github.com/wasm-bindgen/wasm-bindgen",
    by: "the wasm-bindgen contributors",
    use: "Builds the Audio Engine for the browser.",
    licence: "MIT or Apache-2.0",
  },
];

const APP: readonly Credit[] = [
  {
    name: "React",
    url: "https://react.dev",
    by: "Meta and the React contributors",
    use: "The app's user interface.",
    licence: "MIT",
  },
  {
    name: "coi-serviceworker",
    url: "https://github.com/gzuidhof/coi-serviceworker",
    by: "Guido Zuidhof and contributors",
    use: "Makes the Browser Version cross-origin isolated on GitHub Pages, so WebAssembly has threads for Stem Separation.",
    licence: "MIT",
  },
  {
    name: "Lucide",
    url: "https://lucide.dev",
    by: "the Lucide contributors",
    use: "The icons.",
    licence: "ISC",
  },
  {
    name: "Anthropic TypeScript SDK",
    url: "https://github.com/anthropics/anthropic-sdk-typescript",
    by: "Anthropic",
    use: "The Assistant's Claude provider.",
    licence: "MIT",
  },
  {
    name: "OpenAI Node.js library",
    url: "https://github.com/openai/openai-node",
    by: "OpenAI",
    use: "The Assistant's OpenAI provider.",
    licence: "Apache-2.0",
  },
  {
    name: "Google Gen AI SDK",
    url: "https://github.com/googleapis/js-genai",
    by: "Google",
    use: "The Assistant's Gemini provider.",
    licence: "Apache-2.0",
  },
];

const RELAY: readonly Credit[] = [
  {
    name: "Tokio and axum",
    url: "https://tokio.rs",
    by: "the Tokio contributors",
    use: "The Relay a Live Session goes through.",
    licence: "MIT",
  },
];

function CreditList({ credits }: { credits: readonly Credit[] }) {
  return (
    <ul>
      {credits.map((credit) => (
        <li key={credit.name}>
          <strong>
            <ExternalLink href={credit.url}>{credit.name}</ExternalLink>
          </strong>
          , by {credit.by}. {credit.use} Licence: {credit.licence}.
        </li>
      ))}
    </ul>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

/** Who made Soundcheck, and the work of others it is built on, shown in its dialog from the title menu. */
export function Credits() {
  return (
    <>
      <Section id="credits-soundcheck" title="Soundcheck">
        <p>
          <strong>Soundcheck by {import.meta.env.VITE_APP_AUTHOR}</strong>.{" "}
          <ExternalLink href={REPOSITORY_URL}>Soundcheck on GitHub</ExternalLink>. It is free software under the
          GNU General Public License, version 3 or later (GPL-3.0-or-later), and so are the Starter Kit&apos;s
          samples, which are its own work.
        </p>
      </Section>

      <Section id="credits-stems" title="Stem Separation">
        <CreditList credits={STEM_SEPARATION} />
        <div className="status-box" role="note" aria-label="The model's weights">
          <Info size={20} aria-hidden />
          <p>
            The htdemucs model&apos;s weights are Meta&apos;s, for research and personal use only. They are not
            shipped with Soundcheck: you export the model yourself, on your own machine, and install it from that
            file.
          </p>
        </div>
      </Section>

      <Section id="credits-desktop" title="The Desktop App">
        <CreditList credits={DESKTOP_APP} />
        <p>VST is a registered trademark of Steinberg Media Technologies GmbH.</p>
        <p>ASIO is a trademark and software of Steinberg Media Technologies GmbH.</p>
      </Section>

      <Section id="credits-engine" title="The Audio Engine">
        <CreditList credits={AUDIO_ENGINE} />
      </Section>

      <Section id="credits-app" title="The app and the Assistant">
        <CreditList credits={APP} />
      </Section>

      <Section id="credits-relay" title="The Relay">
        <CreditList credits={RELAY} />
      </Section>
    </>
  );
}
