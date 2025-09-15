// digitDetector.js
export function detectDigits(ctx, data, canvasWidth, canvasHeight, staff, config, debugMode) {
  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  let digitCount = 0;
  const visited = new Array(canvasWidth * canvasHeight).fill(false);

  for (let y = staff.start; y <= staff.end; y++) {
    for (let x = Math.floor(canvasWidth * config.LEFT_IGNORE); x < Math.floor(canvasWidth * config.RIGHT_IGNORE); x++) {
      const idx = (y * canvasWidth + x) * 4;
      const lumVal = lum(data[idx], data[idx + 1], data[idx + 2]);
      if (lumVal < config.LUMINANCE_THRESHOLD && !visited[y * canvasWidth + x]) {
        const stack = [[x, y]];
        let minX = x, maxX = x, minY = y, maxY = y;

        while (stack.length) {
          const [cx, cy] = stack.pop();
          if (cx < Math.floor(canvasWidth * config.LEFT_IGNORE) || cx >= Math.floor(canvasWidth * config.RIGHT_IGNORE)) continue;
          if (cy < staff.start - config.STAFF_EDGE_DIGIT_TOLERANCE || cy > staff.end + config.STAFF_EDGE_DIGIT_TOLERANCE) continue;

          const cIdx = cy * canvasWidth + cx;
          if (visited[cIdx]) continue;

          const pixIdx = cIdx * 4;
          if (lum(data[pixIdx], data[pixIdx + 1], data[pixIdx + 2]) >= config.LUMINANCE_THRESHOLD) continue;

          visited[cIdx] = true;
          minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
          [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]].forEach(([nx, ny]) => stack.push([nx, ny]));
        }

        const w = maxX - minX + 1;
        const h = maxY - minY + 1;
        if (w >= config.MIN_DIGIT_WIDTH && h >= config.MIN_DIGIT_HEIGHT &&
            w <= config.MAX_DIGIT_WIDTH && h <= config.MAX_DIGIT_HEIGHT &&
            !(w > h * 4 || h > w * 4)) {
          digitCount++;
          if (debugMode.checked) {
            ctx.strokeStyle = 'green';
            ctx.strokeRect(minX, minY, w, h);
          }
        }
      }
    }
  }

  return digitCount > 0;
}
