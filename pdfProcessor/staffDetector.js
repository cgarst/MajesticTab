// staffDetector.js

/**
 * Detect staff groups and their vertical runs in a PDF page
 * @param {ImageData} imageData - Canvas ImageData
 * @param {number} width - Canvas width
 * @param {number} height - Canvas height
 * @param {Object} CONFIG - Configuration constants
 * @param {HTMLInputElement} debugMode - Checkbox to enable debug visualization (optional)
 * @param {CanvasRenderingContext2D} ctx - Canvas context for debug drawing (optional)
 * @returns {Object} { staffGroups, groupVerticalRuns }
 */
export function detectStaffGroups(imageData, width, height, CONFIG, debugMode, ctx) {
  const leftX = Math.floor(width * CONFIG.LEFT_GROUP_TOLERANCE);
  const minGroupHeight = Math.floor(height * 0.1);
  const minVerticalRun = Math.floor(height * 0.1);
  const verticalCounts = new Array(height).fill(0);
  const groupVerticalRuns = [];

  // --- Scan left side for vertical runs ---
  for (let x = 0; x < leftX; x++) {
    let runStart = null;
    for (let y = 0; y < height; y++) {
      const idx = (y * width + x) * 4;
      const isDark = imageData.data[idx] < 150 &&
                     imageData.data[idx + 1] < 150 &&
                     imageData.data[idx + 2] < 150;

      if (isDark && runStart === null) runStart = y;
      if ((!isDark || y === height - 1) && runStart !== null) {
        const runEnd = y - 1;
        if (runEnd - runStart + 1 >= minVerticalRun) {
          for (let yy = runStart; yy <= runEnd; yy++) verticalCounts[yy] = 1;
          groupVerticalRuns.push({ x, start: runStart, end: runEnd });

          // --- Debug: draw vertical run (optional) ---
          if (debugMode?.checked && ctx) {
            ctx.strokeStyle = 'yellow';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, runStart);
            ctx.lineTo(x, runEnd);
            ctx.stroke();
          }
        }
        runStart = null;
      }
    }
  }

  // --- Combine vertical runs into staff groups ---
  const staffGroups = [];
  let start = null;
  for (let y = 0; y < verticalCounts.length; y++) {
    if (verticalCounts[y] === 1 && start === null) start = y;
    if ((verticalCounts[y] === 0 || y === verticalCounts.length - 1) && start !== null) {
      const end = y - 1;
      if (end - start >= minGroupHeight) {
        staffGroups.push({ start, end, verticalRunX: leftX - 1 });

        // --- Debug: draw cyan box for staff group ---
        if (debugMode?.checked && ctx) {
          ctx.strokeStyle = 'cyan';
          ctx.lineWidth = 2;
          ctx.strokeRect(0, start, width, end - start);
        }
      }
      start = null;
    }
  }

  return { staffGroups, groupVerticalRuns };
}