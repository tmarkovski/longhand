/// Parser for the "CALW" model containers written by tools/export_weights.py.
/// Mirrors packages/ink-graves/src/weights.ts: a 12-byte header (magic,
/// version, JSON length), a JSON header describing tensors and metadata,
/// then the raw little-endian tensor data.
///
/// Version 1 is all-float32 and carries per-style stroke tensors for live
/// priming. Version 2 stores the weight matrices as int8 with a float32
/// scale per output column (dequantized here, at parse) and replaces the
/// stroke tensors with baked primed states, one per style.

import Foundation

public struct Tensor: Sendable {
    public let shape: [Int]
    public let data: [Float]
}

public struct StyleInfo: Sendable, Decodable {
    public let id: Int
    public let primer: String
    /// Stroke tensor to teacher-force at write time (v1 containers).
    public let tensor: String?
    /// Baked primed-state tensor to restore instead (v2 containers).
    public let primed: String?
}

public struct ModelAssets: Sendable {
    public let tensors: [String: Tensor]
    public let alphabet: [String]
    public let maxCharLen: Int
    public let styles: [StyleInfo]
}

public enum CALWError: Error, CustomStringConvertible {
    case notCALW
    case unsupportedVersion(Int)
    case unsupportedDtype(String)
    case malformedQ8Tensor(String)
    case truncated
    case missingTensor(String)

    public var description: String {
        switch self {
        case .notCALW: return "not a CALW container"
        case .unsupportedVersion(let version): return "unsupported CALW version \(version)"
        case .unsupportedDtype(let dtype): return "unsupported dtype \(dtype)"
        case .malformedQ8Tensor(let name): return "malformed q8 tensor entry \(name)"
        case .truncated: return "CALW container is truncated"
        case .missingTensor(let name): return "missing tensor \(name)"
        }
    }
}

private let calwMagic: UInt32 = 0x574c_4143 // "CALW" little-endian

private struct Header: Decodable {
    struct Meta: Decodable {
        let alphabet: [String]
        let maxCharLen: Int
        let styles: [StyleInfo]
    }

    struct Entry: Decodable {
        let shape: [Int]
        let offset: Int
        let byteLength: Int
        /// v2 only; v1 containers are implicitly all-f32.
        let dtype: String?
        let scaleOffset: Int?
        let scaleByteLength: Int?
        let scaleDtype: String?
    }

    let dtype: String
    let meta: Meta
    let tensors: [String: Entry]
}

public func parseModelAssets(_ data: Data) throws -> ModelAssets {
    guard data.count >= 12 else { throw CALWError.truncated }
    let magic = readUInt32(data, at: 0)
    guard magic == calwMagic else { throw CALWError.notCALW }
    let version = readUInt32(data, at: 4)
    guard version == 1 || version == 2 else { throw CALWError.unsupportedVersion(Int(version)) }
    let headerLength = Int(readUInt32(data, at: 8))
    guard data.count >= 12 + headerLength else { throw CALWError.truncated }

    let headerData = data.subdata(in: dataRange(data, offset: 12, count: headerLength))
    let header = try JSONDecoder().decode(Header.self, from: headerData)

    let dataStart = 12 + headerLength
    var tensors = [String: Tensor](minimumCapacity: header.tensors.count)
    for (name, entry) in header.tensors {
        let dtype = version == 1 ? "f32" : (entry.dtype ?? "")
        let values: [Float]
        switch dtype {
        case "f32":
            values = try readF32(data, dataStart: dataStart, entry: entry)
        case "q8":
            values = try dequantizeQ8(data, dataStart: dataStart, entry: entry, name: name)
        default:
            throw CALWError.unsupportedDtype(dtype)
        }
        tensors[name] = Tensor(shape: entry.shape, data: values)
    }
    return ModelAssets(
        tensors: tensors,
        alphabet: header.meta.alphabet,
        maxCharLen: header.meta.maxCharLen,
        styles: header.meta.styles
    )
}

private func readF32(_ data: Data, dataStart: Int, entry: Header.Entry) throws -> [Float] {
    let start = dataStart + entry.offset
    guard entry.offset >= 0, entry.byteLength >= 0, start + entry.byteLength <= data.count else {
        throw CALWError.truncated
    }
    var values = [Float](repeating: 0, count: entry.byteLength / 4)
    _ = values.withUnsafeMutableBytes { destination in
        data.copyBytes(to: destination, from: dataRange(data, offset: start, count: entry.byteLength))
    }
    return values
}

/// weight[r][c] = int8[r * cols + c] * scale[c], materialized as f32.
private func dequantizeQ8(_ data: Data, dataStart: Int, entry: Header.Entry, name: String) throws -> [Float] {
    guard entry.shape.count == 2, entry.scaleDtype == "f32", let scaleOffset = entry.scaleOffset else {
        throw CALWError.malformedQ8Tensor(name)
    }
    let rows = entry.shape[0]
    let cols = entry.shape[1]
    let start = dataStart + entry.offset
    let scaleStart = dataStart + scaleOffset
    guard entry.offset >= 0, start + rows * cols <= data.count,
          scaleOffset >= 0, scaleStart + cols * 4 <= data.count
    else { throw CALWError.truncated }

    var scales = [Float](repeating: 0, count: cols)
    _ = scales.withUnsafeMutableBytes { destination in
        data.copyBytes(to: destination, from: dataRange(data, offset: scaleStart, count: cols * 4))
    }
    var values = [Float](repeating: 0, count: rows * cols)
    data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
        var i = 0
        for _ in 0 ..< rows {
            for c in 0 ..< cols {
                values[i] = Float(Int8(bitPattern: buffer[start + i])) * scales[c]
                i += 1
            }
        }
    }
    return values
}

/// Offsets in the format are relative to byte 0; Data slices can start at a
/// nonzero index, so every range is rebased onto data.startIndex.
private func dataRange(_ data: Data, offset: Int, count: Int) -> Range<Data.Index> {
    let start = data.startIndex + offset
    return start ..< start + count
}

private func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
    data.withUnsafeBytes { buffer in
        UInt32(littleEndian: buffer.loadUnaligned(fromByteOffset: offset, as: UInt32.self))
    }
}
