// Cape face and UV coordinates share model-pixel units.
export const COLS = 5, ROWS = 5, W = 2;
// A 4 px shoulder strip and 3 px rows keep cuts integral and avoid the
// transient hem cracks found with 4/4/3/3/2 in the leg-swing regression.
export const HEIGHTS = [4, 3, 3, 3, 3];
export const H = r => HEIGHTS[r];
export const depth = r => HEIGHTS.slice(0, r).reduce((sum, h) => sum + h, 0);
export const restX = c => -5 + c * W;
export const restY = r => 24 - depth(r);
export const pid = (r, c) => r * (COLS + 1) + c;
export const tileId = (r, c) => (r * COLS + c).toString(36);
export const tiles = Array.from({ length: ROWS * COLS }, (_, i) => ({ r: Math.floor(i / COLS), c: i % COLS }));
