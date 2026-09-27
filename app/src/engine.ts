import init, { engine_version } from "@engine";

export interface Engine {
  version: string;
}

/** Load the Audio Engine's WASM build and report what was loaded. */
export async function loadEngine(): Promise<Engine> {
  await init();
  return { version: engine_version() };
}
