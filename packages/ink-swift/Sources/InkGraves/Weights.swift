/// Parser for the "CALW" model container written by tools/export_weights.py.
/// Mirrors packages/ink-graves/src/weights.ts: a 12-byte header (magic,
/// version, JSON length), a JSON header describing tensors and metadata,
/// then the raw little-endian f32 tensor data.

import Foundation

public struct Tensor: Sendable {
    public let shape: [Int]
    public let data: [Float]
}

public struct StyleInfo: Sendable, Decodable {
    public let id: Int
    public let primer: String
    public let tensor: String
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
    case truncated
    case missingTensor(String)

    public var description: String {
        switch self {
        case .notCALW: return "not a CALW container"
        case .unsupportedVersion(let version): return "unsupported CALW version \(version)"
        case .unsupportedDtype(let dtype): return "unsupported dtype \(dtype)"
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
    guard version == 1 else { throw CALWError.unsupportedVersion(Int(version)) }
    let headerLength = Int(readUInt32(data, at: 8))
    guard data.count >= 12 + headerLength else { throw CALWError.truncated }

    let headerData = data.subdata(in: dataRange(data, offset: 12, count: headerLength))
    let header = try JSONDecoder().decode(Header.self, from: headerData)
    guard header.dtype == "f32" else { throw CALWError.unsupportedDtype(header.dtype) }

    let dataStart = 12 + headerLength
    var tensors = [String: Tensor](minimumCapacity: header.tensors.count)
    for (name, entry) in header.tensors {
        let start = dataStart + entry.offset
        guard entry.offset >= 0, entry.byteLength >= 0, start + entry.byteLength <= data.count else {
            throw CALWError.truncated
        }
        let count = entry.byteLength / 4
        var values = [Float](repeating: 0, count: count)
        _ = values.withUnsafeMutableBytes { destination in
            data.copyBytes(to: destination, from: dataRange(data, offset: start, count: entry.byteLength))
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
