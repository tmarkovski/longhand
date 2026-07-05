/// SVG serialization behavior, mirroring the TS package's tests: crop,
/// per-renderer markup shape, width quantization, and the animated
/// document's reveal structure.

import Foundation
import InkCore
import InkRender
import Testing

/// A wavy stroke plus a single-point stroke (a pen tap) — the same
/// fixture as the TS tests.
private let fixtureLine: [InkStroke] = [
    InkStroke(points: (0 ..< 12).map { SIMD2(Double($0) * 2, Double($0 % 3) - 1) }),
    InkStroke(points: [SIMD2(30, 0)]),
]

private func occurrences(of needle: String, in text: String) -> Int {
    text.components(separatedBy: needle).count - 1
}

@Suite struct SvgTests {
    @Test func cropsTheViewBoxToTheInkPlusPadding() {
        let svg = lineToSvg(fixtureLine, options: LineSvgOptions(renderer: .pen, scale: 2, padding: 5))
        // Ink spans x 0..30, y -1..1 → 30·2 + 2·5 by 2·2 + 2·5.
        #expect(svg.contains("viewBox=\"0 0 70.0 14.0\""))
    }

    @Test func penDrawsQuantizedRunsAndTouchdownDots() {
        let svg = lineToSvg(fixtureLine, options: LineSvgOptions(renderer: .pen, scale: 2))
        #expect(svg.contains("fill=\"none\" stroke=\"currentColor\""))
        #expect(occurrences(of: "<circle ", in: svg) == 2)
        let widths = svg.matches(of: /stroke-width="([\d.]+)"/).compactMap { Double($0.1) }
        #expect(!widths.isEmpty)
        // Every run width sits on the 0.2 quantization grid.
        for width in widths {
            #expect(abs((width * 10).truncatingRemainder(dividingBy: 2)) < 1e-6)
        }
    }

    @Test func ribbonFillsOneOutlinePerStrokeSkippingSinglePoints() {
        let svg = lineToSvg(fixtureLine, options: LineSvgOptions(renderer: .ribbon, scale: 2))
        #expect(svg.contains("fill=\"currentColor\" stroke=\"none\""))
        #expect(occurrences(of: "<path ", in: svg) == 1)
        #expect(!svg.contains("stroke-width"))
    }

    @Test func animatedPenRevealsRunsWithSharedCycleTiming() {
        let options = AnimatedSvgOptions(
            line: LineSvgOptions(renderer: .pen, scale: 2),
            msPerStep: 8
        )
        let svg = lineToAnimatedSvg(fixtureLine, options: options)
        // 13 points × 8ms + 350 lead + 1600 hold.
        #expect(svg.contains("dur=\"2054ms\""))
        #expect(svg.contains("repeatCount=\"indefinite\""))
        #expect(svg.contains("attributeName=\"stroke-dashoffset\""))
        // Touchdown dots pop in discretely.
        #expect(occurrences(of: "calcMode=\"discrete\"", in: svg) == 2)
        // Every keyTimes list spans the full cycle.
        for keyTimes in svg.matches(of: /keyTimes="([^"]*)"/).map({ String($0.1) }) {
            #expect(keyTimes.hasPrefix("0;"))
            #expect(keyTimes.hasSuffix(";1"))
        }
    }

    @Test func animatedRibbonMasksEachMultiPointStroke() {
        let options = AnimatedSvgOptions(
            line: LineSvgOptions(renderer: .ribbon, scale: 2),
            msPerStep: 8,
            loop: false
        )
        let svg = lineToAnimatedSvg(fixtureLine, options: options)
        #expect(occurrences(of: "<mask ", in: svg) == 1)
        #expect(svg.contains("mask=\"url(#reveal0)\""))
        #expect(svg.contains("repeatCount=\"1\" fill=\"freeze\""))
    }
}
