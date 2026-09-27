import { REPOSITORY_URL } from "../legal/links";
import type { DesktopOnly } from "./desktop-only";

/** Where the Desktop App's installers are published. */
export const DESKTOP_APP_URL = `${REPOSITORY_URL}/releases`;

/** What only the Desktop App has, and where to get it. */
export function BrowserVersionSettings({ lacks }: { lacks: readonly DesktopOnly[] }) {
  return (
    <div className="stack">
      <ul className="desktop-only">
        {lacks.map(({ feature, detail }) => (
          <li key={feature}>
            <strong>{feature}</strong>: {detail}
          </li>
        ))}
      </ul>
      <div className="row">
        <a href={DESKTOP_APP_URL} target="_blank" rel="noopener noreferrer">
          Get the Desktop App
          <span className="visually-hidden"> (on GitHub, opens in a new tab)</span>
        </a>
      </div>
    </div>
  );
}
