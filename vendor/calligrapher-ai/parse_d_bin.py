"""Parse calligrapher.ai's d.bin weight container and dump tensor inventory.

Container format (reverse-engineered from the site's inline loader):
repeated records until EOF:
  name_len:u8, name:bytes            single-letter tensor name
  sparse:u8                          1 = pruned tensor, values + delta indices
  count:u32le                        number of stored float32 values (nnz if sparse)
  values:f32le * count
  if sparse: delta:u8 * count        index deltas; absolute index = cumsum(delta)
  ndims:u8, shape:u16le * ndims      dense shape

Sparse handling in their JS: tensors named y/w/r/l are kept in a CSR-like
form for sparse matmul; every other sparse tensor is scattered to dense.

Usage: uv run python parse_d_bin.py [--dump-npz out.npz]
"""

import struct

import click
import numpy as np


def parse(path: str) -> dict[str, np.ndarray]:
    data = open(path, "rb").read()
    tensors: dict[str, np.ndarray] = {}
    e = 0
    while e < len(data):
        nlen = data[e]
        e += 1
        name = data[e : e + nlen].decode()
        e += nlen
        sparse = data[e]
        e += 1
        count = struct.unpack_from("<I", data, e)[0]
        e += 4
        values = np.frombuffer(data, "<f4", count, e).copy()
        e += 4 * count
        deltas = None
        if sparse:
            deltas = np.frombuffer(data, "u1", count, e)
            e += count
        ndims = data[e]
        e += 1
        shape = struct.unpack_from(f"<{ndims}H", data, e)
        e += 2 * ndims
        dense = np.zeros(int(np.prod(shape)), dtype=np.float32)
        if sparse:
            dense[np.cumsum(deltas.astype(np.int64))] = values
        else:
            dense[:] = values
        tensors[name] = dense.reshape(shape)
    return tensors


@click.command()
@click.argument("path", default="d.bin")
@click.option("--dump-npz", type=click.Path(), help="Write dense tensors to an .npz file.")
def main(path: str, dump_npz: str | None) -> None:
    tensors = parse(path)
    total = 0
    for name, t in tensors.items():
        nnz = int(np.count_nonzero(t))
        total += t.size
        click.echo(f"{name:3s} shape={t.shape!s:16s} nnz={nnz:8d} ({nnz / t.size:5.1%})")
    click.echo(f"total dense params: {total:,}")
    if dump_npz:
        np.savez(dump_npz, **tensors)
        click.echo(f"wrote {dump_npz}")


if __name__ == "__main__":
    main()
