/**
 * Parser for the calligrapher model's weight container (`d.bin`).
 *
 * The file is a sequence of records:
 *   name_len:u8, name:bytes         single-letter tensor name
 *   sparse:u8                       1 = pruned tensor (values + index deltas)
 *   count:u32le                     stored float32 count (nnz if sparse)
 *   values:f32le * count
 *   if sparse: delta:u8 * count     absolute index = running sum of deltas
 *   ndims:u8, shape:u16le * ndims   dense shape
 *
 * The four matmul-heavy tensors (the LSTM kernels `y`/`w`/`r` and the
 * post-attention projection `l`) are kept in CSR form and multiplied
 * sparsely; every other sparse tensor is scattered to dense, matching
 * the reference loader exactly.
 */

export interface DenseTensor {
  shape: number[];
  data: Float32Array;
}

/** CSR matrix: `rows` outputs, each row dotting `values` against the input. */
export interface SparseTensor {
  rows: number;
  cols: number;
  values: Float32Array;
  colIndex: Int32Array;
  rowPtr: Int32Array;
}

export interface CalligrapherAssets {
  dense: Map<string, DenseTensor>;
  sparse: Map<string, SparseTensor>;
  /** Number of learned style embeddings (rows of `g`). */
  styleCount: number;
}

const CSR_TENSORS = new Set(["y", "w", "r", "l"]);

export function parseCalligrapherWeights(buffer: ArrayBuffer): CalligrapherAssets {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const dense = new Map<string, DenseTensor>();
  const sparse = new Map<string, SparseTensor>();
  let at = 0;

  while (at < buffer.byteLength) {
    const nameLength = view.getUint8(at);
    at += 1;
    let name = "";
    for (let i = 0; i < nameLength; i++) name += String.fromCharCode(bytes[at + i]!);
    at += nameLength;
    const isSparse = view.getUint8(at) !== 0;
    at += 1;
    const count = view.getUint32(at, true);
    at += 4;
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = view.getFloat32(at, true);
      at += 4;
    }
    let deltas: Uint8Array | null = null;
    if (isSparse) {
      deltas = bytes.subarray(at, at + count);
      at += count;
    }
    const dims = view.getUint8(at);
    at += 1;
    const shape: number[] = [];
    for (let i = 0; i < dims; i++) {
      shape.push(view.getUint16(at, true));
      at += 2;
    }
    const size = shape.reduce((a, b) => a * b, 1);

    if (isSparse && CSR_TENSORS.has(name)) {
      sparse.set(name, toCsr(values, deltas!, shape[0]!, shape[1]!));
    } else if (isSparse) {
      const scattered = new Float32Array(size);
      let index = 0;
      for (let i = 0; i < count; i++) {
        index += deltas![i]!;
        scattered[index] = values[i]!;
      }
      dense.set(name, { shape, data: scattered });
    } else {
      dense.set(name, { shape, data: values });
    }
  }

  const styles = dense.get("g");
  if (!styles) throw new Error("missing style embedding tensor g");
  return { dense, sparse, styleCount: styles.shape[0]! };
}

function toCsr(values: Float32Array, deltas: Uint8Array, rows: number, cols: number): SparseTensor {
  const keptValues: number[] = [];
  const colIndex: number[] = [];
  const rowOf: number[] = [];
  let absolute = 0;
  for (let i = 0; i < values.length; i++) {
    absolute += deltas[i]!;
    if (values[i] !== 0) {
      keptValues.push(values[i]!);
      colIndex.push(absolute % cols);
      rowOf.push(Math.floor(absolute / cols));
    }
  }
  const rowPtr = new Int32Array(rows + 1);
  let cursor = 0;
  for (let row = 0; row < rows; row++) {
    while (cursor < rowOf.length && rowOf[cursor] === row) cursor++;
    rowPtr[row + 1] = cursor;
  }
  return {
    rows,
    cols,
    values: Float32Array.from(keptValues),
    colIndex: Int32Array.from(colIndex),
    rowPtr,
  };
}
