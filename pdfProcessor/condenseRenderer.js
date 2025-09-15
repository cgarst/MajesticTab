// condenseRenderer.js

/**
 * Render a condensed canvas from trimmed sections of the original page.
 *
 * Parameters:
 *  - originalCtx: CanvasRenderingContext2D of the original page canvas (used to extract image data)
 *  - canvasWidth: width of original canvas (and condensed canvas)
 *  - trimmedSections: Array of { trimTop, trimBottom } in ORIGINAL canvas coordinates (must be sorted)
 *  - leftMarginLines: Array of { x, startY, endY } in ORIGINAL canvas coordinates (may be empty)
 *  - CONFIG: configuration object (for any constants you want to reuse)
 *  - debugMode: HTMLInputElement or object with .checked property — when true the renderer
 *               will draw overlays/labels within the condensed canvas
 *
 * Returns: HTMLCanvasElement (the condensed canvas)
 */
export function renderCondensedCanvas({
  originalCtx,
  canvasWidth,
  trimmedSections,
  leftMarginLines = [],
  CONFIG = {},
  debugMode = { checked: false },
}) {
  // compute final height
  const totalHeight = trimmedSections.reduce((acc, s) => acc + (s.trimBottom - s.trimTop + 1), 0);
  const condensedCanvas = document.createElement('canvas');
  condensedCanvas.width = canvasWidth;
  condensedCanvas.height = totalHeight;
  const condensedCtx = condensedCanvas.getContext('2d', { willReadFrequently: true });

  let offset = 0;

  // draw each trimmed section into condensed canvas, then draw clamped left lines for that section
  trimmedSections.forEach((sec, si) => {
    const sectionHeight = sec.trimBottom - sec.trimTop + 1;
    // copy pixel data
    const sectionImage = originalCtx.getImageData(0, sec.trimTop, canvasWidth, sectionHeight);
    condensedCtx.putImageData(sectionImage, 0, offset);

    // clip to the section area for safety
    condensedCtx.save();
    condensedCtx.beginPath();
    condensedCtx.rect(0, offset, canvasWidth, sectionHeight);
    condensedCtx.clip();

    // Draw each leftMarginLine clamped into this section
    leftMarginLines.forEach((line) => {
      // determine overlap in original coordinates
      const lineTop = Math.max(line.startY, sec.trimTop);
      const lineBottom = Math.min(line.endY, sec.trimBottom);

      if (lineTop <= lineBottom) {
        // convert into condensed canvas Y coordinates
        const y0 = offset + (lineTop - sec.trimTop);
        const y1 = offset + (lineBottom - sec.trimTop);

        condensedCtx.strokeStyle = 'black';
        condensedCtx.lineWidth = 1;
        condensedCtx.beginPath();
        condensedCtx.moveTo(line.x, y0);
        condensedCtx.lineTo(line.x, y1);
        condensedCtx.stroke();

        // Debug visuals inside condensed canvas for this line slice
        if (debugMode?.checked) {
          // faint overlay to show left-margin influence in the condensed canvas
          const overlayWidth = Math.max(1, Math.floor((line.x) || (canvasWidth * (CONFIG.LEFT_IGNORE ?? 0.05))));
          condensedCtx.fillStyle = 'rgba(0, 0, 255, 0.10)';
          condensedCtx.fillRect(0, y0, overlayWidth, y1 - y0 + 1);

          // endpoint markers (filled squares)
          condensedCtx.fillStyle = 'darkblue';
          condensedCtx.fillRect(line.x - 3, y0 - 3, 6, 6);
          condensedCtx.fillRect(line.x - 3, y1 - 3, 6, 6);

          // labels with original coordinates (helpful for debugging)
          condensedCtx.fillStyle = 'navy';
          condensedCtx.font = '11px sans-serif';
          condensedCtx.textBaseline = 'top';
          // place label to the right of the line if possible, otherwise to the left
          const labelX = Math.min(line.x + 6, canvasWidth - 80);
          condensedCtx.fillText(`o:${lineTop}`, labelX, y0);
          condensedCtx.fillText(`o:${lineBottom}`, labelX, Math.max(y1 - 12, y0 + 2));
        }
      }
    });

    condensedCtx.restore();
    offset += sectionHeight;
  });

  // final debug: draw boundaries between trimmed sections if requested (visual cue)
  if (debugMode?.checked) {
    let running = 0;
    condensedCtx.strokeStyle = 'rgba(255,0,0,0.25)';
    condensedCtx.lineWidth = 1;
    trimmedSections.forEach((sec, idx) => {
      const h = sec.trimBottom - sec.trimTop + 1;
      condensedCtx.beginPath();
      condensedCtx.moveTo(0, running + 0.5);
      condensedCtx.lineTo(canvasWidth, running + 0.5);
      condensedCtx.stroke();
      running += h;
    });
  }

  return condensedCanvas;
}
