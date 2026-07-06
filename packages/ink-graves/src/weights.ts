/** Parser for the "CALW" model containers written by tools/export_weights.py.
 *
 * Version 1 is all-float32 and carries per-style stroke tensors for live
 * priming. Version 2 stores the weight matrices as int8 with a float32
 * scale per output column (dequantized here, at load) and replaces the
 * stroke tensors with baked primed states, one per style.
 */

export interface Tensor {
  shape: number[];
  data: Float32Array;
}

export interface StyleInfo {
  id: number;
  primer: string;
  /** Stroke tensor to teacher-force at write time (v1 containers). */
  tensor?: string;
  /** Baked primed-state tensor to restore instead (v2 containers). */
  primed?: string;
}

export interface ModelAssets {
  tensors: Map<string, Tensor>;
  alphabet: string[];
  maxCharLen: number;
  styles: StyleInfo[];
}

const MAGIC = 0x574c4143; // "CALW" little-endian

interface TensorEntry {
  shape: number[];
  offset: number;
  byteLength: number;
  /** v2 only; v1 containers are implicitly all-f32. */
  dtype?: "f32" | "q8";
  scaleOffset?: number;
  scaleByteLength?: number;
  scaleDtype?: string;
}

interface Header {
  dtype: string;
  meta: {
    alphabet: string[];
    maxCharLen: number;
    styles: StyleInfo[];
  };
  tensors: Record<string, TensorEntry>;
}

/** weight[r][c] = int8[r * cols + c] * scale[c], materialized as f32. */
function dequantizeQ8(buffer: ArrayBuffer, dataStart: number, entry: TensorEntry): Float32Array {
  if (entry.shape.length !== 2 || entry.scaleDtype !== "f32" || entry.scaleOffset === undefined) {
    throw new Error("malformed q8 tensor entry");
  }
  const [rows, cols] = entry.shape as [number, number];
  const quantized = new Int8Array(buffer, dataStart + entry.offset, rows * cols);
  const scales = new Float32Array(buffer, dataStart + entry.scaleOffset, cols);
  const data = new Float32Array(rows * cols);
  for (let r = 0, i = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++, i++) data[i] = quantized[i]! * scales[c]!;
  }
  return data;
}

export function parseModelAssets(buffer: ArrayBuffer): ModelAssets {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("not a CALW container");
  const version = view.getUint32(4, true);
  if (version !== 1 && version !== 2) throw new Error(`unsupported CALW version ${version}`);
  const headerLength = view.getUint32(8, true);
  const header: Header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, headerLength)));

  const dataStart = 12 + headerLength;
  const tensors = new Map<string, Tensor>();
  for (const [name, entry] of Object.entries(header.tensors)) {
    const dtype = version === 1 ? "f32" : entry.dtype;
    let data: Float32Array;
    if (dtype === "f32") {
      data = new Float32Array(buffer, dataStart + entry.offset, entry.byteLength / 4);
    } else if (dtype === "q8") {
      data = dequantizeQ8(buffer, dataStart, entry);
    } else {
      throw new Error(`unsupported dtype ${dtype} for tensor ${name}`);
    }
    tensors.set(name, { shape: entry.shape, data });
  }
  return {
    tensors,
    alphabet: header.meta.alphabet,
    maxCharLen: header.meta.maxCharLen,
    styles: header.meta.styles,
  };
}
