function findStaffBottomContent(ctx, canvasWidth, canvasHeight, startY, maxScanY, blankRowThreshold = 8) {
  if (!ctx || startY >= maxScanY) return startY;
  const scanHeight = maxScanY - startY + 1;
  const imgData = ctx.getImageData(0, startY, canvasWidth, scanHeight);
  const data = imgData.data;

  let lastContentY = startY;
  let consecutiveBlank = 0;

  for (let y = 0; y < scanHeight; y++) {
    let rowHasContent = false;
    for (let x = Math.floor(canvasWidth * 0.05); x < Math.floor(canvasWidth * 0.95); x++) {
      const idx = (y * canvasWidth + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
      if (a > 0 && (r < 220 || g < 220 || b < 220)) {
        rowHasContent = true;
        break;
      }
    }

    if (rowHasContent) {
      lastContentY = startY + y;
      consecutiveBlank = 0;
    } else {
      consecutiveBlank++;
      if (consecutiveBlank >= blankRowThreshold) {
        break;
      }
    }
  }

  return lastContentY;
}

export function detectMargins(ctx, staffGroups, stavesByGroup, groupVerticalRuns = [], CONFIG, debugMode) {
  const keptMargins = [];
  const betweenGroupSections = [];

  let prevGroupBottom = 0;
  let prevGroupHasContent = false;
  let prevGroupMarginBottom = 0;

  const canvasWidth = ctx?.canvas?.width ?? 0;
  const canvasHeight = ctx?.canvas?.height ?? 0;

  staffGroups.forEach((group, gIndex) => {
    const staves = stavesByGroup[gIndex];
    if (!staves || staves.length === 0) return;

    const groupHasNotesOrStems = staves.some(s => s.hasNotes || s.hasStems);

    // --- Between-group sections (teal) ---
    let sectionStart = 0;
    let sectionEnd = staves[0].start;

    if (gIndex === 0) {
      sectionStart = 0;
      sectionEnd = Math.max(sectionEnd, 0);
    } else {
      sectionStart = prevGroupHasContent
        ? Math.max(prevGroupMarginBottom, prevGroupBottom)
        : prevGroupBottom;
      sectionEnd = group.start;
    }

    // Reduce sectionEnd by minimum top margin
    sectionEnd = Math.max(sectionStart, sectionEnd - CONFIG.MIN_TOP_MARGIN_ABOVE_GROUP);

    // --- Trim whitespace of between-group section ---
    if (ctx && sectionEnd > sectionStart) {
      const imageData = ctx.getImageData(0, sectionStart, canvasWidth, sectionEnd - sectionStart);
      const data = imageData.data;
      let firstContentRow = -1;
      let lastContentRow = -1;

      for (let y = 0; y < imageData.height; y++) {
        let rowHasContent = false;
        for (let x = 0; x < canvasWidth; x++) {
          const idx = (y * canvasWidth + x) * 4;
          const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
          if (a > 0 && (r < 250 || g < 250 || b < 250)) {
            rowHasContent = true;
            break;
          }
        }
        if (rowHasContent) {
          if (firstContentRow === -1) firstContentRow = y;
          lastContentRow = y;
        }
      }

      if (gIndex === 0) {
        if (firstContentRow !== -1) {
          sectionStart += firstContentRow;
        }
      } else {
        if (firstContentRow !== -1) {
          const padTop = CONFIG.BETWEEN_GROUP_PADDING_TOP ?? 10;
          const padBottom = CONFIG.BETWEEN_GROUP_PADDING_BOTTOM ?? 8;
          const newStart = Math.max(sectionStart, sectionStart + firstContentRow - padTop);
          const newEnd = Math.min(sectionEnd, sectionStart + lastContentRow + padBottom);
          sectionStart = newStart;
          sectionEnd = newEnd;
        } else {
          const gap = CONFIG.INTER_SYSTEM_GAP ?? 16;
          sectionStart = Math.max(sectionStart, sectionEnd - gap);
        }
      }
    }

    if (sectionEnd > sectionStart && (gIndex === 0 || groupHasNotesOrStems)) {
      betweenGroupSections.push({ start: sectionStart, end: sectionEnd });
      if (debugMode?.checked && ctx) {
        ctx.strokeStyle = 'teal';
        ctx.lineWidth = 2;
        ctx.strokeRect(0, sectionStart, canvasWidth, sectionEnd - sectionStart);
      }
    }

    // --- Kept margins (orange) ---
    let prevMarginBottom = group.start;

    staves.forEach((s, si) => {
      let marginTop = prevMarginBottom;

      if (si === 0) {
        marginTop = Math.max(0, prevMarginBottom - CONFIG.MIN_TOP_MARGIN_ABOVE_GROUP);
      } else if (!staves[si - 1].hasNotes) {
        marginTop = Math.max(0, s.start - CONFIG.MIN_TOP_MARGIN_ABOVE_GROUP);
      }

      const stemMaxY = s.candidateRuns.reduce((acc, r) => Math.max(acc, r.maxY), s.end);
      const bottomScanLimit = si < staves.length - 1
        ? staves[si + 1].start - 1
        : (gIndex < staffGroups.length - 1 ? staffGroups[gIndex + 1].start - 1 : canvasHeight - 1);

      const contentMaxY = findStaffBottomContent(
        ctx,
        canvasWidth,
        canvasHeight,
        s.end,
        Math.min(bottomScanLimit, s.end + (CONFIG.EXTRA_BOTTOM_SCAN ?? 50)),
        CONFIG.BLANK_ROW_THRESHOLD ?? 8
      );

      const detectedBottom = Math.max(
        s.end + CONFIG.CONTENT_TOLERANCE_ABOVE_STAFF,
        stemMaxY,
        contentMaxY
      );

      const marginBottom = detectedBottom + CONFIG.EXTRA_BOTTOM_PADDING;

      if (s.hasNotes && !debugMode?.checked) {
        keptMargins.push({ marginTop, marginBottom });
      }

      // Determine vertical X for left-side blanking
      let verticalX;
      const staffRunXs = (groupVerticalRuns || [])
        .filter(r => r.start <= s.start && r.end >= s.end)
        .map(r => r.x);

      if (staffRunXs.length) {
        verticalX = Math.max(...staffRunXs);
      } else {
        const groupRunXs = (groupVerticalRuns || [])
          .filter(r => !(r.end < group.start || r.start > group.end))
          .map(r => r.x);
        verticalX = groupRunXs.length
          ? Math.max(...groupRunXs)
          : Math.floor(canvasWidth * CONFIG.LEFT_GROUP_TOLERANCE) - 1;
      }

      // Draw left-side blanking
      if (si > 0) {
        const prevStaff = staves[si - 1];
        if (!(prevStaff.hasNotes && s.hasNotes)) {
          if (ctx) {
            ctx.fillStyle = debugMode?.checked ? 'rgba(255,0,255,0.3)' : 'white';
            const rectTop = prevStaff.end + 1;
            const rectHeight = (s.start - prevStaff.end) - 1;
            if (rectHeight > 0) ctx.fillRect(0, rectTop, verticalX + 2, rectHeight);
          }
        }
      }

      if (si < staves.length - 1) {
        const nextStaff = staves[si + 1];
        if (!(s.hasNotes && nextStaff.hasNotes)) {
          if (ctx) {
            ctx.fillStyle = debugMode?.checked ? 'rgba(255,0,255,0.3)' : 'white';
            const rectTop = s.end + 1;
            const rectHeight = (nextStaff.start - s.end) - 1;
            if (rectHeight > 0) ctx.fillRect(0, rectTop, verticalX + 2, rectHeight);
          }
        }
      }

      if (debugMode?.checked && ctx) {
        ctx.strokeStyle = 'orange';
        ctx.lineWidth = 2;
        ctx.strokeRect(0, marginTop, canvasWidth, marginBottom - marginTop);
      }

      prevMarginBottom = marginBottom;
      if (si === staves.length - 1) prevGroupMarginBottom = marginBottom;
    });

    prevGroupBottom = group.end + CONFIG.EXTRA_BOTTOM_PADDING;
    prevGroupHasContent = groupHasNotesOrStems;
  });

  return { keptMargins, betweenGroupSections };
}
