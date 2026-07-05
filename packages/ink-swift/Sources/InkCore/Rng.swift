/// Deterministic RNG for sampling: sfc32 seeded via splitmix32, normal
/// deviates via Box-Muller. A port of packages/ink-graves/src/rng.ts; the
/// integer path is bit-identical (32-bit wrapping arithmetic), so a seed
/// consumes the uniform stream in the same order as the web engine.

import Foundation

public struct Rng: Sendable {
    private var a: UInt32
    private var b: UInt32
    private var c: UInt32
    private var d: UInt32
    private var spare: Double? = nil

    public init(seed: UInt32) {
        // splitmix32 to spread one 32-bit seed into four state words
        var s = seed
        func split() -> UInt32 {
            s = s &+ 0x9e37_79b9
            var z = s
            z = (z ^ (z >> 16)) &* 0x21f0_aaad
            z = (z ^ (z >> 15)) &* 0x735a_2d97
            return z ^ (z >> 15)
        }
        a = split()
        b = split()
        c = split()
        d = split()
        for _ in 0 ..< 12 { _ = uniform() }
    }

    /// Uniform in [0, 1).
    public mutating func uniform() -> Double {
        let t = a &+ b
        a = b ^ (b >> 9)
        b = c &+ (c << 3)
        c = (c << 21) | (c >> 11)
        d = d &+ 1
        let out = t &+ d
        c = c &+ out
        return Double(out) / 4294967296
    }

    /// Standard normal deviate.
    public mutating func normal() -> Double {
        if let value = spare {
            spare = nil
            return value
        }
        var u1 = uniform()
        while u1 == 0 { u1 = uniform() }
        let u2 = uniform()
        let radius = (-2 * Foundation.log(u1)).squareRoot()
        spare = radius * sin(2 * .pi * u2)
        return radius * cos(2 * .pi * u2)
    }

    /// Sample an index proportionally to non-negative weights.
    public mutating func categorical(_ weights: [Float]) -> Int {
        var total = 0.0
        for weight in weights { total += Double(weight) }
        var target = uniform() * total
        for (index, weight) in weights.enumerated() {
            target -= Double(weight)
            if target < 0 { return index }
        }
        return weights.count - 1
    }
}
