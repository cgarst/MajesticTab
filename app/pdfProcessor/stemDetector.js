// stemDetector.js

/**
 * Detect stems below a staff
 * @param {CanvasRenderingContext2D} ctx - Canvas context for optional debug drawing
 * @param {Uint8ClampedArray} data - ImageData.data from the canvas
 * @param {number} width - Canvas width
 * @param {number} height - Canvas height
 * @param {Object} staff - Staff object { start, end }
 * @param {number} nextStaffTop - Y coordinate of the next staff top
 * @param {Object} CONFIG - Configuration constants
 * @param {HTMLInputElement} debugMode - Checkbox to enable debug visualization
 * @returns {Array} candidateRuns - Array of stem candidate rectangles { minX, maxX, minY, maxY }
 */
export function detectStems(ctx, data, width, height, staff, nextStaffTop, CONFIG, debugMode) {
  const scanTop = staff.end;
  const scanBottom = staff.end + CONFIG.EXTRA_BOTTOM_SCAN;
  const visited = new Array(width * height).fill(false);
  const candidateRuns = [];

  for (let x = Math.floor(width * CONFIG.LEFT_IGNORE); x < Math.floor(width * CONFIG.RIGHT_IGNORE); x++) {
    for (let y = scanTop; y <= Math.min(scanBottom, nextStaffTop - 1); y++) {
      const idx = (y * width + x) * 4;
      const lumValue = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];

      if (lumValue < CONFIG.LUMINANCE_THRESHOLD && !visited[y * width + x]) {
        const stack = [[x, y]];
        let minX = x, maxX = x, minY = y, maxY = y;

        while (stack.length) {
          const [cx, cy] = stack.pop();
          if (
            cx < Math.floor(width * CONFIG.LEFT_IGNORE) ||
            cx >= Math.floor(width * CONFIG.RIGHT_IGNORE) ||
            cy < scanTop ||
            cy >= nextStaffTop
          ) continue;

          const cIdx = cy * width + cx;
          if (visited[cIdx]) continue;
          const pixelIdx = cIdx * 4;
          const pixelLum = 0.299 * data[pixelIdx] + 0.587 * data[pixelIdx + 1] + 0.114 * data[pixelIdx + 2];
          if (pixelLum >= CONFIG.LUMINANCE_THRESHOLD) continue;

          visited[cIdx] = true;
          minX = Math.min(minX, cx);
          maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy);
          maxY = Math.max(maxY, cy);

          [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]].forEach(([nx, ny]) => stack.push([nx, ny]));
        }

        if (maxY - minY + 1 >= CONFIG.MIN_STEM_HEIGHT_PX) {
          candidateRuns.push({ minX, maxX, minY, maxY });

          // --- Debug: draw purple box for candidate stem ---
          if (debugMode?.checked && ctx) {
            ctx.fillStyle = 'purple';
            ctx.fillRect(minX, minY, maxX - minX + 1, maxY - minY + 1);
          }
        }
      }
    }
  }

  return candidateRuns;
}
