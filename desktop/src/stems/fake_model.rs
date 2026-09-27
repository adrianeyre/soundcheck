//! Tiny ONNX models of our own for the tests, written out as protobuf by
//! hand: no Demucs weights (ADR 0005), and nothing to download.
//!
//! `stems(length, weights)` takes `[1, 2, length]` and gives
//! `[1, weights.len(), 2, length]`, Stem `k` being the input times
//! `weights[k]`: with htdemucs' length and four weights summing to 1, a
//! stand-in for htdemucs whose Stems sum exactly to its input.

/// htdemucs' four Stems, in its order, as a known share of the input.
pub const WEIGHTS: [f32; 4] = [0.1, 0.2, 0.3, 0.4];

/// A model shaped like htdemucs, splitting its input by `WEIGHTS`.
pub fn htdemucs() -> Vec<u8> {
    stems(super::SEGMENT as i64, &WEIGHTS)
}

/// The same, its output's shape left symbolic, as the real export's is
/// (`Addoutput_dim_0` and so on): reshaped to a shape that is only known
/// once ONNX Runtime folds its constants, which no optimisation doesn't.
pub fn htdemucs_as_exported() -> Vec<u8> {
    model(super::SEGMENT as i64, &WEIGHTS, true)
}

/// A model from `[1, 2, length]` to `[1, weights.len(), 2, length]`.
pub fn stems(length: i64, weights: &[f32]) -> Vec<u8> {
    model(length, weights, false)
}

fn model(length: i64, weights: &[f32], symbolic_output: bool) -> Vec<u8> {
    let sources = weights.len() as i64;
    // Unsqueeze the input to [1, 1, 2, length], then broadcast it against
    // the weights, [1, sources, 1, 1].
    let axes = tensor("axes", INT64, &[1], &1i64.to_le_bytes());
    let weights = tensor(
        "weights",
        FLOAT,
        &[1, sources, 1, 1],
        &weights
            .iter()
            .flat_map(|w| w.to_le_bytes())
            .collect::<Vec<_>>(),
    );
    let output = [1, sources, 2, length];
    let mut graph = Vec::new();
    field(
        &mut graph,
        1,
        &node("Unsqueeze", &["input", "axes"], "unsqueezed"),
    );
    if symbolic_output {
        field(
            &mut graph,
            1,
            &node("Mul", &["unsqueezed", "weights"], "product"),
        );
        field(
            &mut graph,
            1,
            &node("Add", &["output_shape", "no_change"], "shape"),
        );
        field(
            &mut graph,
            1,
            &node("Reshape", &["product", "shape"], "output"),
        );
        let int64s =
            |values: [i64; 4]| -> Vec<u8> { values.iter().flat_map(|v| v.to_le_bytes()).collect() };
        field(
            &mut graph,
            5,
            &tensor("output_shape", INT64, &[4], &int64s(output)),
        );
        field(
            &mut graph,
            5,
            &tensor("no_change", INT64, &[4], &int64s([0; 4])),
        );
    } else {
        field(
            &mut graph,
            1,
            &node("Mul", &["unsqueezed", "weights"], "output"),
        );
    }
    field(&mut graph, 2, b"fake-stems");
    field(&mut graph, 5, &axes);
    field(&mut graph, 5, &weights);
    field(&mut graph, 11, &value_info("input", &[1, 2, length]));
    let output = if symbolic_output {
        value_info_of("output", &output.map(|_| None))
    } else {
        value_info("output", &output)
    };
    field(&mut graph, 12, &output);

    let mut opset = Vec::new();
    field(&mut opset, 1, b"");
    varint_field(&mut opset, 2, 13);
    let mut model = Vec::new();
    varint_field(&mut model, 1, 8); // IR version
    field(&mut model, 2, b"soundcheck-tests");
    field(&mut model, 7, &graph);
    field(&mut model, 8, &opset);
    model
}

// TensorProto.DataType
const FLOAT: u64 = 1;
const INT64: u64 = 7;

fn node(op: &str, inputs: &[&str], output: &str) -> Vec<u8> {
    let mut node = Vec::new();
    for input in inputs {
        field(&mut node, 1, input.as_bytes());
    }
    field(&mut node, 2, output.as_bytes());
    field(&mut node, 3, op.to_lowercase().as_bytes());
    field(&mut node, 4, op.as_bytes());
    node
}

fn tensor(name: &str, data_type: u64, dims: &[i64], raw: &[u8]) -> Vec<u8> {
    let mut tensor = Vec::new();
    for &dim in dims {
        varint_field(&mut tensor, 1, dim as u64);
    }
    varint_field(&mut tensor, 2, data_type);
    field(&mut tensor, 8, name.as_bytes());
    field(&mut tensor, 9, raw);
    tensor
}

/// A float tensor's name and shape: ValueInfoProto { TypeProto { Tensor } }.
fn value_info(name: &str, dims: &[i64]) -> Vec<u8> {
    let dims: Vec<_> = dims.iter().copied().map(Some).collect();
    value_info_of(name, &dims)
}

/// The same, a None dimension being symbolic: `output_dim_` and its place.
fn value_info_of(name: &str, dims: &[Option<i64>]) -> Vec<u8> {
    let mut shape = Vec::new();
    for (place, &dim) in dims.iter().enumerate() {
        let mut dimension = Vec::new();
        match dim {
            Some(dim) => varint_field(&mut dimension, 1, dim as u64),
            None => field(&mut dimension, 2, format!("output_dim_{place}").as_bytes()),
        }
        field(&mut shape, 1, &dimension);
    }
    let mut tensor_type = Vec::new();
    varint_field(&mut tensor_type, 1, FLOAT);
    field(&mut tensor_type, 2, &shape);
    let mut type_proto = Vec::new();
    field(&mut type_proto, 1, &tensor_type);
    let mut info = Vec::new();
    field(&mut info, 1, name.as_bytes());
    field(&mut info, 2, &type_proto);
    info
}

/// A length-delimited field: strings, bytes and nested messages.
fn field(out: &mut Vec<u8>, number: u64, bytes: &[u8]) {
    varint(out, number << 3 | 2);
    varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

fn varint_field(out: &mut Vec<u8>, number: u64, value: u64) {
    varint(out, number << 3);
    varint(out, value);
}

fn varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}
