/**
 * Character set of the calligrapher model, extracted verbatim from the
 * vendored engine's `H` map (vendor/calligrapher-ai/engine.pretty.js).
 * Ids 0-3 are control codes: 0 pad, 1 unknown, 2 start-of-text,
 * 3 end-of-text. Text is encoded as [START, ...chars, END], with
 * unmapped characters falling back to UNKNOWN.
 */

export const UNKNOWN = 1;
export const START = 2;
export const END = 3;

const ENTRIES: Array<[string, number]> = [
  ['"', 4], ["M", 5], ["r", 6], [".", 7], [" ", 8], ["A", 9], ["z", 10],
  ["u", 11], ["m", 12], ["i", 13], ["a", 14], ["n", 15], ["'", 16],
  ["s", 17], ["S", 18], ["e", 19], ["c", 20], ["t", 21], ["y", 22],
  ["I", 23], ["w", 24], ["o", 25], ["l", 26], ["d", 27], ["k", 28],
  ["p", 29], ["h", 30], ["T", 31], ["b", 32], ["g", 33], ["v", 34],
  ["f", 35], ["O", 36], [",", 37], ["N", 38], ["V", 39], ["-", 40],
  ["H", 41], ["E", 42], ["j", 43], ["x", 44], ["G", 45], ["P", 46],
  ["B", 47], ["L", 48], ["q", 49], ["Y", 50], ["?", 51], ["D", 52],
  ["F", 53], ["W", 54], ["R", 55], ["#", 56], ["C", 57], ["K", 58],
  ["1", 59], ["9", 60], ["5", 61], ["0", 62], ["2", 63], ["J", 64],
  ["U", 65], ["(", 66], [")", 67], ["4", 68], ["3", 69], ["7", 70],
  ["6", 71], ["!", 72], [";", 73], [":", 74], ["Q", 75], ["8", 76],
  ["/", 77], ["Z", 78], ["X", 79], ["*", 80], ["[", 81], ["+", 82],
  ["]", 83], ["&", 84],
];

export const CHAR_TO_ID: ReadonlyMap<string, number> = new Map(ENTRIES);

/** Every printable character the model can write. */
export const ALPHABET: readonly string[] = ENTRIES.map(([character]) => character);
