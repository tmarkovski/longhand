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

package com.trylonghand.ink.calligrapher

import java.nio.ByteBuffer
import java.nio.ByteOrder

public class DenseTensor(
    public val shape: List<Int>,
    public val data: FloatArray,
)

/** CSR matrix: `rows` outputs, each row dotting `values` against the input. */
public class SparseTensor(
    public val rows: Int,
    public val cols: Int,
    public val values: FloatArray,
    public val colIndex: IntArray,
    public val rowPtr: IntArray,
)

public class CalligrapherAssets(
    public val dense: Map<String, DenseTensor>,
    public val sparse: Map<String, SparseTensor>,
    /** Number of learned style embeddings (rows of `g`). */
    public val styleCount: Int,
)

public sealed class CalligrapherWeightsError(message: String) : Exception(message) {
    public class Truncated :
        CalligrapherWeightsError("calligrapher weights container is truncated")

    public class MissingStyleTensor :
        CalligrapherWeightsError("missing style embedding tensor g")
}

private val csrTensors: Set<String> = setOf("y", "w", "r", "l")

public fun parseCalligrapherWeights(data: ByteArray): CalligrapherAssets {
    val dense = mutableMapOf<String, DenseTensor>()
    val sparse = mutableMapOf<String, SparseTensor>()

    val buffer = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
    var at = 0

    fun need(count: Int) {
        if (at + count > data.size) throw CalligrapherWeightsError.Truncated()
    }
    fun u8(): Int {
        need(1)
        val value = data[at].toInt() and 0xff
        at += 1
        return value
    }
    fun u16(): Int {
        need(2)
        val value = buffer.getShort(at).toInt() and 0xffff
        at += 2
        return value
    }
    fun u32(): Int {
        need(4)
        val value = buffer.getInt(at)
        at += 4
        return value
    }

    while (at < data.size) {
        val nameLength = u8()
        need(nameLength)
        val name = buildString {
            for (i in 0 until nameLength) append((data[at + i].toInt() and 0xff).toChar())
        }
        at += nameLength

        val isSparse = u8() != 0
        val count = u32()

        need(4 * count)
        val values = FloatArray(count)
        for (i in 0 until count) values[i] = buffer.getFloat(at + 4 * i)
        at += 4 * count

        var deltas: ByteArray? = null
        if (isSparse) {
            need(count)
            deltas = data.copyOfRange(at, at + count)
            at += count
        }

        val dims = u8()
        val shape = mutableListOf<Int>()
        for (i in 0 until dims) shape.add(u16())
        val size = shape.fold(1) { a, b -> a * b }

        if (isSparse && name in csrTensors) {
            sparse[name] = toCsr(values, deltas!!, rows = shape[0], cols = shape[1])
        } else if (isSparse) {
            val scattered = FloatArray(size)
            var index = 0
            for (i in 0 until count) {
                index += deltas!![i].toInt() and 0xff
                scattered[index] = values[i]
            }
            dense[name] = DenseTensor(shape, scattered)
        } else {
            dense[name] = DenseTensor(shape, values)
        }
    }

    val styles = dense["g"] ?: throw CalligrapherWeightsError.MissingStyleTensor()
    return CalligrapherAssets(dense, sparse, styleCount = styles.shape[0])
}

private fun toCsr(values: FloatArray, deltas: ByteArray, rows: Int, cols: Int): SparseTensor {
    val keptValues = mutableListOf<Float>()
    val colIndex = mutableListOf<Int>()
    val rowOf = mutableListOf<Int>()
    var absolute = 0
    for (i in values.indices) {
        absolute += deltas[i].toInt() and 0xff
        if (values[i] != 0f) {
            keptValues.add(values[i])
            colIndex.add(absolute % cols)
            rowOf.add(absolute / cols)
        }
    }
    val rowPtr = IntArray(rows + 1)
    var cursor = 0
    for (row in 0 until rows) {
        while (cursor < rowOf.size && rowOf[cursor] == row) cursor += 1
        rowPtr[row + 1] = cursor
    }
    return SparseTensor(
        rows = rows,
        cols = cols,
        values = keptValues.toFloatArray(),
        colIndex = colIndex.toIntArray(),
        rowPtr = rowPtr,
    )
}
