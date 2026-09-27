/**
 * The one place the audio a model hears is described: what the analysers
 * encode, and what `analyse_audio`'s description and the settings say.
 */

/**
 * How a model that takes audio hears a render: the first `maxSeconds` of the
 * range, in mono at `sampleRate`, as a 16-bit PCM WAV file (`mimeType`).
 * Chosen for size, with no encoder to ship: WAV is the one format every
 * Provider that takes audio reads (Gemini, OpenAI's and llama.cpp's
 * `input_audio`), mono since Gemini mixes channels to one anyway, and
 * 16 kHz, 32 kB a second, since Gemini hears audio at 16 kbps whatever it
 * is sent. The cap keeps each attachment near 1 MB (1.3 MB base64-encoded),
 * which matters because every attachment is sent again on each later turn
 * of the Request and Gemini takes 20 MB a request inline. 30 seconds is 15
 * bars at 120 BPM, enough to hear a Section, and 960 of Gemini's tokens at
 * 32 a second.
 * `analyse_audio`'s description states both, from here.
 */
export const LISTENING = { sampleRate: 16_000, maxSeconds: 30, mimeType: "audio/wav", format: "wav" } as const;
