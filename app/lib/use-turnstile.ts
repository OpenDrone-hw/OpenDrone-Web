import {useCallback, useEffect, useRef} from 'react';
import {getActiveTheme} from '~/lib/theme';

/**
 * Cloudflare Turnstile widget for a form, shared by the newsletter signup
 * and the trade form. The script loads only once `active` turns true (the
 * visitor touched the form), so pages whose forms go unused never fetch
 * it. The widget posts its token as `cf-turnstile-response`; the action
 * checks it with `verifyTurnstile` (`app/lib/turnstile.ts`).
 *
 * Render `<div ref={containerRef} />` while `active` and a site key is set.
 * A token is single-use, so call `reset()` after every server answer.
 */

type TurnstileRenderOpts = {
  sitekey: string;
  theme?: 'dark' | 'light' | 'auto';
  size?: 'normal' | 'compact' | 'flexible' | 'invisible';
  callback?: (token: string) => void;
};

type Turnstile = {
  render: (el: HTMLElement, opts: TurnstileRenderOpts) => string | undefined;
  reset: (id?: string) => void;
};

const SCRIPT_ID = 'cf-turnstile-script';

function turnstile(): Turnstile | undefined {
  return (window as unknown as {turnstile?: Turnstile}).turnstile;
}

export function useTurnstile(siteKey: string | null, active: boolean) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    if (!active || !siteKey) return;
    const key = siteKey;
    function render() {
      const cf = turnstile();
      if (!cf || !containerRef.current || widgetId.current) return;
      const id = cf.render(containerRef.current, {
        sitekey: key,
        // Match the site theme so the widget is not a dark box on a light
        // page, or the other way round.
        theme: getActiveTheme(),
        size: 'flexible',
      });
      widgetId.current = id ?? null;
    }
    if (turnstile()) {
      render();
      return;
    }
    if (document.getElementById(SCRIPT_ID)) {
      const check = window.setInterval(() => {
        if (turnstile()) {
          window.clearInterval(check);
          render();
        }
      }, 120);
      return () => window.clearInterval(check);
    }
    const s = document.createElement('script');
    s.id = SCRIPT_ID;
    s.src =
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.defer = true;
    s.onload = render;
    document.head.appendChild(s);
  }, [active, siteKey]);

  const reset = useCallback(() => {
    const cf = turnstile();
    if (cf && widgetId.current) cf.reset(widgetId.current);
  }, []);

  return {containerRef, reset};
}
