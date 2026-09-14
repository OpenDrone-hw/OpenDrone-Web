import type {Config} from '@react-router/dev/config';
import {hydrogenPreset} from '@shopify/hydrogen/react-router-preset';

/**
 * React Router configuration.
 *
 * The Hydrogen preset stays: it is the Oxygen build toolchain (app and
 * build directories, SSR, route-module splitting), not a runtime Shopify
 * API dependency. Decision D3 keeps opendrone.be on Hydrogen/Oxygen.
 *
 * `v8_middleware` is turned back off. The preset enables it because
 * Hydrogen's own request handler passes a RouterContextProvider; this app
 * passes a plain object (app/lib/context.ts) to React Router's handler, so
 * loaders take `context.env` / `context.catalog` directly and the
 * AppLoadContext type augmentation is what describes them.
 */
export default {
  presets: [hydrogenPreset()],
  future: {
    v8_middleware: false,
  },
} satisfies Config;
