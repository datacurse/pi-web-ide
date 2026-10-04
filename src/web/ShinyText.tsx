/**
 * Adapted from React Bits ShinyText by David Haz.
 * https://github.com/DavidHDev/react-bits
 * License: ./react-bits.LICENSE.md (MIT + Commons Clause).
 */
import {
  motion,
  useAnimationFrame,
  useMotionValue,
  useTransform,
} from "motion/react";

/** Only live labels mount the animation; settled history has no frame callbacks. */
function LiveShinyText({ text }: { text: string }) {
  const progress = useMotionValue(0);
  useAnimationFrame((time) => {
    // One-second leftward sweep. Text updates do not restart the animation.
    progress.set((time % 1000) / 1000);
  });
  const backgroundPosition = useTransform(
    progress,
    (value) => `${150 - value * 200}% center`,
  );

  return (
    <motion.span className="work-shimmer" style={{ backgroundPosition }}>
      {text}
    </motion.span>
  );
}

export function ShinyText({
  text,
  active = true,
}: {
  text: string;
  active?: boolean;
}) {
  return active ? <LiveShinyText text={text} /> : <span>{text}</span>;
}
