import { BROWSER_KEY } from "../assistant/key-store";
import { GRID_KEY, gridKey } from "../grid/layout";
import { HEADPHONES_KEY } from "../dj/HeadphonePicker";
import { OFFSET_KEY } from "../song/AudioRecordPanel";
import { PALETTE_KEY, THEME_KEY } from "../settings/theme";
import { CONSENT_KEY } from "./consent";
import { REPOSITORY_URL } from "./links";

/** Everything the app keeps in local storage, and why. */
const STORED = [
  {
    name: CONSENT_KEY,
    type: "Essential",
    purpose: "Remembers that you have seen the cookie notice, so it isn't shown again.",
  },
  {
    name: THEME_KEY,
    type: "Functional",
    purpose: "Remembers your colour theme: dark, light or matching your system.",
  },
  {
    name: PALETTE_KEY,
    type: "Functional",
    purpose: "Remembers your colour palette, the accent colour the app is drawn in.",
  },
  {
    name: GRID_KEY,
    type: "Functional",
    purpose: "Remembers where you put the Editor's widgets, their sizes, which are pinned and which are hidden.",
  },
  {
    name: gridKey("mixing"),
    type: "Functional",
    purpose:
      "Remembers the same for the Mixer page's widgets: the waveforms, the Decks, the mixer, the Track browsers and the Pad Controller.",
  },
  {
    name: gridKey("pads"),
    type: "Functional",
    purpose: "Remembers the same for the Pads page's widgets: the Pad Controller and its Track browser.",
  },
  {
    name: HEADPHONES_KEY,
    type: "Functional",
    purpose: "Remembers which audio device the Mixer page's headphone cue plays out of.",
  },
  {
    name: OFFSET_KEY,
    type: "Functional",
    purpose: "Remembers the recording offset you measured with a loopback cable, so takes land in time.",
  },
  {
    name: BROWSER_KEY,
    type: "Essential",
    purpose:
      "In the Browser Version only: your Assistant connection (provider, API key, model and gateway), so you needn't enter it each time. The Desktop App keeps it in your operating system's credential store instead.",
  },
] as const;

/** The Cookie Policy's text, shown in its dialog. */
export function CookiePolicy() {
  return (
    <>
      <p className="policy-updated">Last updated: September 2026</p>

      <h3>About this policy</h3>
      <p>
        This policy explains how Soundcheck uses cookies and similar technologies, such as the local storage of
        the app&apos;s window. Cookies and local storage are small pieces of data saved on your device that help
        an app work and remember your choices.
      </p>

      <h3>How we use them</h3>
      <p>
        Soundcheck sets <strong>no cookies</strong> and uses only <strong>essential</strong> and{" "}
        <strong>functional</strong> local storage. There are <strong>no</strong> analytics, tracking, profiling or
        advertising technologies, and nothing is shared with anyone for marketing.
      </p>

      <h3>What we store</h3>
      <div className="table-scroll" tabIndex={0} role="group" aria-labelledby="cookie-table-caption">
        <table>
          <caption id="cookie-table-caption">Items Soundcheck may save in local storage on this device.</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Purpose</th>
              <th scope="col">Expiry</th>
            </tr>
          </thead>
          <tbody>
            {STORED.map((item) => (
              <tr key={item.name}>
                <td>
                  <code>{item.name}</code>
                </td>
                <td>{item.type}</td>
                <td>{item.purpose}</td>
                <td>Until you clear it</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Your songs</h3>
      <p>
        Projects are saved only where you choose, as folders on your own disk. They are never uploaded and never
        hold your API keys.
      </p>
      <p>
        The samples you put in the Sampler&apos;s slots, with their names and settings, are kept in the app&apos;s
        own library (the app&apos;s data folder on the desktop, the browser&apos;s IndexedDB in the Browser Version),
        with your saved Presets and Kits, so they are there next time. They never leave your device.
      </p>

      <h3>Third-party services</h3>
      <p>
        Soundcheck loads no third-party fonts, scripts or trackers. The only time it contacts anyone is when you
        make a Request of the Assistant: your Request and a description of your Project go to the provider you
        chose in Settings (Anthropic, OpenAI, Google, or your own local server), using your key, under that
        provider&apos;s own terms and privacy policy.
      </p>

      <h3>Managing cookies and storage</h3>
      <p>
        You can clear local storage at any time through your browser&apos;s settings, and <strong>Forget API
        key</strong> in Settings removes your Assistant connection from wherever it is kept. Clearing functional
        storage won&apos;t stop the app working, but your preferences won&apos;t be remembered.
      </p>

      <h3>Changes to this policy</h3>
      <p>
        We may update this policy as the app changes. Any change will appear here with a revised &ldquo;last
        updated&rdquo; date.
      </p>

      <h3>Contact us</h3>
      <p>
        If you have a question about this policy, please{" "}
        <a href={`${REPOSITORY_URL}/issues`} target="_blank" rel="noopener noreferrer">
          open an issue on GitHub (opens in a new tab)
        </a>
        .
      </p>
    </>
  );
}
