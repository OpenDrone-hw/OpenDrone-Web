import {useEffect, useRef, useState} from 'react';
import {useNavigation} from 'react-router';

/**
 * A thin top-of-viewport progress bar that runs whenever React Router is
 * between routes (navigating or submitting). The page itself renders
 * immediately - this is the "something is happening" affordance so tab
 * switches (FC/ESC/RX), product links, and any nav never feel blocked while
 * a loader resolves. Purely cosmetic: aria-hidden, no layout impact.
 */
export function RouteProgress() {
  const navigation = useNavigation();
  const active = navigation.state !== 'idle';
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0);
  const creep = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    clearInterval(creep.current);
    if (active) {
      setVisible(true);
      setProgress((p) => (p > 0 && p < 90 ? p : 8));
      // Ease toward 90% so a slow loader keeps showing motion without ever
      // claiming to be done.
      creep.current = setInterval(() => {
        setProgress((p) => (p < 90 ? p + (90 - p) * 0.12 : p));
      }, 200);
      return () => clearInterval(creep.current);
    }
    if (visible) {
      // Snap to full, then fade out.
      setProgress(100);
      const done = setTimeout(() => {
        setVisible(false);
        setProgress(0);
      }, 280);
      return () => clearTimeout(done);
    }
    return undefined;
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!visible) return null;
  return (
    <div className="route-progress" aria-hidden="true">
      <div
        className="route-progress-bar"
        style={{
          width: `${progress}%`,
          opacity: progress >= 100 ? 0 : 1,
        }}
      />
    </div>
  );
}

export default RouteProgress;
