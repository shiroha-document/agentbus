import type { Transition, Variants } from "motion/react";

// Motion tokens (ui-guidelines §6).
export const springSoft: Transition = { type: "spring", stiffness: 260, damping: 30 };
export const springSnappy: Transition = { type: "spring", stiffness: 420, damping: 32 };
export const easeOut: Transition = { duration: 0.24, ease: [0.22, 1, 0.36, 1] };
export const reducedFade: Transition = { duration: 0.12, ease: "linear" };

export const STAGGER_S = 0.04;
export const STAGGER_MAX_S = 0.32;

export function staggerDelay(i: number): number {
  return Math.min(i * STAGGER_S, STAGGER_MAX_S);
}

/** Entrance: opacity 0, y 8, blur 4px → visible. Reduced motion: 120ms fade only. */
export function enterVariants(reduced: boolean): Variants {
  if (reduced) {
    return {
      hidden: { opacity: 0 },
      show: () => ({ opacity: 1, transition: reducedFade }),
    };
  }
  return {
    hidden: { opacity: 0, y: 8, filter: "blur(4px)" },
    show: (i: number = 0) => ({
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      transition: { ...easeOut, delay: staggerDelay(i) },
    }),
  };
}

/** New post arriving: slides in from below. */
export function arriveVariants(reduced: boolean): Variants {
  if (reduced) return enterVariants(true);
  return {
    hidden: { opacity: 0, y: 24 },
    show: () => ({ opacity: 1, y: 0, transition: springSoft }),
  };
}
