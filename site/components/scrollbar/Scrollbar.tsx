"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  EASE_IN_OUT_CUBIC,
  EASE_OUT_CUBIC,
  lerp,
  resolveTransition,
} from "./transitions";
import {
  AXIS_MARGIN_RIGHT,
  getPoses,
  getTargetForState,
  POSE_ORDER,
  type Geometry,
  type LineEndpoints,
  type ScrollbarState,
} from "./poses";
import "./scrollbar.css";

/**
 * Section rail, adapted from Lucas Jin's "scrollbar but cooler"
 * (github.com/LucasHJin/scrollbar-but-cooler). The original maps its dots to
 * even fractions of page scroll; here each dot is one section of the article,
 * so the rail doubles as the table of contents.
 */

export type ScrollbarSection = { id: string; label: string };

const SETTINGS = {
  arrow: {
    arrowLength: 28,
    wingSpread: 8,
    bobAmplitude: 3,
    bobPeriod: 2,
    hitPadding: 10,
  },
  line: { length: 400 },
  tracking: {
    maxExtension: 30,
    extensionFalloff: 0.6,
    colorFalloff: 0.3,
    smoothingTau: 0.05,
    hitPadding: 10,
  },
  timing: {
    compressed: { duration: 0.15, ease: EASE_OUT_CUBIC },
    extended: { duration: 0.35, ease: EASE_IN_OUT_CUBIC },
    split: { duration: 0.2, ease: EASE_OUT_CUBIC },
    tracking: { duration: 0.2, ease: EASE_OUT_CUBIC },
  },
} as const;

type Rgb = readonly [r: number, g: number, b: number];

const parseHexColor = (hex: string): Rgb => {
  const digits = hex.trim().slice(1);
  const full =
    digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits;
  const n = parseInt(full, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

const mixColors = (from: Rgb, to: Rgb, t: number) =>
  `rgb(${Math.round(lerp(from[0], to[0], t))}, ${Math.round(
    lerp(from[1], to[1], t)
  )}, ${Math.round(lerp(from[2], to[2], t))})`;

const getStateForScroll = (scrollY: number): ScrollbarState =>
  scrollY > 0 ? "tracking" : "idle";

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface AnimState {
  current: number;
  target: number;
  rafId: number | null;
  lastTime: number;
  state: ScrollbarState;
}

export default function Scrollbar({
  sections,
  dotColor = "#a6a6a6",
  hoverColor = "#72d6c1",
  strokeWidth = 4,
  lineLength = SETTINGS.line.length,
}: {
  sections: ScrollbarSection[];
  dotColor?: string;
  hoverColor?: string;
  strokeWidth?: number;
  /** Height of the dot column in px. Smaller packs the dots closer. */
  lineLength?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const leftWingRef = useRef<SVGLineElement>(null);
  const rightWingRef = useRef<SVGLineElement>(null);
  const pieceRefs = useRef<(SVGLineElement | null)[]>([]);
  const hitRefs = useRef<(SVGRectElement | null)[]>([]);
  const arrowHitRef = useRef<SVGRectElement>(null);

  const anim = useRef<AnimState>({
    current: 0,
    target: 0,
    rafId: null,
    lastTime: 0,
    state: "idle",
  });
  const didEnter = useRef(false); // For entry animation
  const bobTime = useRef(0);

  // Kept in a ref so the effect doesn't re-run when the array identity changes.
  // Declared before the main effect so it is already in sync on mount.
  const sectionsRef = useRef(sections);
  useLayoutEffect(() => {
    sectionsRef.current = sections;
  });

  const [labels, setLabels] = useState<{ id: string; label: string; y: number }[]>(
    []
  );
  const [focusIndex, setFocusIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const dotCount = sections.length;
  const sectionKey = sections.map((s) => s.id).join(",");

  useLayoutEffect(() => {
    const svg = svgRef.current;
    const leftWing = leftWingRef.current;
    const rightWing = rightWingRef.current;
    const pieces = pieceRefs.current
      .slice(0, dotCount)
      .filter((el): el is SVGLineElement => el !== null);
    const hits = hitRefs.current
      .slice(0, dotCount)
      .filter((h): h is SVGRectElement => h !== null);
    const arrowHit = arrowHitRef.current;
    if (
      !svg ||
      !leftWing ||
      !rightWing ||
      !arrowHit ||
      dotCount === 0 ||
      pieces.length < dotCount ||
      hits.length < dotCount
    )
      return;

    const a = anim.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const canHover = window.matchMedia("(hover: hover)");

    const transitions = [
      resolveTransition(SETTINGS.timing.compressed),
      resolveTransition(SETTINGS.timing.extended),
      resolveTransition(SETTINGS.timing.split),
      resolveTransition(SETTINGS.timing.tracking),
    ];

    const geometry: Geometry = {
      arrowLength: SETTINGS.arrow.arrowLength,
      wingSpread: SETTINGS.arrow.wingSpread,
      lineLength,
      dotCount,
    };
    let poses = getPoses(svg.getBoundingClientRect(), geometry);

    /** Mirror the dot positions into state so the labels can sit beside them. */
    const syncLabels = () => {
      setLabels(
        sectionsRef.current.slice(0, dotCount).map((section, i) => {
          const [, y1, , y2] = poses.split.pieces[i];
          return { id: section.id, label: section.label, y: (y1 + y2) / 2 };
        })
      );
    };

    /** Which section is currently being read. */
    const getFocusDot = () => {
      const probe = window.scrollY + window.innerHeight * 0.35;
      const atBottom =
        window.scrollY + window.innerHeight >=
        document.documentElement.scrollHeight - 2;
      if (atBottom) return dotCount - 1;

      let focus = 0;
      sectionsRef.current.forEach((section, i) => {
        const el = document.getElementById(section.id);
        if (el && el.getBoundingClientRect().top + window.scrollY <= probe) {
          focus = i;
        }
      });
      return focus;
    };

    const scrollToDot = (dot: number) => {
      const el = document.getElementById(sectionsRef.current[dot]?.id ?? "");
      el?.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "start",
      });
    };

    const scrollDownOneViewport = () => {
      window.scrollTo({
        top: window.scrollY + window.innerHeight,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    };

    const getExtensionLength = (dot: number, focusDot: number) =>
      SETTINGS.tracking.maxExtension *
      SETTINGS.tracking.extensionFalloff ** Math.abs(dot - focusDot);

    // Invisible strips between dots, reaching out to the extended dot length
    const placeHitAreas = () => {
      const spacing = lineLength / dotCount;
      hits.forEach((el, i) => {
        const [x, y1, , y2] = poses.split.pieces[i];
        el.setAttribute(
          "x",
          String(
            x - SETTINGS.tracking.maxExtension - SETTINGS.tracking.hitPadding
          )
        );
        el.setAttribute("y", String((y1 + y2) / 2 - spacing / 2));
        el.setAttribute(
          "width",
          String(
            SETTINGS.tracking.maxExtension + 2 * SETTINGS.tracking.hitPadding
          )
        );
        el.setAttribute("height", String(spacing));
      });

      const [, , verticalAxis, bottomY] = poses.idle.leftWing;
      const arrowHitTop =
        bottomY -
        SETTINGS.arrow.arrowLength -
        SETTINGS.arrow.bobAmplitude -
        SETTINGS.arrow.hitPadding;
      const arrowHitBottom =
        bottomY + SETTINGS.arrow.bobAmplitude + SETTINGS.arrow.hitPadding;
      arrowHit.setAttribute(
        "x",
        String(
          verticalAxis - SETTINGS.arrow.wingSpread - SETTINGS.arrow.hitPadding
        )
      );
      arrowHit.setAttribute("y", String(arrowHitTop));
      arrowHit.setAttribute(
        "width",
        String(2 * (SETTINGS.arrow.wingSpread + SETTINGS.arrow.hitPadding))
      );
      arrowHit.setAttribute("height", String(arrowHitBottom - arrowHitTop));
    };

    const baseDotColor = parseHexColor(dotColor);
    const baseHoverColor = parseHexColor(hoverColor);

    let hoveredDot: number | null = null;
    let arrowHovered = false;
    const applyHoverColors = () => {
      // In idle every line is part of the arrow, so tint them together
      const arrowStroke = arrowHovered ? "var(--dot-hover-color)" : "";
      leftWing.style.stroke = arrowStroke;
      rightWing.style.stroke = arrowStroke;
      pieces.forEach((el, i) => {
        el.style.stroke = arrowHovered
          ? arrowStroke
          : hoveredDot === null
            ? ""
            : mixColors(
                baseDotColor,
                baseHoverColor,
                SETTINGS.tracking.colorFalloff ** Math.abs(i - hoveredDot)
              );
      });
    };

    const extensions = new Float64Array(dotCount);
    let lastFocus = -1;
    const advanceExtensions = (dt: number): boolean => {
      const focusDot = getFocusDot();
      if (focusDot !== lastFocus) {
        lastFocus = focusDot;
        setFocusIndex(focusDot);
      }
      // Cover alpha of the remaining gap this frame, not all of it at once
      const alpha = reduceMotion.matches
        ? 1
        : 1 - Math.exp(-dt / SETTINGS.tracking.smoothingTau);
      let settled = true;
      for (let i = 0; i < dotCount; i++) {
        const targetLength = getExtensionLength(i, focusDot);
        const frameLength =
          extensions[i] + (targetLength - extensions[i]) * alpha;
        if (Math.abs(targetLength - frameLength) < 0.05) {
          extensions[i] = targetLength;
        } else {
          extensions[i] = frameLength;
          settled = false;
        }
      }
      return settled;
    };

    const setLine = (
      el: SVGLineElement,
      f: LineEndpoints,
      g: LineEndpoints,
      s: number,
      extendLeft = 0,
      offsetY = 0
    ) => {
      el.setAttribute("x1", String(lerp(f[0], g[0], s) - extendLeft));
      el.setAttribute("y1", String(lerp(f[1], g[1], s) + offsetY));
      el.setAttribute("x2", String(lerp(f[2], g[2], s)));
      el.setAttribute("y2", String(lerp(f[3], g[3], s) + offsetY));
    };

    const applyGeometry = (t: number) => {
      const segment = Math.min(
        Math.max(Math.floor(t), 0),
        transitions.length - 1
      );
      const from = poses[POSE_ORDER[segment]];
      const to = poses[POSE_ORDER[segment + 1]];
      const local = transitions[segment].ease(t - segment);
      const trackingExtensionScale =
        segment === transitions.length - 1 ? local : 0;
      const idleBobScale = segment === 0 ? 1 - local : 0;
      const bobOffset =
        idleBobScale *
        SETTINGS.arrow.bobAmplitude *
        Math.sin((2 * Math.PI * bobTime.current) / SETTINGS.arrow.bobPeriod);

      setLine(leftWing, from.leftWing, to.leftWing, local, 0, bobOffset);
      setLine(rightWing, from.rightWing, to.rightWing, local, 0, bobOffset);
      pieces.forEach((el, i) =>
        setLine(
          el,
          from.pieces[i],
          to.pieces[i],
          local,
          trackingExtensionScale * extensions[i],
          bobOffset
        )
      );
    };

    const syncState = () => {
      const next = getStateForScroll(window.scrollY);
      if (next !== a.state) {
        a.state = next;
        svg.dataset.state = next;
        setExpanded(next === "tracking");
        if (next !== "tracking" && hoveredDot !== null) {
          hoveredDot = null;
          applyHoverColors();
        }
        if (next !== "idle" && arrowHovered) {
          arrowHovered = false;
          applyHoverColors();
        }
      }
    };

    const advance = (dt: number) => {
      if (reduceMotion.matches) {
        a.current = a.target;
        return;
      }
      let remaining = dt;
      while (remaining > 0 && a.current !== a.target) {
        const dir = a.target > a.current ? 1 : -1;
        // At a boundary, use the segment in the direction of travel
        const segment =
          dir > 0
            ? Math.min(Math.floor(a.current), transitions.length - 1)
            : Math.max(Math.ceil(a.current) - 1, 0);
        // Stop at the target or the boundary, whichever comes first, so
        // transition speeds don't bleed across segments
        const boundary = dir > 0 ? segment + 1 : segment;
        const stop =
          dir > 0 ? Math.min(a.target, boundary) : Math.max(a.target, boundary);
        const { duration } = transitions[segment];
        const timeToStop = Math.abs(stop - a.current) * duration;
        if (timeToStop <= remaining) {
          a.current = stop;
          remaining -= timeToStop;
        } else {
          a.current += (remaining / duration) * dir;
          remaining = 0;
        }
      }
    };

    const step = (now: number) => {
      const dt = Math.min((now - a.lastTime) / 1000, 0.1);
      a.lastTime = now;
      advance(dt);
      const extensionsSettled = advanceExtensions(dt);
      if (!reduceMotion.matches) bobTime.current += dt;
      applyGeometry(a.current);
      const bobbing = a.current === 0 && !reduceMotion.matches;
      if (a.current === a.target && extensionsSettled && !bobbing) {
        a.rafId = null;
        return;
      }
      a.rafId = requestAnimationFrame(step);
    };

    const kick = () => {
      if (a.rafId === null) {
        a.lastTime = performance.now();
        a.rafId = requestAnimationFrame(step);
      }
    };

    const onScroll = () => {
      syncState();
      a.target = getTargetForState(a.state);
      kick();
    };

    syncState();
    a.target = getTargetForState(a.state);
    if (!didEnter.current) {
      // On load, play only the final transition into the target pose; snap
      // when reduced motion is requested.
      a.current = reduceMotion.matches ? a.target : Math.max(a.target - 1, 0);
      didEnter.current = true;
    }
    const mountFocusDot = getFocusDot();
    for (let i = 0; i < dotCount; i++) {
      extensions[i] = getExtensionLength(i, mountFocusDot);
    }
    applyGeometry(a.current);
    placeHitAreas();
    syncLabels();
    kick();

    const resizeObserver = new ResizeObserver(() => {
      poses = getPoses(svg.getBoundingClientRect(), geometry);
      applyGeometry(a.current);
      placeHitAreas();
      syncLabels();
    });
    resizeObserver.observe(svg);

    const hoverHandlers = hits.map((el, i) => {
      const enter = () => {
        if (!canHover.matches) return;
        hoveredDot = i;
        setHoveredIndex(i);
        applyHoverColors();
      };
      const leave = () => {
        if (hoveredDot !== i) return;
        hoveredDot = null;
        setHoveredIndex(null);
        applyHoverColors();
      };
      el.addEventListener("mouseenter", enter);
      el.addEventListener("mouseleave", leave);
      return { el, enter, leave };
    });

    const clickHandlers = hits.map((el, i) => {
      const click = () => scrollToDot(i);
      el.addEventListener("click", click);
      return { el, click };
    });

    const arrowEnter = () => {
      if (!canHover.matches) return;
      arrowHovered = true;
      applyHoverColors();
    };
    const arrowLeave = () => {
      arrowHovered = false;
      applyHoverColors();
    };
    arrowHit.addEventListener("mouseenter", arrowEnter);
    arrowHit.addEventListener("mouseleave", arrowLeave);
    arrowHit.addEventListener("click", scrollDownOneViewport);

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      hoverHandlers.forEach(({ el, enter, leave }) => {
        el.removeEventListener("mouseenter", enter);
        el.removeEventListener("mouseleave", leave);
      });
      clickHandlers.forEach(({ el, click }) =>
        el.removeEventListener("click", click)
      );
      arrowHit.removeEventListener("mouseenter", arrowEnter);
      arrowHit.removeEventListener("mouseleave", arrowLeave);
      arrowHit.removeEventListener("click", scrollDownOneViewport);
      window.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
      if (a.rafId !== null) cancelAnimationFrame(a.rafId);
      a.rafId = null;
    };
  }, [sectionKey, dotCount, dotColor, hoverColor, lineLength]);

  return (
    <>
      <svg
        ref={svgRef}
        className="scrollbar"
        data-state="idle"
        aria-hidden="true"
        style={
          {
            "--dot-color": dotColor,
            "--dot-hover-color": hoverColor,
            "--stroke-width": strokeWidth,
          } as CSSProperties
        }
      >
        <line ref={leftWingRef} />
        <line ref={rightWingRef} />
        {sections.map((section, i) => (
          <line
            key={section.id}
            ref={(el) => {
              pieceRefs.current[i] = el;
            }}
          />
        ))}
        {sections.map((section, i) => (
          <rect
            key={section.id}
            className="hit-area"
            ref={(el) => {
              hitRefs.current[i] = el;
            }}
          />
        ))}
        <rect ref={arrowHitRef} className="arrow-hit" />
      </svg>

      {labels.map(({ id, label, y }, i) => (
        <span
          key={id}
          className={`scrollbar-label font-rounded text-[12px] tracking-[-0.02em] ${
            expanded ? "opacity-100" : "opacity-0"
          } ${
            i === focusIndex || i === hoveredIndex
              ? "text-foreground"
              : "text-neutral-400 dark:text-neutral-500"
          }`}
          style={{
            top: y,
            right: AXIS_MARGIN_RIGHT + SETTINGS.tracking.maxExtension + 12,
          }}
        >
          {label}
        </span>
      ))}
    </>
  );
}
