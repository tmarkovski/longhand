/// Parser for the "CALW" model containers written by tools/export_weights.py.
/// Mirrors packages/ink-graves/src/weights.ts: a 12-byte header (magic,
/// version, JSON length), a JSON header describing tensors and metadata,
/// then the raw little-endian tensor data.
///
/// Version 1 is all-float32 and carries per-style stroke tensors for live
/// priming. Version 2 stores the weight matrices as int8 with a float32
/// scale per output column (dequantized here, at parse) and replaces the
/// stroke tensors with baked primed states, one per style.

package com.trylonghand.ink.graves

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

public class Tensor(
    public val shape: List<Int>,
    public val data: FloatArray,
)

@Serializable
public data class StyleInfo(
    val id: Int,
    val primer: String,
    /** Stroke tensor to teacher-force at write time (v1 containers). */
    val tensor: String? = null,
    /** Baked primed-state tensor to restore instead (v2 containers). */
    val primed: String? = null,
)

public class ModelAssets(
    public val tensors: Map<String, Tensor>,
    public val alphabet: List<String>,
    public val maxCharLen: Int,
    public val styles: List<StyleInfo>,
)

public sealed class CALWError(message: String) : Exception(message) {
    public class NotCALW : CALWError("not a CALW container")
    public class UnsupportedVersion(version: Int) : CALWError("unsupported CALW version $version")
    public class UnsupportedDtype(dtype: String) : CALWError("unsupported dtype $dtype")
    public class MalformedQ8Tensor(name: String) : CALWError("malformed q8 tensor entry $name")
    public class Truncated : CALWError("CALW container is truncated")
    public class MissingTensor(name: String) : CALWError("missing tensor $name")
}

private const val CALW_MAGIC: Int = 0x574c_4143 // "CALW" little-endian

@Serializable
private data class Header(
    val dtype: String,
    val meta: Meta,
    val tensors: Map<String, Entry>,
) {
    @Serializable
    data class Meta(
        val alphabet: List<String>,
        val maxCharLen: Int,
        val styles: List<StyleInfo>,
    )

    @Serializable
    data class Entry(
        val shape: List<Int>,
        val offset: Int,
        val byteLength: Int,
        /** v2 only; v1 containers are implicitly all-f32. */
        val dtype: String? = null,
        val scaleOffset: Int? = null,
        val scaleByteLength: Int? = null,
        val scaleDtype: String? = null,
    )
}

private val headerJson = Json { ignoreUnknownKeys = true }

public fun parseModelAssets(data: ByteArray): ModelAssets {
    if (data.size < 12) throw CALWError.Truncated()
    val buffer = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
    val magic = buffer.getInt(0)
    if (magic != CALW_MAGIC) throw CALWError.NotCALW()
    val version = buffer.getInt(4)
    if (version != 1 && version != 2) throw CALWError.UnsupportedVersion(version)
    val headerLength = buffer.getInt(8)
    if (data.size < 12 + headerLength) throw CALWError.Truncated()

    val headerText = String(data, 12, headerLength, Charsets.UTF_8)
    val header = headerJson.decodeFromString(Header.serializer(), headerText)

    val dataStart = 12 + headerLength
    val tensors = HashMap<String, Tensor>(header.tensors.size)
    for ((name, entry) in header.tensors) {
        val dtype = if (version == 1) "f32" else (entry.dtype ?: "")
        val values = when (dtype) {
            "f32" -> readF32(data, dataStart, entry)
            "q8" -> dequantizeQ8(data, dataStart, entry, name)
            else -> throw CALWError.UnsupportedDtype(dtype)
        }
        tensors[name] = Tensor(shape = entry.shape, data = values)
    }
    return ModelAssets(
        tensors = tensors,
        alphabet = header.meta.alphabet,
        maxCharLen = header.meta.maxCharLen,
        styles = header.meta.styles,
    )
}

private fun readF32(data: ByteArray, dataStart: Int, entry: Header.Entry): FloatArray {
    val start = dataStart + entry.offset
    if (entry.offset < 0 || entry.byteLength < 0 || start + entry.byteLength > data.size) {
        throw CALWError.Truncated()
    }
    val values = FloatArray(entry.byteLength / 4)
    ByteBuffer.wrap(data, start, entry.byteLength).order(ByteOrder.LITTLE_ENDIAN)
        .asFloatBuffer().get(values)
    return values
}

/// weight[r][c] = int8[r * cols + c] * scale[c], materialized as f32.
private fun dequantizeQ8(data: ByteArray, dataStart: Int, entry: Header.Entry, name: String): FloatArray {
    val scaleOffset = entry.scaleOffset
    if (entry.shape.size != 2 || entry.scaleDtype != "f32" || scaleOffset == null) {
        throw CALWError.MalformedQ8Tensor(name)
    }
    val rows = entry.shape[0]
    val cols = entry.shape[1]
    val start = dataStart + entry.offset
    val scaleStart = dataStart + scaleOffset
    if (entry.offset < 0 || start + rows * cols > data.size ||
        scaleOffset < 0 || scaleStart + cols * 4 > data.size
    ) {
        throw CALWError.Truncated()
    }

    val scales = FloatArray(cols)
    ByteBuffer.wrap(data, scaleStart, cols * 4).order(ByteOrder.LITTLE_ENDIAN)
        .asFloatBuffer().get(scales)
    val values = FloatArray(rows * cols)
    var i = 0
    for (r in 0 until rows) {
        for (c in 0 until cols) {
            // A JVM byte is already a signed int8, matching Int8(bitPattern:).
            values[i] = data[start + i].toFloat() * scales[c]
            i += 1
        }
    }
    return values
}
