/**
 * Back-to-front order for the instances of one blended draw, as three.js orders separate
 * transparent objects: farther first, ties in creation order. Many small blended things
 * (clouds, bubbles) draw as one instanced mesh, so they have to be sorted here.
 *
 * The order changes little from frame to frame, so an insertion sort over the last order
 * costs about one pass.
 */
export class DepthOrder {
  /** Instance indices, farthest first. */
  readonly order: Uint32Array;
  private readonly depth: Float64Array;

  constructor(count: number) {
    this.order = Uint32Array.from({ length: count }, (_, i) => i);
    this.depth = new Float64Array(count);
  }

  /**
   * Sorts by depth along the view direction (fx, fy, fz) from the eye (ex, ey, ez), given each
   * instance's position at positions[i * stride + offset ...]. Returns true when the order changed.
   */
  update(positions: ArrayLike<number>, stride: number, offset: number, ex: number, ey: number, ez: number, fx: number, fy: number, fz: number): boolean {
    const { order, depth } = this;
    const n = order.length;
    for (let i = 0; i < n; i++) {
      const k = i * stride + offset;
      depth[i] = (positions[k] - ex) * fx + (positions[k + 1] - ey) * fy + (positions[k + 2] - ez) * fz;
    }
    let changed = false;
    for (let i = 1; i < n; i++) {
      const v = order[i], d = depth[v];
      let j = i - 1;
      // Farther first; equal depths keep the lower index first.
      while (j >= 0 && (depth[order[j]] < d || (depth[order[j]] === d && order[j] > v))) { order[j + 1] = order[j]; j--; }
      if (j !== i - 1) { order[j + 1] = v; changed = true; }
    }
    return changed;
  }
}
