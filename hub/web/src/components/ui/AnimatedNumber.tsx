import { useLanguage } from "../../lib/i18n";
import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/** Rolling counter (ui-guidelines §6: 400ms). */
export function AnimatedNumber({ value, format = (n) => String(Math.round(n)) }: { value: number; format?: (n: number) => string }) {
  useLanguage();
  const reduced = useReducedMotion() ?? false;
  const [shown, setShown] = useState(value);
  const prev = useRef(0);
  useEffect(() => {
    if (reduced) {
      setShown(value);
      prev.current = value;
      return;
    }
    const ctl = animate(prev.current, value, {
      duration: 0.4,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setShown(v),
    });
    prev.current = value;
    return () => ctl.stop();
  }, [value, reduced]);
  return <span className="tabular">{format(shown)}</span>;
}
