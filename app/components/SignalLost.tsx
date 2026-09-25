import {useEffect, useRef, useState} from 'react';
import {Link, useLocation} from 'react-router';
import {TriangleAlert} from 'lucide-react';
import {ScrambleText} from '~/components/ScrambleText';
import {Txt} from '~/components/Txt';
import {copyText, editAttrs} from '~/lib/copy';

/**
 * The 404 easter egg. An FPV "lost signal / failsafe" screen - the quad has
 * flown out of range, the OSD telemetry has flatlined, and the only way back
 * is RTH (Return To Home). Rendered inside the site header and footer;
 * the one primary action is Shop.
 */
export function SignalLost() {
  const location = useLocation();
  const path = location.pathname || '/';
  const [link, setLink] = useState(2);
  const failedAt = useRef(false);

  // RSSI death-rattle: link quality stutters down to nothing, then locks at 0.
  useEffect(() => {
    if (failedAt.current) return;
    let raf = 0;
    let t = 0;
    const tick = () => {
      t += 1;
      // jittery decay - a few false-hope flickers before it gives up
      const noise = Math.sin(t * 0.7) * Math.sin(t * 0.21);
      const v = Math.max(0, 2 + noise * 1.4 - t * 0.06);
      setLink(v);
      if (v <= 0.02) {
        setLink(0);
        failedAt.current = true;
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const bars = [0.2, 0.45, 0.7, 1.0];
  const status = copyText('not-found.status') ?? '404';

  return (
    <div className="signal-lost" role="alert">
      <div className="signal-lost-osd">
        {/* top telemetry rail */}
        <div className="osd-rail osd-rail-top">
          <span className="osd-stat">
            BATT <b>0.0</b>V
          </span>
          <span className="osd-rec">
            <i />
            <Txt id="not-found.osd_rec" />
          </span>
          <span className="osd-stat osd-rssi">
            RSSI{' '}
            <span className="osd-bars" aria-hidden="true">
              {bars.map((threshold, i) => (
                <i key={i} data-on={link >= threshold ? '1' : '0'} />
              ))}
            </span>
            <b>{Math.min(100, Math.round(link * 50))}%</b>
          </span>
        </div>

        {/* center stage */}
        <div className="osd-stage">
          {/* The glitch layers are ::before/::after reading data-glitch, so
              the status has to be a plain string in two places. */}
          <p
            className="signal-lost-status"
            data-glitch={status}
            {...editAttrs('not-found.status')}
          >
            {status}
          </p>
          <p className="signal-lost-title" {...editAttrs('not-found.title')}>
            {/* Decode-in on the failsafe banner - corrupted-link flavor for
                the OSD scene, and the one deliberate scramble easter egg the
                design brief allows. */}
            <ScrambleText
              text={copyText('not-found.title') ?? 'SIGNAL LOST'}
              duration={900}
              delay={200}
            />
          </p>
          <p className="signal-lost-sub">
            <Txt id="not-found.sub_prefix" /> <code>{path}</code>
          </p>
        </div>

        {/* bottom telemetry rail */}
        <div className="osd-rail osd-rail-bottom">
          <Txt id="not-found.osd_gps" className="osd-stat" />
          <span className="osd-stat osd-warn">
            <TriangleAlert
              size={12}
              strokeWidth={2}
              aria-hidden="true"
              style={{display: 'inline', verticalAlign: '-1px', marginRight: '0.4em'}}
            />
            <Txt id="not-found.osd_failsafe" />
          </span>
          <Txt id="not-found.osd_alt" className="osd-stat" />
        </div>
      </div>

      <div className="signal-lost-actions">
        <Link to="/products" prefetch="intent" className="hero-cta-primary">
          <Txt id="not-found.cta_shop" />
        </Link>
        <Link to="/">
          <Txt id="not-found.cta_home" />
        </Link>
      </div>
    </div>
  );
}
