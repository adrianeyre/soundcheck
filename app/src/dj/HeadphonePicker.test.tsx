// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { AudioOutput } from "../audio/audio-output";
import type { HeadphoneOutput, HeadphoneState } from "./headphone-output";
import { HEADPHONES_KEY, HeadphonePicker } from "./HeadphonePicker";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

function fakeHeadphones() {
  let state: HeadphoneState = { device: null, status: "off", message: null };
  const phones = {
    listDevices: vi.fn<HeadphoneOutput["listDevices"]>(async () => [
      { id: "phones", label: "USB Headset" },
      { id: "speakers", label: "Speakers (default)" },
    ]),
    choose: vi.fn<HeadphoneOutput["choose"]>(async (device) => {
      state = device ? { device, status: "playing", message: null } : { device: null, status: "off", message: null };
      return state;
    }),
    state: vi.fn<HeadphoneOutput["state"]>(async () => state),
    attach: vi.fn<HeadphoneOutput["attach"]>(),
  } satisfies HeadphoneOutput;
  return phones;
}

const output = {} as AudioOutput;

test("choosing a device plays the cue there and remembers it", async () => {
  const phones = fakeHeadphones();
  render(<HeadphonePicker headphones={phones} output={output} />);
  expect(phones.attach).toHaveBeenCalledWith(output);
  const select = screen.getByRole("combobox", { name: "Headphone output device" });
  await screen.findByRole("option", { name: "USB Headset" });
  fireEvent.change(select, { target: { value: "phones" } });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The cue is playing there."));
  expect(phones.choose).toHaveBeenLastCalledWith("phones");
  expect(localStorage.getItem(HEADPHONES_KEY)).toBe("phones");

  fireEvent.change(select, { target: { value: "" } });
  await waitFor(() => expect(phones.choose).toHaveBeenLastCalledWith(null));
  expect(localStorage.getItem(HEADPHONES_KEY)).toBe("");
});

test("the remembered device is chosen again with each new output, and a missing one is marked", async () => {
  localStorage.setItem(HEADPHONES_KEY, "gone");
  const phones = fakeHeadphones();
  const { rerender } = render(<HeadphonePicker headphones={phones} output={null} />);
  await waitFor(() => expect(phones.choose).toHaveBeenCalledWith("gone"));
  expect(await screen.findByRole("option", { name: "gone (not found)" })).toBeInTheDocument();
  const next = {} as AudioOutput;
  rerender(<HeadphonePicker headphones={phones} output={next} />);
  await waitFor(() => expect(phones.attach).toHaveBeenLastCalledWith(next));
  expect(phones.choose.mock.calls.filter(([device]) => device === "gone")).toHaveLength(2);
});

test("a device that stops is noticed", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const phones = fakeHeadphones();
  localStorage.setItem(HEADPHONES_KEY, "phones");
  render(<HeadphonePicker headphones={phones} output={output} />);
  phones.state.mockResolvedValue({ device: "phones", status: "failed", message: "phones stopped: it may have been unplugged" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_100);
  });
  expect(screen.getByRole("status")).toHaveTextContent("unplugged");
  vi.useRealTimers();
});
