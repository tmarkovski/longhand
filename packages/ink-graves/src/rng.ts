/**
 * Deterministic RNG for sampling. sfc32 seeded via splitmix32, normal
 * deviates via Box-Muller. Determinism only needs to hold within this
 * engine (same seed, same strokes); it does not track the MLX reference,
 * whose RNG is a different algorithm entirely.
 */

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spare: number | null = null;

  constructor(seed: number) {
    // splitmix32 to spread one 32-bit seed into four state words
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

  /** Standard normal deviate. */
  normal(): number {
    if (this.spare !== null) {
      const value = this.spare;
      this.spare = null;
      return value;
    }
    let u1 = this.uniform();
    while (u1 === 0) u1 = this.uniform();
    const u2 = this.uniform();
    const radius = Math.sqrt(-2 * Math.log(u1));
    this.spare = radius * Math.sin(2 * Math.PI * u2);
    return radius * Math.cos(2 * Math.PI * u2);
  }

  /** Sample an index proportionally to non-negative weights. */
  categorical(weights: Float32Array): number {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let target = this.uniform() * total;
    for (let i = 0; i < weights.length; i++) {
      target -= weights[i];
      if (target < 0) return i;
    }
    return weights.length - 1;
  }
}
