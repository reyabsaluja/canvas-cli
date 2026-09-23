export type ScrollbarState =
  | "idle" // arrow hint at the bottom right
  | "compressed" // arrow folded into a single rounded line
  | "extended" // line grown to full track height
  | "split" // line broken into a column of dots
  | "tracking"; // dots extend left near the current section

export const AXIS_MARGIN_RIGHT = 40;
const IDLE_TIP_MARGIN_BOTTOM = 40;
const SPLIT_DOT_LENGTH = 0.01; // Nonzero so the cap still renders

export const POSE_ORDER = [
  "idle",
  "compressed",
  "extended",
  "split",
  "tracking",
] as const;

export type LineEndpoints = readonly [
  x1: number,
  y1: number,
  x2: number,
  y2: number,
];

type Pose = {
  leftWing: LineEndpoints;
  rightWing: LineEndpoints;
  pieces: readonly LineEndpoints[]; // dotCount entries
};

type Size = { width: number; height: number };

export type Geometry = {
  arrowLength: number;
  wingSpread: number;
  lineLength: number;
  dotCount: number;
};

/** The line drawn as a merge of short collinear segments (extended pose). */
const linePieces = (
  x: number,
  top: number,
  bottom: number,
  dotCount: number
): LineEndpoints[] => {
  const step = (bottom - top) / dotCount;
  return Array.from(
    { length: dotCount },
    (_, i): LineEndpoints => [x, top + i * step, x, top + (i + 1) * step]
  );
};

/** The same segments collapsed to points (split pose). */
const dotPieces = (
  x: number,
  top: number,
  bottom: number,
  dotCount: number
): LineEndpoints[] => {
  const step = (bottom - top) / dotCount;
  return Array.from({ length: dotCount }, (_, i): LineEndpoints => {
    const center = top + (i + 0.5) * step;
    return [x, center - SPLIT_DOT_LENGTH / 2, x, center + SPLIT_DOT_LENGTH / 2];
  });
};

export const getPoses = ({ width, height }: Size, geometry: Geometry) => {
  const verticalAxis = width - AXIS_MARGIN_RIGHT;
  const bottomY = height - IDLE_TIP_MARGIN_BOTTOM;
  const extendedLineTop = height / 2 - geometry.lineLength / 2;
  const extendedLineBottom = height / 2 + geometry.lineLength / 2;
  const shaftPieces = linePieces(
    verticalAxis,
    bottomY - geometry.arrowLength,
    bottomY,
    geometry.dotCount
  );

  const splitBottomDotCenter =
    extendedLineBottom - geometry.lineLength / geometry.dotCount / 2;

  const dotsPose: Pose = {
    leftWing: [
      verticalAxis,
      splitBottomDotCenter,
      verticalAxis,
      splitBottomDotCenter,
    ],
    rightWing: [
      verticalAxis,
      splitBottomDotCenter,
      verticalAxis,
      splitBottomDotCenter,
    ],
    pieces: dotPieces(
      verticalAxis,
      extendedLineTop,
      extendedLineBottom,
      geometry.dotCount
    ),
  };

  return {
    idle: {
      leftWing: [
        verticalAxis - geometry.wingSpread,
        bottomY - geometry.wingSpread,
        verticalAxis,
        bottomY,
      ],
      rightWing: [
        verticalAxis + geometry.wingSpread,
        bottomY - geometry.wingSpread,
        verticalAxis,
        bottomY,
      ],
      pieces: shaftPieces,
    },
    compressed: {
      leftWing: [verticalAxis, bottomY, verticalAxis, bottomY],
      rightWing: [verticalAxis, bottomY, verticalAxis, bottomY],
      pieces: shaftPieces,
    },
    extended: {
      // The collapsed wings ride the line's bottom end from here on, so they
      // stay hidden under its round cap.
      leftWing: [
        verticalAxis,
        extendedLineBottom,
        verticalAxis,
        extendedLineBottom,
      ],
      rightWing: [
        verticalAxis,
        extendedLineBottom,
        verticalAxis,
        extendedLineBottom,
      ],
      pieces: linePieces(
        verticalAxis,
        extendedLineTop,
        extendedLineBottom,
        geometry.dotCount
      ),
    },
    split: dotsPose,
    tracking: dotsPose,
  } satisfies Partial<Record<ScrollbarState, Pose>>;
};

export const getTargetForState = (state: ScrollbarState): number => {
  const i = POSE_ORDER.findIndex((pose) => pose === state);
  return i === -1 ? POSE_ORDER.length - 1 : i;
};
