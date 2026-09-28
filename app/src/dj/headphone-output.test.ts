import { expect, test, vi } from "vitest";

import type { AudioOutput } from "../audio/audio-output";
import { browserHeadphoneOutput, desktopHeadphoneOutput, desktopStateOf, type SinkElement } from "./headphone-output";

test("the desktop's status reads as the picker shows it", () => {
  expect(desktopStateOf({ device: null, sampleRate: null, failed: null })).toEqual({ device: null, status: "off", message: null });
  expect(desktopStateOf({ device: "Headset", sampleRate: null, failed: null }).status).toBe("waiting");
  expect(desktopStateOf({ device: "Headset", sampleRate: 44_100, failed: null })).toEqual({
    device: "Headset",
    status: "playing",
    message: "44100 Hz",
  });
  expect(desktopStateOf({ device: "Headset", sampleRate: 48_000, failed: "Headset stopped" })).toMatchObject({
    status: "failed",
    message: "Headset stopped",
  });
});

test("the desktop's asks the shell", async () => {
  const invoke = vi.fn<(command: string, args?: unknown) => Promise<unknown>>(async (command) =>
    command === "headphones_devices" ? [{ id: "Headset", label: "Headset" }] : { device: "Headset", sampleRate: 48_000, failed: null },
  );
  const phones = desktopHeadphoneOutput(invoke as never);
  expect(await phones.listDevices()).toEqual([{ id: "Headset", label: "Headset" }]);
  expect((await phones.choose("Headset")).status).toBe("playing");
  expect(invoke).toHaveBeenCalledWith("headphones_choose", { device: "Headset" });
});

function fakeBrowser() {
  const element: SinkElement & { sink: string | null; playing: boolean } = {
    srcObject: null,
    sink: null,
    playing: false,
    setSinkId: vi.fn<(id: string) => Promise<void>>(async (id) => {
      element.sink = id;
    }),
    play: vi.fn<() => Promise<void>>(async () => {
      element.playing = true;
    }),
    pause: vi.fn<() => void>(() => {
      element.playing = false;
    }),
  };
  const devices = [
    { kind: "audiooutput", deviceId: "default", label: "Default" },
    { kind: "audiooutput", deviceId: "phones", label: "" },
    { kind: "audioinput", deviceId: "mic", label: "Mic" },
  ] as MediaDeviceInfo[];
  const phones = browserHeadphoneOutput({ devices: async () => devices, element: () => element })!;
  return { phones, element };
}

test("the browser's plays the worklet's cue stream to the chosen device", async () => {
  const { phones, element } = fakeBrowser();
  expect(await phones.listDevices()).toEqual([{ id: "phones", label: "Audio output 1" }]);
  // Chosen before audio starts, it waits.
  expect((await phones.choose("phones")).status).toBe("waiting");
  const stream = {} as MediaStream;
  phones.attach({ dj: { headphoneStream: () => stream } } as unknown as AudioOutput);
  await vi.waitFor(async () => expect((await phones.state()).status).toBe("playing"));
  expect(element.srcObject).toBe(stream);
  expect(element.sink).toBe("phones");
  expect(element.playing).toBe(true);

  // Audio stopping pauses it; none chosen turns it off.
  phones.attach(null);
  expect(element.playing).toBe(false);
  expect((await phones.choose(null)).status).toBe("off");
});

test("a device that can't be used says why", async () => {
  const { phones, element } = fakeBrowser();
  element.setSinkId = async () => {
    throw new Error("NotFoundError");
  };
  phones.attach({ dj: { headphoneStream: () => ({}) as MediaStream } } as unknown as AudioOutput);
  const state = await phones.choose("gone");
  expect(state.status).toBe("failed");
  expect(state.message).toMatch(/NotFoundError/);
});

test("a browser without setSinkId has none", () => {
  expect(browserHeadphoneOutput(null)).toBeNull();
});
