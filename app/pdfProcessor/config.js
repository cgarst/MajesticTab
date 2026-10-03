// config.js

// The scale at which all base measurements were taken. Calling pdfProcessor with a scale value will adjust pixel values relative to this.
const BASE_SCALE = 1.5;

// Base pixel values calibrated at BASE_SCALE
const BASE_CONFIG = {
    SCALE: BASE_SCALE,                 // Default scale factor for rendering PDF pages
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

// List of pixel-based properties that need to be scaled
const PIXEL_PROPERTIES = [
    'MIN_STEM_HEIGHT_PX',
    'EXTRA_BOTTOM_SCAN',
    'EXTRA_BOTTOM_PADDING',
    'MIN_DIGIT_WIDTH',
    'MIN_DIGIT_HEIGHT',
    'MAX_DIGIT_WIDTH',
    'MAX_DIGIT_HEIGHT',
    'MIN_STAFF_HEIGHT_PX',
    'CONTENT_TOLERANCE_ABOVE_STAFF',
    'INBETWEEN_BOTTOM_TRIM',
    'STAFF_EDGE_DIGIT_TOLERANCE',
    'LEFT_LINE_OFFSET_PX',
    'MIN_TOP_MARGIN_ABOVE_GROUP'
];

// Function to create a scaled config
function createScaledConfig(scale = BASE_SCALE) {
    // Calculate how much we're scaling relative to our base measurements
    const scaleFactor = scale / BASE_SCALE;
    const scaledConfig = { ...BASE_CONFIG, SCALE: scale };

    // Scale all pixel-based properties
    for (const prop of PIXEL_PROPERTIES) {
        scaledConfig[prop] = Math.round(BASE_CONFIG[prop] * scaleFactor);
    }

    return scaledConfig;
}

// Export the default config and the scaling function
export const CONFIG = createScaledConfig();
export { createScaledConfig };
