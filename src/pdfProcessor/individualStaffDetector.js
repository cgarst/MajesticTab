/**
 * Detect individual staves inside a staff group
 *
 * @param {ImageData} imageData - Image data of the page
 * @param {number} width - Width of the canvas
 * @param {Object} group - Staff group object with start/end
 * @param {number} rightXStart - X coordinate to start scanning from right
 * @param {Object} CONFIG - Configuration constants
 * @param {HTMLInputElement} debugMode - Checkbox to enable debug visualization
 * @param {CanvasRenderingContext2D} ctx - Optional canvas context for debug drawing
 * @returns {Array} Array of staff objects with start, end, topLine, bottomLine
 */
export function detectIndividualStaves(imageData, width, group, rightXStart, CONFIG, debugMode, ctx) {
  const groupHeight = group.end - group.start + 1;
  const staffCounts = new Array(groupHeight).fill(0);

  // --- Scan vertical runs to identify staff lines ---
  for (let x = rightXStart; x < width; x++) {
    let runStart = null;
    for (let y = group.start; y <= group.end; y++) {
      const idx = (y * width + x) * 4;
      const isDark =
        imageData.data[idx] < 150 &&
        imageData.data[idx + 1] < 150 &&
        imageData.data[idx + 2] < 150;

      if (isDark && runStart === null) runStart = y;
      if ((!isDark || y === group.end) && runStart !== null) {
        const runEnd = y - 1;
        if (runEnd - runStart + 1 >= Math.floor(groupHeight * 0.05)) {
          for (let yy = runStart; yy <= runEnd; yy++) staffCounts[yy - group.start] = 1;
        }
        runStart = null;
      }
    }
  }

  // --- Extract individual staves from staffCounts ---
  const staves = [];
  let sstart = null;
  for (let i = 0; i < staffCounts.length; i++) {
    if (staffCounts[i] === 1 && sstart === null) sstart = i + group.start;
    if ((staffCounts[i] === 0 || i === staffCounts.length - 1) && sstart !== null) {
      const send = i + group.start - 1;
      if (send - sstart + 1 >= CONFIG.MIN_STAFF_HEIGHT_PX) {
        // --- Compute actual top/bottom of vertical run for this staff ---
        let runTop = null;
        let runBottom = null;
        for (let x = rightXStart; x < width; x++) {
          for (let y = sstart; y <= send; y++) {
            const idx = (y * width + x) * 4;
            const isDark =
              imageData.data[idx] < 150 &&
              imageData.data[idx + 1] < 150 &&
              imageData.data[idx + 2] < 150;
            if (isDark) {
              if (runTop === null || y < runTop) runTop = y;
              if (runBottom === null || y > runBottom) runBottom = y;
            }
          }
        }

        const staff = {
          start: sstart,
          end: send,
          topLine: runTop ?? sstart,     // top of detected yellow line
          bottomLine: runBottom ?? send, // bottom of detected yellow line
          hasNotes: false,
          hasStems: false,
          hasDigits: false,
          candidateRuns: []
        };
        staves.push(staff);

        // --- Debug: draw yellow line at topLine ---
        if (debugMode?.checked && ctx) {
          ctx.strokeStyle = 'yellow';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, staff.topLine);
          ctx.lineTo(width, staff.topLine);
          ctx.stroke();
        }
      }
      sstart = null;
    }
  }

  return staves;
}
