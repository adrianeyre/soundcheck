import { ShieldCheck } from "lucide-react";

import { REPOSITORY_URL } from "./links";

/** The Privacy Policy's text, shown in its dialog. */
export function PrivacyPolicy() {
  return (
    <>
      <p className="policy-updated">Last updated: October 2026</p>

      <div className="status-box">
        <ShieldCheck size={20} aria-hidden />
        <p>
          <strong>In short:</strong> Soundcheck has no accounts, no analytics and no servers that keep your data.
          Your songs stay on your device unless you choose to send them somewhere.
        </p>
      </div>

      <h3>About this policy</h3>
      <p>
        This policy explains what personal data Soundcheck handles, in both the Desktop App and the Browser
        Version, where it goes and what you can do about it. The Cookie Policy lists everything the app keeps in
        local storage.
      </p>

      <h3>What stays on your device</h3>
      <ul>
        <li>
          <strong>Projects</strong> — saved only where you choose, as folders on your own disk. They are never
          uploaded and never hold your API keys.
        </li>
        <li>
          <strong>Samples, Presets and Kits</strong> — kept in the app&apos;s own library on this device.
        </li>
        <li>
          <strong>Preferences</strong> — your theme, layout and similar settings, in local storage.
        </li>
        <li>
          <strong>API keys</strong> — in your operating system&apos;s credential store in the Desktop App, and in
          the browser&apos;s local storage in the Browser Version. <strong>Forget API key</strong> in Settings
          removes them.
        </li>
        <li>
          <strong>Audio and MIDI input</strong> — what you record or play is processed on your device, and goes
          nowhere unless you send it as described below.
        </li>
      </ul>

      <h3>What leaves your device, and only when you ask</h3>
      <ul>
        <li>
          <strong>The Assistant</strong> — when you make a Request, your Request, a description of your Project
          and, if you ask the Assistant to listen, the audio it needs go to the provider you chose in Settings
          (such as Anthropic, OpenAI, Google, xAI or Meta), or to your own gateway or local server. The same goes
          for the Decision Engine and TypeSafe. They are sent with your own key, under that provider&apos;s terms
          and privacy policy, and Soundcheck never sees them.
        </li>
        <li>
          <strong>Live Sessions</strong> — the changes you make in a Live Session pass through a Relay to the
          other members. They are encrypted with a key that is only in the invite link, so the Relay can&apos;t
          read them, and it stores nothing. It does see your network address, the session&apos;s id and when and
          how much is sent, as any server you connect to does.
        </li>
        <li>
          <strong>Updates</strong> — the Desktop App asks GitHub for the latest release when you check for an
          update, or when it starts if you leave that setting on. GitHub sees your network address under its own
          privacy statement.
        </li>
        <li>
          <strong>The Browser Version</strong> — is served by GitHub Pages, which logs visits under GitHub&apos;s
          privacy statement. The app itself loads no third-party fonts, scripts or trackers.
        </li>
      </ul>

      <h3>What we don&apos;t do</h3>
      <p>
        We don&apos;t collect, sell or share your personal data, and there is <strong>no</strong> analytics,
        tracking, profiling or advertising. We don&apos;t ask for your name, email address or any account.
      </p>

      <h3>Your rights</h3>
      <p>
        Because your data is kept on your own device, you are in control of it: you can open, copy or delete your
        Projects, clear local storage through your browser or the app&apos;s data folder, and forget your keys in
        Settings. For data held by an Assistant provider, GitHub or the operator of a Relay, please use their own
        privacy controls.
      </p>

      <h3>Children</h3>
      <p>
        Soundcheck collects nothing from anyone, children included. The Assistant&apos;s providers set their own
        age limits for their services.
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
