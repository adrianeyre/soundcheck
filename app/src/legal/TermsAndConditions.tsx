import { REPOSITORY_URL } from "./links";

/** The Terms and Conditions' text, shown in their dialog. */
export function TermsAndConditions() {
  return (
    <>
      <p className="policy-updated">Last updated: October 2026</p>

      <h3>About these terms</h3>
      <p>
        These terms apply when you use Soundcheck, the Desktop App or the Browser Version. By using it you agree to
        them. If you don&apos;t agree, please don&apos;t use the app.
      </p>

      <h3>The licence</h3>
      <p>
        Soundcheck is free software under the{" "}
        <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noopener noreferrer">
          GNU General Public License, version 3 or later (opens in a new tab)
        </a>
        . You may run, study, share and change it under that licence, which takes precedence over these terms
        wherever the two differ. The work of others it is built on is listed, with its own licences, in Credits.
      </p>

      <h3>Your music</h3>
      <p>
        What you make with Soundcheck is yours. We claim no rights in your Projects, recordings or exports. You are
        responsible for having the right to use any audio, samples or Plugins you bring into the app, and for how
        you use and share what you make.
      </p>

      <h3>The Assistant</h3>
      <ul>
        <li>
          The Assistant works through a provider you choose, with your own key. Your use of that provider, and
          anything it charges, is between you and them, under their terms.
        </li>
        <li>
          Its suggestions and edits come from an AI model and can be wrong or unexpected. Check what it does: every
          change it makes can be undone.
        </li>
      </ul>

      <h3>Plugins and models</h3>
      <p>
        Plugins and the Stem Separation model are made by others and run on your own machine. Install only those
        you trust and are licensed to use. The htdemucs model&apos;s weights are for research and personal use
        only.
      </p>

      <h3>Live Sessions</h3>
      <p>
        Anyone with a Live Session&apos;s invite link can join it and change the song, so share the link only with
        people you trust. Don&apos;t use a Relay to send anything unlawful, or to disrupt it for others.
      </p>

      <h3>No warranty</h3>
      <p>
        Soundcheck is provided <strong>&ldquo;as is&rdquo;</strong>, without warranty of any kind, as the licence
        says. Keep backups of your Projects: we can&apos;t promise the app is free of faults or that it will never
        lose work.
      </p>

      <h3>Limitation of liability</h3>
      <p>
        To the extent the law allows, the authors of Soundcheck are not liable for any loss or damage that comes
        from using it, or from being unable to. Nothing in these terms limits a liability that the law does not
        allow to be limited.
      </p>

      <h3>Changes to these terms</h3>
      <p>
        We may update these terms as the app changes. Any change will appear here with a revised &ldquo;last
        updated&rdquo; date.
      </p>

      <h3>Contact us</h3>
      <p>
        If you have a question about these terms, please{" "}
        <a href={`${REPOSITORY_URL}/issues`} target="_blank" rel="noopener noreferrer">
          open an issue on GitHub (opens in a new tab)
        </a>
        .
      </p>
    </>
  );
}
