/**
 * Deterministic uniform source: sfc32 seeded via splitmix32, the same
 * generator ink-graves uses. Only uniforms are exposed; the cell derives
 * Gumbel and normal deviates itself with the reference's exact formulas.
 */

import type { RandomSource } from "./cell.js";

export class Rng implements RandomSource {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    let s = seed >>> 0;
    const split = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = split();
    this.b = split();
    this.c = split();
    this.d = split();
    for (let i = 0; i < 12; i++) this.uniform();
  }

  /** Uniform in [0, 1). */
  uniform(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    const t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    const out = (t + this.d) | 0;
    this.c = (this.c + out) | 0;
    return (out >>> 0) / 4294967296;
  }
}
