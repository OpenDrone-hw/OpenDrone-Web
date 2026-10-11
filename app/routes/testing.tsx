import {useEffect, useState} from 'react';
import type {Route} from './+types/testing';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {copyText} from '~/lib/copy';

/**
 * The Incutec testing explorer: the bench app's Analyse screen built for a
 * static host, with the published views as saved graphs. It runs the app's
 * own Python in the browser (Pyodide) over the recordings in
 * `public/testing-explorer/chunks/`, so any field of any included recording
 * can be drawn. `root.tsx` renders this route without the storefront chrome.
 * A hash such as `#/analyse/<view id>` opens that saved graph.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('testing.meta_title') ?? 'Testing',
    description: copyText('testing.meta_description') ?? '',
    canonical: `${SITE_ORIGIN}/testing`,
  });

const EXPLORER = '/testing-explorer/index.html';

export default function TestingRoute() {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(EXPLORER + (window.location.hash || ''));
  }, []);
  return (
    <main style={{position: 'fixed', inset: 0, background: '#FBFBFA'}}>
      {src ? (
        <iframe
          title="Incutec testing explorer"
          src={src}
          style={{border: 0, width: '100%', height: '100%', display: 'block'}}
        />
      ) : null}
    </main>
  );
}
