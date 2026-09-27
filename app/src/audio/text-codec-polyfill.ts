/**
 * A UTF-8 `TextDecoder` and `TextEncoder` for the AudioWorklet global scope,
 * which has neither.
 *
 * The engine's wasm-bindgen glue creates both as soon as it loads (the
 * encoder since the engine took strings, such as an Effect's kind), so this
 * must be imported before `@engine` wherever they are missing.
 */
export class Utf8Decoder {
  decode(input?: ArrayBufferView | ArrayBuffer): string {
    if (!input) return "";
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

    let out = "";
    let i = 0;
    while (i < bytes.length) {
      const lead = bytes[i++] ?? 0;
      const extra = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0;
      let codePoint = extra === 0 ? lead : lead & (0x3f >> extra);
      for (let n = 0; n < extra; n++) {
        codePoint = (codePoint << 6) | ((bytes[i++] ?? 0) & 0x3f);
      }
      out += String.fromCodePoint(codePoint);
    }
    return out;
  }
}

export class Utf8Encoder {
  readonly encoding = "utf-8";

  encode(input = ""): Uint8Array {
    const bytes: number[] = [];
    for (const char of input) {
      let codePoint = char.codePointAt(0) ?? 0;
      // A lone surrogate is not valid UTF-8; the platform writes U+FFFD.
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) codePoint = 0xfffd;
      if (codePoint < 0x80) {
        bytes.push(codePoint);
      } else if (codePoint < 0x800) {
        bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
      } else if (codePoint < 0x10000) {
        bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
      } else {
        bytes.push(
          0xf0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
      }
    }
    return new Uint8Array(bytes);
  }
}

if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder = Utf8Encoder as unknown as typeof TextEncoder;
}

if (typeof globalThis.TextDecoder === "undefined") {
  globalThis.TextDecoder = Utf8Decoder as unknown as typeof TextDecoder;
}
