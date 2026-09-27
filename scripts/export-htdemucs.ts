/**
 * Export `htdemucs.onnx`, the model Stem Separation installs, with the code
 * in `tools/htdemucs-onnx/` (its README says what it does and whose it is):
 *
 *   pnpm htdemucs:export            # into the repo's model/, where the apps look first
 *   pnpm htdemucs:export <folder>   # anywhere else
 *
 * It runs `export.ps1` on Windows and `export.sh` elsewhere, which need
 * Python; nothing in `pnpm lint`, `test` or `build` does.
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repo's `model/`, gitignored, where the Desktop App and `pnpm dev` look for the model first. */
export const MODEL_FOLDER = fileURLToPath(new URL("../model/", import.meta.url));

/**
 * The folder `folder` names, from `cwd`. A leading `~` is the home folder:
 * a Unix shell expands it before pnpm sees it, but PowerShell and cmd pass it
 * on as it is, and without this `~/Models` became a folder named `~` in the
 * repo. `paths` are this platform's rules unless a test names another's.
 */
export function outputFolder(folder: string, cwd: string, home: string, paths: path.PlatformPath = path): string {
  const tilde = paths.sep === "\\" ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/;
  return paths.resolve(cwd, tilde.test(folder) ? folder.replace(tilde, () => home) : folder);
}

if (import.meta.main) {
  const tool = fileURLToPath(new URL("../tools/htdemucs-onnx/", import.meta.url));
  const [folder, ...rest] = process.argv.slice(2);
  if (rest.length > 0) {
    console.error("usage: pnpm htdemucs:export [folder to write htdemucs.onnx to, the repo's model/ if none]");
    process.exit(2);
  }
  // pnpm runs a script from the repo's root, so a relative folder is the musician's own.
  const out = folder ? outputFolder(folder, process.env.INIT_CWD ?? process.cwd(), homedir()) : MODEL_FOLDER;
  const [command, args] =
    process.platform === "win32"
      ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${tool}export.ps1`, out]]
      : ["sh", [`${tool}export.sh`, out]];
  const { status, error } = spawnSync(command, args, { stdio: "inherit" });
  if (error) console.error(`${command} couldn't be run: ${error.message}`);
  process.exit(status ?? 1);
}
