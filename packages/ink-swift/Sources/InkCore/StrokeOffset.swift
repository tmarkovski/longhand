/// One raw model output row: pen movement delta and end-of-stroke flag.
/// Every engine emits these; everything downstream (layout, rendering)
/// consumes the shared stroke IR built from them.

public struct StrokeOffset: Equatable, Sendable {
    public let dx: Double
    public let dy: Double
    public let eos: Bool

    public init(dx: Double, dy: Double, eos: Bool) {
        self.dx = dx
        self.dy = dy
        self.eos = eos
    }
}
