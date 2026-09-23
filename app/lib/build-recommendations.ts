/**
 * The quad builds from `content/builds.json`: which sized parts belong to
 * the 3" and the 5" build. Compatibility is a hard constraint: a 20x20
 * stack only ever meets a 3" frame and 1604 motors.
 *
 * Bundler-free (relative imports) so the node:test suites can load it; the
 * build data is passed in.
 */

export type BuildRole = 'flight-controller' | 'esc' | 'frame' | 'motors' | 'receiver';

export type BuildsConfig = {
  roles: Record<BuildRole, {handle: string; sizeNeutral?: boolean}>;
  builds: Array<{
    id: string;
    label: string;
    parts: Array<{role: BuildRole; sku: string; quantity: number}>;
  }>;
};

/** Accept `content/builds.json`, or throw on anything malformed. */
export function parseBuilds(body: unknown): BuildsConfig {
  const c = body as Partial<BuildsConfig> | null;
  if (!c?.roles || !Array.isArray(c.builds)) throw new Error('builds: roles and builds are required');
  for (const build of c.builds) {
    for (const part of build.parts ?? []) {
      if (!c.roles[part.role]) throw new Error(`builds: ${build.id} uses unknown role ${part.role}`);
      if (!Number.isSafeInteger(part.quantity) || part.quantity < 1) {
        throw new Error(`builds: ${build.id} ${part.sku} needs a positive quantity`);
      }
    }
  }
  return c as BuildsConfig;
}

/** The build a SKU belongs to, or null for a part in no build (a receiver
 *  variant that no build names, say). */
export function buildOf(config: BuildsConfig, sku: string | null | undefined): string | null {
  if (!sku) return null;
  return config.builds.find((b) => b.parts.some((p) => p.sku === sku && !config.roles[p.role].sizeNeutral))?.id ?? null;
}
