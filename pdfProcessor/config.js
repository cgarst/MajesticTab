// config.js

export const CONFIG = {
  LEFT_IGNORE: 0.05,                 // Fraction of canvas width to ignore on left
  RIGHT_IGNORE: 0.95,                // Fraction of canvas width to ignore on right
  MIN_STEM_HEIGHT_PX: 8,             // Minimum height of a vertical stem in pixels
  LUMINANCE_THRESHOLD: 200,          // Threshold for considering a pixel "dark"
  EXTRA_BOTTOM_SCAN: 14,             // Extra pixels below staff to scan for stems
  EXTRA_BOTTOM_PADDING: 2,           // Extra pixels added below staff in condensed canvas
  MIN_DIGIT_WIDTH: 4,                // Minimum width of a detected digit
  MIN_DIGIT_HEIGHT: 7,               // Minimum height of a detected digit
  MAX_DIGIT_WIDTH: 20,               // Maximum width of a detected digit
  MAX_DIGIT_HEIGHT: 20,              // Maximum height of a detected digit
  MIN_STAFF_HEIGHT_PX: 25,           // Minimum vertical height to consider as a staff
  CONTENT_TOLERANCE_ABOVE_STAFF: 4,  // Extra pixels above staff considered as content
  INBETWEEN_BOTTOM_TRIM: 2,          // Trim pixels between staff groups for condensed canvas
  USE_STEMS_FOR_DECISION: false,     // Whether stems are considered along with digits for "hasNotes"
  LEFT_GROUP_TOLERANCE: 0.2,         // Fraction of width used to detect staff group vertical lines
  FIND_STEMS_IF_NO_DIGITS: false,    // Skip stem detection if there are no digits
  STAFF_EDGE_DIGIT_TOLERANCE: 4,     // Number of pixels beyond staff edges to check for digits
  LEFT_LINE_OFFSET_PX: 1,            // How many pixels to offset the visible left-line to the right of the detected vertical run
  MIN_TOP_MARGIN_ABOVE_GROUP: 2,     // Minimum margin above individual staff top
};
