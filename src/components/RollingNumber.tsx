import { useEffect, useState } from "react";
import { useMotionValueEvent, useReducedMotion, useSpring } from "framer-motion";

interface Props {
  value: number;
  format?: (n: number) => string;
}

const defaultFormat = (n: number) => String(Math.round(n));

export default function RollingNumber({ value, format = defaultFormat }: Props) {
  const reduceMotion = useReducedMotion();
  const spring = useSpring(0, { mass: 1, stiffness: 100, damping: 30 });
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    spring.set(value);
  }, [spring, value]);

  useMotionValueEvent(spring, "change", setDisplay);

  const shown = reduceMotion ? value : display;
  return (
    <span style={{ fontVariantNumeric: "tabular-nums" }} aria-label={format(value)}>
      {format(shown)}
    </span>
  );
}
