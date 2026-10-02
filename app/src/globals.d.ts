interface ImportMetaEnv {
  /** The repository's version, from the root `package.json`, put in by Vite. */
  readonly VITE_APP_VERSION: string;
  /** The repository's author, from the root `package.json`, put in by Vite. */
  readonly VITE_APP_AUTHOR: string;
  /** The Relay a Live Session goes through unless Settings says another, from the `RELAY_URL` variable (ADR 0012). */
  readonly VITE_RELAY_URL?: string;
  /** Where the Browser Version is served, so the Desktop App's invite links open it. */
  readonly VITE_SITE_URL?: string;
  /** This build's id, as `version.json` has it beside `index.html` (`new-deploy.ts`); only in a production build. */
  readonly VITE_BUILD_ID?: string;
}
