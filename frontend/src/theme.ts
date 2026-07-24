// ---------------------------------------------------------------------------
// Design tokens — white / signal-yellow theme.
//
// Concept: this page is a live instrument panel for API traffic, not a
// document. White keeps it feeling clean and premium; yellow is used the
// way a signal light or an oscilloscope trace is used — sparingly, to mark
// what's active right now (a running test, a live stream, the primary
// action). Everything else stays quiet so the yellow actually means
// something when it shows up.
//
// The console used to break the theme by going full black — it's been
// brought back into the same white/cream family so the whole page reads as
// one instrument, not a light page with a terminal bolted on.
// ---------------------------------------------------------------------------

export const MONO =
  '"JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
export const SANS =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

// Surfaces
export const BG = "#FFFFFF";
export const SURFACE = "#FAFAF8";
export const SURFACE_RAISED = "#F4F2EA";
export const SURFACE_SUNKEN = "#F7F6F1";

export const GOLD = "#F5C400";

// Borders
export const BORDER = "#ECEAE0";
export const BORDER_STRONG = "#DEDBCB";
export const BORDER_HOVER = "#C9C5AE";

// Text
export const TEXT_PRIMARY = "#16160F";
export const TEXT_SECONDARY = "#4B4A3E";
export const TEXT_TERTIARY = "#8C8874";
export const TEXT_QUIET = "#BAB69E";

// Signal yellow — the one accent, spent deliberately
export const ACCENT = "#F5C400";
export const ACCENT_HOVER = "#E0B300";
export const ACCENT_SOFT = "#FEF6D8";
export const ACCENT_TEXT = "#5C4900"; // for text placed on a yellow fill's soft variant

// Status
export const LIVE = "#1AA35C";
export const LIVE_SOFT = "#EAF9F0";
export const ERROR = "#D6432E";
export const ERROR_SOFT = "#FCEEEB";

// Console — same family as the rest of the page, just the "instrument
// readout" register: mono type on a slightly sunken cream, not black.
export const CONSOLE_BG = "#FCFBF6";
export const CONSOLE_BORDER = "#E7E3D2";
export const CONSOLE_TEXT = "#2C2B22";
export const CONSOLE_TEXT_DIM = "#9A9680";

// Layout
export const SIDEBAR_WIDTH = 276;
export const CONTENT_MAX_WIDTH = 1680; // page now spans full width up to this cap
export const CONSOLE_HEIGHT_NARROW = 220;
export const CONSOLE_HEIGHT_WIDE = 420;
// kept for backward compatibility with any other file still importing these
export const CONSOLE_WIDTH_NARROW = 380;
export const CONSOLE_WIDTH_WIDE = 620;
