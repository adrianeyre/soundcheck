# Audio fixtures

Test files for decoding and playing Audio Clips. Each holds the same 0.25 s
tone at 44 100 Hz, stereo: a 400 Hz sine at half scale on the left and an
800 Hz sine at quarter scale on the right, whole cycles only, so both sides
start and end at zero.

- `tone.wav`: 16-bit PCM.
- `tone.flac`: 16-bit, verbatim subframes, written by a small script from the
  same samples as the WAV.
- `tone.mp3`: 192 kbps, encoded from the same samples with `lamejs`. It
  carries the encoder's delay in front of the tone, so tests allow for it.

They were generated for this repository and are free to use.
