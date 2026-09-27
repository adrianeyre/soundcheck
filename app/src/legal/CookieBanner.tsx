import { Cookie } from "lucide-react";

export interface CookieBannerProps {
  onAccept: () => void;
  onLearnMore: () => void;
}

/**
 * The notice that the app keeps a few preferences on this machine. It is a
 * labelled region rather than a dialog: nothing is blocked while it shows,
 * and it sits above the footer rather than over the page, so it never hides
 * what has focus.
 */
export function CookieBanner({ onAccept, onLearnMore }: CookieBannerProps) {
  return (
    <section className="cookie-banner" aria-label="Cookie notice">
      <Cookie size={22} aria-hidden />
      <div>
        <p>
          Soundcheck keeps a few essential and functional items in this app&apos;s local storage, such as your
          colour theme and that you have seen this notice. There are no tracking, analytics or advertising
          cookies. See the{" "}
          <button type="button" className="link-button" onClick={onLearnMore}>
            Cookie Policy
          </button>
          .
        </p>
        <div className="row">
          <button type="button" className="btn-sm" onClick={onLearnMore}>
            Learn more
          </button>
          <button type="button" className="btn-primary btn-sm" onClick={onAccept}>
            Accept
          </button>
        </div>
      </div>
    </section>
  );
}
