import { RefreshCw } from "lucide-react";

import { type NewDeploy, useNewDeploy } from "./new-deploy";

/**
 * The notice that the Browser Version was updated while this page was open
 * (`new-deploy.ts`): reload to use the new one. Where a file of this build
 * has already failed to load, it says that is why. Like the Desktop App's
 * update notice, it is a labelled region, not a dialog.
 */
export function NewDeployNotice({ deploy: given }: { deploy?: NewDeploy }) {
  const own = useNewDeploy({ build: import.meta.env.VITE_BUILD_ID, enabled: given === undefined });
  const deploy = given ?? own;
  if (!deploy.newer && !deploy.broken) return null;
  const version = deploy.newer?.version;
  return (
    <section className="notice update-notice" aria-label="New version">
      <RefreshCw size={18} aria-hidden />
      <span>
        {deploy.broken
          ? `Soundcheck${version ? ` ${version}` : ""} was released while this page was open, and part of the old version is no longer on the site, so something didn't load. Reload to use the new version. Save your Project first if you have unsaved changes.`
          : `Soundcheck${version ? ` ${version}` : ""} is out. Reload to use it. Save your Project first if you have unsaved changes.`}
      </span>
      <div className="row">
        <button type="button" className="btn-primary btn-sm" onClick={deploy.reload}>
          Reload
        </button>
        <button type="button" className="btn-sm" onClick={deploy.dismiss}>
          Later
        </button>
      </div>
    </section>
  );
}
