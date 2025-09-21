/**
 * Detect copyright / footer content at the bottom of a     const finalCanvas = document.createElement('canvas');
    finalCanvas.width = canvasWidth;
    finalCanvas.height = height;
    const fctx = finalCanvas.getContext('2d', { willReadFrequently: true });.
 * Skips the first few rows of pixels to avoid leftover staff lines, trims to actual content,
 * and adds optional top padding.
 *
 * @param {CanvasRenderingContext2D} ctx - Canvas context of the page
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @param {number} lastGroupBottom - Bottom of last staff group
 * @param {number} skipTopRows - Number of pixels to skip at top to avoid last staff line (default 2)
 * @param {number} topPadding - Pixels to add at the top of the copyright canvas (default 3)
 * @returns {HTMLCanvasElement|null} - Canvas containing copyright/footer or null
 */
export function detectCopyright(ctx, canvasWidth, canvasHeight, lastGroupBottom, skipTopRows = 2, topPadding = 40) {
  let topY = lastGroupBottom;

  // Scan bottom-up for dark pixels
  const fullData = ctx.getImageData(0, 0, canvasWidth, canvasHeight).data;
  for (let y = canvasHeight - 1; y >= lastGroupBottom; y--) {
    let hasDarkPixel = false;
    for (let x = 0; x < canvasWidth; x++) {
      const idx = (y * canvasWidth + x) * 4;
      if (fullData[idx] < 150 && fullData[idx + 1] < 150 && fullData[idx + 2] < 150) {
        hasDarkPixel = true;
        break;
      }
    }
    if (hasDarkPixel) topY = y;
    else break;
  }

  if (topY < canvasHeight) {
    let height = canvasHeight - topY;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvasWidth;
    tempCanvas.height = height;
    const tctx = tempCanvas.getContext('2d');
    const imageData = ctx.getImageData(0, topY, canvasWidth, height);
    tctx.putImageData(imageData, 0, 0);

    // --- Trim top whitespace / skip initial rows ---
    const trimData = tctx.getImageData(0, 0, canvasWidth, height);
    let firstContentRow = 0;
    for (let y = skipTopRows; y < height; y++) {
      let hasDarkPixel = false;
      for (let x = 0; x < canvasWidth; x++) {
        const idx = (y * canvasWidth + x) * 4;
        if (trimData.data[idx] < 150 && trimData.data[idx + 1] < 150 && trimData.data[idx + 2] < 150) {
          hasDarkPixel = true;
          break;
        }
      }
      if (hasDarkPixel) {
        firstContentRow = y;
        break;
      }
    }

    const finalHeight = height - firstContentRow + topPadding;
    if (finalHeight <= 0) return null;

    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = canvasWidth;
    finalCanvas.height = finalHeight;
    const fctx = finalCanvas.getContext('2d');

    // Fill top padding with white
    if (topPadding > 0) {
      fctx.fillStyle = 'white';
      fctx.fillRect(0, 0, canvasWidth, topPadding);
    }

    // Copy actual copyright pixels
    const finalImageData = tctx.getImageData(0, firstContentRow, canvasWidth, height - firstContentRow);
    fctx.putImageData(finalImageData, 0, topPadding);

    return finalCanvas;
  }

  return null;
}
