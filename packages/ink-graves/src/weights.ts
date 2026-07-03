/** Parser for the "CALW" model container written by tools/export_weights.py. */

export interface Tensor {
  shape: number[];
  data: Float32Array;
}

export interface StyleInfo {
  id: number;
  primer: string;
  tensor: string;
}

export interface ModelAssets {
  tensors: Map<string, Tensor>;
  alphabet: string[];
  maxCharLen: number;
  styles: StyleInfo[];
}

const MAGIC = 0x574c4143; // "CALW" little-endian

interface Header {
  dtype: string;
  meta: {
    alphabet: string[];
    maxCharLen: number;
    styles: StyleInfo[];
  };
  tensors: Record<string, { shape: number[]; offset: number; byteLength: number }>;
}

export function parseModelAssets(buffer: ArrayBuffer): ModelAssets {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("not a CALW container");
  const version = view.getUint32(4, true);
  if (version !== 1) throw new Error(`unsupported CALW version ${version}`);
  const headerLength = view.getUint32(8, true);
  const header: Header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, headerLength)));
  if (header.dtype !== "f32") throw new Error(`unsupported dtype ${header.dtype}`);

  const dataStart = 12 + headerLength;
  const tensors = new Map<string, Tensor>();
  for (const [name, entry] of Object.entries(header.tensors)) {
    tensors.set(name, {
      shape: entry.shape,
      data: new Float32Array(buffer, dataStart + entry.offset, entry.byteLength / 4),
    });
  }
  return {
    tensors,
    alphabet: header.meta.alphabet,
    maxCharLen: header.meta.maxCharLen,
    styles: header.meta.styles,
  };
}
