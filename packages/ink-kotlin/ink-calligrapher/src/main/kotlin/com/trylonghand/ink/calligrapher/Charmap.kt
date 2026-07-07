/// Character set of the calligrapher model, ported verbatim from
/// packages/ink-calligrapher/src/charmap.ts (itself extracted from the
/// vendored engine's `H` map). Ids 0-3 are control codes: 0 pad, 1 unknown,
/// 2 start-of-text, 3 end-of-text. Text is encoded as [START, ...chars,
/// END], with unmapped characters falling back to UNKNOWN.

package com.trylonghand.ink.calligrapher

internal const val UNKNOWN: Int = 1
internal const val START: Int = 2
internal const val END: Int = 3

private val entries: List<Pair<Char, Int>> = listOf(
    '"' to 4, 'M' to 5, 'r' to 6, '.' to 7, ' ' to 8, 'A' to 9, 'z' to 10,
    'u' to 11, 'm' to 12, 'i' to 13, 'a' to 14, 'n' to 15, '\'' to 16,
    's' to 17, 'S' to 18, 'e' to 19, 'c' to 20, 't' to 21, 'y' to 22,
    'I' to 23, 'w' to 24, 'o' to 25, 'l' to 26, 'd' to 27, 'k' to 28,
    'p' to 29, 'h' to 30, 'T' to 31, 'b' to 32, 'g' to 33, 'v' to 34,
    'f' to 35, 'O' to 36, ',' to 37, 'N' to 38, 'V' to 39, '-' to 40,
    'H' to 41, 'E' to 42, 'j' to 43, 'x' to 44, 'G' to 45, 'P' to 46,
    'B' to 47, 'L' to 48, 'q' to 49, 'Y' to 50, '?' to 51, 'D' to 52,
    'F' to 53, 'W' to 54, 'R' to 55, '#' to 56, 'C' to 57, 'K' to 58,
    '1' to 59, '9' to 60, '5' to 61, '0' to 62, '2' to 63, 'J' to 64,
    'U' to 65, '(' to 66, ')' to 67, '4' to 68, '3' to 69, '7' to 70,
    '6' to 71, '!' to 72, ';' to 73, ':' to 74, 'Q' to 75, '8' to 76,
    '/' to 77, 'Z' to 78, 'X' to 79, '*' to 80, '[' to 81, '+' to 82,
    ']' to 83, '&' to 84,
)

internal val charToId: Map<Char, Int> = entries.toMap()

/** Every printable character the model can write. */
public val calligrapherAlphabet: List<Char> = entries.map { it.first }
