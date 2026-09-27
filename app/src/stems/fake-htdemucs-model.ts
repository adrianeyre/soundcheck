/**
 * Tiny ONNX models of our own for the Browser Version's tests, written out
 * as protobuf by hand, as `desktop/src/stems/fake_model.rs` writes the
 * desktop's: no Demucs weights (ADR 0005), and nothing to download.
 *
 * `fakeStemsModel(length, weights)` takes `[1, 2, length]` and gives
 * `[1, weights.length, 2, length]`, Stem `k` being the input times
 * `weights[k]`: with htdemucs' length and four weights summing to 1, a
 * stand-in for htdemucs whose Stems sum exactly to its input.
 */

/** htdemucs' four Stems, in its order, as a known share of the input: `WEIGHTS` in `fake_model.rs`. */
export const FAKE_WEIGHTS = [0.1, 0.2, 0.3, 0.4] as const;
/** htdemucs' training segment, 7.8 s at 44.1 kHz. */
export const FAKE_SEGMENT = 343_980;

/** A model shaped like htdemucs, splitting its input by `FAKE_WEIGHTS`. */
export function fakeHtdemucs(): Uint8Array {
  return fakeStemsModel(FAKE_SEGMENT, FAKE_WEIGHTS);
}

/**
 * The same, its output's shape left symbolic, as the real export's is
 * (`Addoutput_dim_0` and so on): reshaped to a shape that is only known once
 * ONNX Runtime folds its constants, which no optimisation doesn't.
 */
export function fakeHtdemucsAsExported(): Uint8Array {
  return fakeStemsModel(FAKE_SEGMENT, FAKE_WEIGHTS, { symbolicOutput: true });
}

// TensorProto.DataType
const FLOAT = 1;
const INT64 = 7;

/** A model from `[1, 2, length]` to `[1, weights.length, 2, length]`. */
export function fakeStemsModel(length: number, weights: readonly number[], { symbolicOutput = false } = {}): Uint8Array {
  const sources = weights.length;
  // Unsqueeze the input to [1, 1, 2, length], then broadcast it against the
  // weights, [1, sources, 1, 1].
  const axes = tensor("axes", INT64, [1], int64s([1]));
  const weightData = tensor("weights", FLOAT, [1, sources, 1, 1], new Uint8Array(new Float32Array(weights).buffer));
  const outputDims = [1, sources, 2, length];
  const graph: number[] = [];
  field(graph, 1, node("Unsqueeze", ["input", "axes"], "unsqueezed"));
  if (symbolicOutput) {
    field(graph, 1, node("Mul", ["unsqueezed", "weights"], "product"));
    field(graph, 1, node("Add", ["output_shape", "no_change"], "shape"));
    field(graph, 1, node("Reshape", ["product", "shape"], "output"));
    field(graph, 5, tensor("output_shape", INT64, [4], int64s(outputDims)));
    field(graph, 5, tensor("no_change", INT64, [4], int64s([0, 0, 0, 0])));
  } else {
    field(graph, 1, node("Mul", ["unsqueezed", "weights"], "output"));
  }
  field(graph, 2, text("fake-stems"));
  field(graph, 5, axes);
  field(graph, 5, weightData);
  field(graph, 11, valueInfo("input", [1, 2, length]));
  field(graph, 12, valueInfo("output", symbolicOutput ? outputDims.map((_, i) => `output_dim_${i}`) : outputDims));

  const opset: number[] = [];
  field(opset, 1, []);
  varintField(opset, 2, 13);
  const model: number[] = [];
  varintField(model, 1, 8); // IR version
  field(model, 2, text("soundcheck-tests"));
  field(model, 7, graph);
  field(model, 8, opset);
  return Uint8Array.from(model);
}

function int64s(values: number[]): Uint8Array {
  return new Uint8Array(new BigInt64Array(values.map(BigInt)).buffer);
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function node(op: string, inputs: string[], output: string): number[] {
  const made: number[] = [];
  for (const input of inputs) field(made, 1, text(input));
  field(made, 2, text(output));
  field(made, 3, text(op.toLowerCase()));
  field(made, 4, text(op));
  return made;
}

function tensor(name: string, dataType: number, dims: number[], raw: Uint8Array): number[] {
  const made: number[] = [];
  for (const dim of dims) varintField(made, 1, dim);
  varintField(made, 2, dataType);
  field(made, 8, text(name));
  field(made, 9, raw);
  return made;
}

/** A float tensor's name and shape: ValueInfoProto { TypeProto { Tensor } }. A string is a symbolic dimension. */
function valueInfo(name: string, dims: (number | string)[]): number[] {
  const shape: number[] = [];
  for (const dim of dims) {
    const dimension: number[] = [];
    if (typeof dim === "number") varintField(dimension, 1, dim);
    else field(dimension, 2, text(dim));
    field(shape, 1, dimension);
  }
  const tensorType: number[] = [];
  varintField(tensorType, 1, FLOAT);
  field(tensorType, 2, shape);
  const typeProto: number[] = [];
  field(typeProto, 1, tensorType);
  const info: number[] = [];
  field(info, 1, text(name));
  field(info, 2, typeProto);
  return info;
}

/** A length-delimited field: strings, bytes and nested messages. */
function field(out: number[], number: number, bytes: ArrayLike<number>): void {
  varint(out, (number << 3) | 2);
  varint(out, bytes.length);
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]!);
}

function varintField(out: number[], number: number, value: number): void {
  varint(out, number << 3);
  varint(out, value);
}

function varint(out: number[], value: number): void {
  while (value >= 0x80) {
    out.push((value % 0x80) | 0x80);
    value = Math.floor(value / 0x80);
  }
  out.push(value);
}
