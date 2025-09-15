// leftMarginDetector.js

/**
 * Detect left-side staff lines and optionally return positions for condensed canvas.
 *
 * Aligns X with vertical runs (from staffDetector) but draws/returns the visible
 * line offset to the right by CONFIG.LEFT_LINE_OFFSET_PX so it doesn't sit on top
 * of the blanking rectangle.
 *
 * @param {CanvasRenderingContext2D} ctx - Canvas context (original page)
 * @param {Array} staffGroups - Array of staff group objects
 * @param {Array} stavesByGroup - Array of arrays of staff objects (parallel to staffGroups)
 * @param {Array} groupVerticalRuns - Array of vertical runs { x, start, end }
 * @param {Object} CONFIG - Configuration constants (expects LEFT_LINE_OFFSET_PX)
 * @param {HTMLInputElement} debugMode - Checkbox (or object with .checked) to enable debug visualization
 * @param {boolean} returnPositions - If true, return array of { x, startY, endY } instead of drawing
 * @returns {Array} Array of { x, startY, endY } when returnPositions === true
 */
export function detectLeftMargins(ctx, staffGroups, stavesByGroup, groupVerticalRuns = [], CONFIG = {}, debugMode, returnPositions = false) {
  const canvasWidth = ctx.canvas.width;
  const lines = [];

  // offset in pixels to move visible line to the right of the runX
  const offsetPx = Number.isFinite(CONFIG.LEFT_LINE_OFFSET_PX) ? Math.round(CONFIG.LEFT_LINE_OFFSET_PX) : 1;

  staffGroups.forEach((group, gIndex) => {
    const staves = stavesByGroup[gIndex];
    if (!staves || staves.length === 0) return;

    // Overlay bounds use ALL detected staves in the group (good for debugging)
    const overlayTop = Math.min(...staves.map(s => (s.topLine ?? s.start)));
    const overlayBottom = Math.max(...staves.map(s => (s.bottomLine ?? s.end)));
    const overlayHeight = Math.max(1, overlayBottom - overlayTop);

    // Surviving staves determine the actual vertical black line for normal mode
    const survivingStaves = staves.filter(s => s.hasNotes || s.hasStems);
    let lineStartY = null;
    let lineEndY = null;
    if (survivingStaves.length) {
      lineStartY = Math.min(...survivingStaves.map(s => (s.topLine ?? s.start)));
      lineEndY = Math.max(...survivingStaves.map(s => (s.bottomLine ?? s.end)));
    }

    // Determine canonical run X from groupVerticalRuns (fallback to tolerance)
    let runX = Math.floor(canvasWidth * (CONFIG.LEFT_GROUP_TOLERANCE ?? 0.2));
    if (groupVerticalRuns && groupVerticalRuns.length) {
      if (survivingStaves.length) {
        const wantTop = survivingStaves[0].start;
        const wantBottom = survivingStaves[survivingStaves.length - 1].end;
        const candidateXs = groupVerticalRuns
          .filter(r => r.start <= wantTop && r.end >= wantBottom)
          .map(r => r.x);
        if (candidateXs.length) {
          runX = Math.max(...candidateXs);
        } else {
          const groupRangeCandidates = groupVerticalRuns
            .filter(r => !(r.end < group.start || r.start > group.end))
            .map(r => r.x);
          if (groupRangeCandidates.length) runX = Math.max(...groupRangeCandidates);
        }
      } else {
        const groupRangeCandidates = groupVerticalRuns
          .filter(r => !(r.end < group.start || r.start > group.end))
          .map(r => r.x);
        if (groupRangeCandidates.length) runX = Math.max(...groupRangeCandidates);
      }
    }

    // Draw/return the visible line at runX + offsetPx
    const drawX = runX + offsetPx;

    // Collect positions for condensed rendering (use drawX so condensed lines match visible)
    if (lineStartY !== null && lineEndY !== null) {
      lines.push({ x: drawX, startY: lineStartY, endY: lineEndY });
    }

    if (!returnPositions) {
      // Draw canonical black vertical line at drawX
      if (lineStartY !== null && lineEndY !== null) {
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(drawX, lineStartY);
        ctx.lineTo(drawX, lineEndY);
        ctx.stroke();

        // small centered dot (only in debug)
        if (debugMode?.checked) {
          ctx.fillStyle = 'black';
          ctx.beginPath();
          ctx.arc(drawX, Math.round((lineStartY + lineEndY) / 2), 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Simple translucent overlay covering all detected staves (only in debug)
      if (debugMode?.checked) {
        // overlay should use runX as width so it stops flush with the blanking rectangle
        ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
        ctx.fillRect(0, overlayTop, runX, overlayHeight);
      }
    }
  });

  return returnPositions ? lines : [];
}
