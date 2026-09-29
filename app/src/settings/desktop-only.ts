/**
 * What the Desktop App can do and the Browser Version can't (ADR 0006),
 * worked out from the platform parts the browser has no implementation of,
 * so a part that gains one stops being listed.
 */
import type { Platform } from "../platform";

/** A feature only the Desktop App has, as the Browser Version's Settings list it. */
export interface DesktopOnly {
  feature: string;
  detail: string;
}

/** The parts of a platform that say what it lacks. */
export type HasPlatformParts = Pick<Platform, "name" | "listAudioHosts" | "audioInputs" | "samples" | "storage" | "vst3" | "headphones" | "timecode">;

export function desktopOnly(platform: HasPlatformParts): DesktopOnly[] {
  if (platform.name === "desktop") return [];
  const lacks: DesktopOnly[] = [];
  if (!platform.listAudioHosts) {
    lacks.push({
      feature: "Low latency",
      detail:
        "A browser plays through your system's shared audio, so what you play is heard late: 80 ms on the Windows laptop Soundcheck was measured on. The Desktop App plays through the audio driver itself, with the audio host and buffer size yours to choose.",
    });
  }
  if (!platform.audioInputs) {
    lacks.push({
      feature: "Recording audio",
      detail: "From a microphone or any input of an audio interface, hearing it through its Effects as it records.",
    });
  }
  if (!platform.samples) {
    lacks.push({
      feature: "The sample browser",
      detail: "It lists the folders of samples on your machine, which a web page can't.",
    });
  }
  if (!platform.vst3) {
    lacks.push({
      feature: "VST3 Plugins",
      detail:
        "Effects and Instruments installed on your machine, each run in a process of its own. A Project that has them opens here too, and keeps each one exactly, but bypasses an Effect and silences an Instrument. VST is a registered trademark of Steinberg Media Technologies GmbH.",
    });
  }
  if (!platform.headphones) {
    lacks.push({
      feature: "Headphones on a second audio device",
      detail:
        "On the Mixer page, the headphone cue out of a device of its own while the mix plays out of the main one. This browser can't choose an output device; Chrome and Edge can, and outputs 3 and 4 of an audio interface work in any browser.",
    });
  }
  if (!platform.timecode) {
    lacks.push({
      feature: "Timecode vinyl (DVS)",
      detail:
        "On the Mixer page, a turntable playing a Serato, Traktor, MixVibes or rekordbox control record moves a Deck, in REL or ABS, through a pair of an audio interface's inputs. A web page here has no audio input to read it from.",
    });
  }
  if (!platform.storage) {
    lacks.push({
      feature: "Project folders",
      detail: "Opening and saving a Project as a folder on your machine. This browser can't; the Browser Version can in Chrome and Edge.",
    });
  }
  lacks.push({
    feature: "Your system's credential store",
    detail:
      "The Desktop App keeps the Assistant's API key in it. Here the key is kept in this browser's local storage, which other pages from the same site can read.",
  });
  return lacks;
}
