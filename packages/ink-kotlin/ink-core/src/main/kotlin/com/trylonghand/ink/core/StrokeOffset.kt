/// One raw model output row: pen movement delta and end-of-stroke flag.
/// Every engine emits these; everything downstream (layout, rendering)
/// consumes the shared stroke IR built from them.

package com.trylonghand.ink.core

public data class StrokeOffset(
    val dx: Double,
    val dy: Double,
    val eos: Boolean,
)
