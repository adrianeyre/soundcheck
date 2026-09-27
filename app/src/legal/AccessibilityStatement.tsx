import { ShieldCheck } from "lucide-react";

import { REPOSITORY_URL } from "./links";

/** The accessibility statement's text, shown in its dialog. */
export function AccessibilityStatement() {
  return (
    <>
      <p className="policy-updated">Last reviewed: September 2026</p>

      <div className="status-box">
        <ShieldCheck size={20} aria-hidden />
        <p>
          <strong>Conformance status:</strong> Soundcheck is built to meet the Web Content Accessibility
          Guidelines (WCAG) 2.2 at <strong>Level AA</strong>.
        </p>
      </div>

      <h3>Our commitment</h3>
      <p>
        Soundcheck should be usable by every musician, including people who use a screen reader, magnification,
        speech input or a keyboard on its own, and people who need reduced motion or higher contrast.
      </p>

      <h3>What we have done</h3>
      <ul>
        <li>
          <strong>Keyboard access</strong> — every control, menu and dialog can be reached and operated with a
          keyboard alone, with a clear, high-contrast focus outline. On the Timeline, the arrow keys move the
          selected Clip, Shift+arrow trims its end, Alt+arrow trims its start, Ctrl+D copies it and Delete removes
          it. Ctrl+S saves the Project from anywhere.
        </li>
        <li>
          <strong>No dragging required</strong> — anything done by dragging can also be done with single clicks or
          by typing: the selected Clip&apos;s start, length and Track can be set in the Timeline&apos;s Clip
          fields, and the loop region in the transport bar.
        </li>
        <li>
          <strong>Screen readers</strong> — one heading per page, labelled landmarks and regions, a labelled
          control for every setting, level meters that announce their reading in decibels, and changes such as
          what the Assistant did announced as they happen. The playback position is left out of announcements so
          it doesn&apos;t talk over the music.
        </li>
        <li>
          <strong>Colour and contrast</strong> — text meets at least 4.5:1 against its background in both the dark
          and light themes, and control borders, icons and focus outlines at least 3:1. Nothing is shown by colour
          alone: pressed buttons, active steps and clipping meters change shape or outline as well.
        </li>
        <li>
          <strong>Themes</strong> — dark, light, or matching your system, in Settings. High-contrast and Windows
          Contrast Themes are respected.
        </li>
        <li>
          <strong>Motion</strong> — animations are short and purposeful, and all of them are switched off if your
          device is set to reduce motion.
        </li>
        <li>
          <strong>Target sizes</strong> — every control is at least 24 by 24 pixels, and the main actions 36 to 44
          pixels.
        </li>
        <li>
          <strong>Zoom and reflow</strong> — the app reflows to a single column and stays usable at 400% zoom
          without scrolling in two directions, apart from the Timeline, Step Sequencer and Mixer, whose content is
          two-dimensional by nature.
        </li>
        <li>
          <strong>Playing notes</strong> — the computer keyboard plays notes only when you aren&apos;t typing in a
          field, so it never gets in the way of filling one in.
        </li>
      </ul>

      <h3>Compatibility</h3>
      <p>
        Soundcheck is designed for the Desktop App on Windows, with the Browser Version in current Chrome and
        Edge, used with screen readers such as NVDA, JAWS and Narrator.
      </p>

      <h3>Known limitations</h3>
      <ul>
        <li>
          This statement is based on our own testing with automated checks, keyboard-only use and screen readers.
          There has not yet been an independent audit.
        </li>
        <li>
          Music is sound: the meters, waveforms and note thumbnails describe it visually, but listening to a mix
          is, by its nature, not something the app can replace.
        </li>
        <li>
          The Assistant&apos;s replies come from the provider you choose, and their wording is outside our
          control.
        </li>
      </ul>

      <h3>If something does not work for you</h3>
      <p>
        Please tell us — we would rather hear about a problem than leave it in place.{" "}
        <a href={`${REPOSITORY_URL}/issues`} target="_blank" rel="noopener noreferrer">
          Open an issue on GitHub (opens in a new tab)
        </a>{" "}
        with the screen or feature, what you were trying to do, and the assistive technology you were using.
      </p>
    </>
  );
}
