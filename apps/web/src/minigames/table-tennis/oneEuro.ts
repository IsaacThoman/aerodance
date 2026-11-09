/*
 * The one-euro filter (Casiez et al., 2012): smooths hard while a value holds still and less as
 * it moves fast, so a resting hand doesn't jitter and a swing doesn't lag. minCutoff (Hz) sets
 * the smoothing at rest; beta how quickly it opens up with speed (units a second).
 */

const alpha = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

export class OneEuro {
  private x: number[] | null = null;
  private dx: number[] = [];
  private t = 0;
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  constructor(minCutoff: number, beta: number, dCutoff = 1) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; }

  /** The filtered value of a sample taken at t (seconds). */
  filter(value: readonly number[], t: number): number[] {
    if (!this.x || t <= this.t || value.length !== this.x.length || t - this.t > 0.5) {
      this.x = [...value]; this.dx = value.map(() => 0); this.t = t;
      return [...this.x];
    }
    const dt = t - this.t;
    this.t = t;
    const ad = alpha(this.dCutoff, dt);
    this.dx = value.map((v, i) => this.dx[i] + ad * ((v - this.x![i]) / dt - this.dx[i]));
    const speed = Math.hypot(...this.dx);
    const a = alpha(this.minCutoff + this.beta * speed, dt);
    this.x = value.map((v, i) => this.x![i] + a * (v - this.x![i]));
    return [...this.x];
  }
  reset() { this.x = null; }
}
