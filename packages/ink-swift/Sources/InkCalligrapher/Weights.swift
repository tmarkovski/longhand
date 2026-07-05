/// Parser for the calligrapher model's weight container, ported from
/// packages/ink-calligrapher/src/weights.ts.
///
/// The file is a sequence of records:
///   name_len:u8, name:bytes         single-letter tensor name
///   sparse:u8                       1 = pruned tensor (values + index deltas)
///   count:u32le                     stored float32 count (nnz if sparse)
///   values:f32le * count
///   if sparse: delta:u8 * count     absolute index = running sum of deltas
///   ndims:u8, shape:u16le * ndims   dense shape
///
/// The four matmul-heavy tensors (the LSTM kernels `y`/`w`/`r` and the
/// post-attention projection `l`) are kept in CSR form and multiplied
/// sparsely; every other sparse tensor is scattered to dense, matching
/// the reference loader exactly.

import Foundation

public struct DenseTensor: Sendable {
    public let shape: [Int]
    public let data: [Float]
}

/// CSR matrix: `rows` outputs, each row dotting `values` against the input.
public struct SparseTensor: Sendable {
    public let rows: Int
    public let cols: Int
    public let values: [Float]
    public let colIndex: [Int32]
    public let rowPtr: [Int32]
}

public struct CalligrapherAssets: Sendable {
    public let dense: [String: DenseTensor]
    public let sparse: [String: SparseTensor]
    /// Number of learned style embeddings (rows of `g`).
    public let styleCount: Int
}

public enum CalligrapherWeightsError: Error, CustomStringConvertible {
    case truncated
    case missingStyleTensor

    public var description: String {
        switch self {
        case .truncated: return "calligrapher weights container is truncated"
        case .missingStyleTensor: return "missing style embedding tensor g"
        }
    }
}

private let csrTensors: Set<String> = ["y", "w", "r", "l"]

public func parseCalligrapherWeights(_ data: Data) throws -> CalligrapherAssets {
    var dense = [String: DenseTensor]()
    var sparse = [String: SparseTensor]()

    try data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
        var at = 0

        func need(_ count: Int) throws {
            guard at + count <= buffer.count else { throw CalligrapherWeightsError.truncated }
        }
        func u8() throws -> Int {
            try need(1)
            defer { at += 1 }
            return Int(buffer[at])
        }
        func u16() throws -> Int {
            try need(2)
            defer { at += 2 }
            return Int(UInt16(littleEndian: buffer.loadUnaligned(fromByteOffset: at, as: UInt16.self)))
        }
        func u32() throws -> Int {
            try need(4)
            defer { at += 4 }
            return Int(UInt32(littleEndian: buffer.loadUnaligned(fromByteOffset: at, as: UInt32.self)))
        }

        while at < buffer.count {
            let nameLength = try u8()
            try need(nameLength)
            var name = ""
            for i in 0 ..< nameLength { name.append(Character(UnicodeScalar(buffer[at + i]))) }
            at += nameLength

            let isSparse = try u8() != 0
            let count = try u32()

            try need(4 * count)
            var values = [Float](repeating: 0, count: count)
            values.withUnsafeMutableBytes { destination in
                destination.copyMemory(
                    from: UnsafeRawBufferPointer(rebasing: buffer[at ..< at + 4 * count])
                )
            }
            at += 4 * count

            var deltas: [UInt8]? = nil
            if isSparse {
                try need(count)
                deltas = [UInt8](buffer[at ..< at + count])
                at += count
            }

            let dims = try u8()
            var shape = [Int]()
            for _ in 0 ..< dims { shape.append(try u16()) }
            let size = shape.reduce(1, *)

            if isSparse, csrTensors.contains(name) {
                sparse[name] = toCsr(values: values, deltas: deltas!, rows: shape[0], cols: shape[1])
            } else if isSparse {
                var scattered = [Float](repeating: 0, count: size)
                var index = 0
                for i in 0 ..< count {
                    index += Int(deltas![i])
                    scattered[index] = values[i]
                }
                dense[name] = DenseTensor(shape: shape, data: scattered)
            } else {
                dense[name] = DenseTensor(shape: shape, data: values)
            }
        }
    }

    guard let styles = dense["g"] else { throw CalligrapherWeightsError.missingStyleTensor }
    return CalligrapherAssets(dense: dense, sparse: sparse, styleCount: styles.shape[0])
}

private func toCsr(values: [Float], deltas: [UInt8], rows: Int, cols: Int) -> SparseTensor {
    var keptValues = [Float]()
    var colIndex = [Int32]()
    var rowOf = [Int]()
    var absolute = 0
    for i in 0 ..< values.count {
        absolute += Int(deltas[i])
        if values[i] != 0 {
            keptValues.append(values[i])
            colIndex.append(Int32(absolute % cols))
            rowOf.append(absolute / cols)
        }
    }
    var rowPtr = [Int32](repeating: 0, count: rows + 1)
    var cursor = 0
    for row in 0 ..< rows {
        while cursor < rowOf.count, rowOf[cursor] == row { cursor += 1 }
        rowPtr[row + 1] = Int32(cursor)
    }
    return SparseTensor(rows: rows, cols: cols, values: keptValues, colIndex: colIndex, rowPtr: rowPtr)
}
