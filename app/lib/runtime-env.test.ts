import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  assertRuntimeEnvironment,
  PRODUCTION_RUNTIME_VARIABLES,
  RuntimeConfigurationError,
} from './runtime-env.ts';

describe('runtime environment preflight', () => {
  it('keeps preview isolated with only a session secret', () => {
    assert.doesNotThrow(() => assertRuntimeEnvironment({
      RUNTIME_PROFILE: 'preview',
      SESSION_SECRET: 'preview-only',
    } as Env));
  });

  it('reports missing production variable names without values', () => {
    assert.throws(
      () => assertRuntimeEnvironment({
        RUNTIME_PROFILE: 'production',
        SESSION_SECRET: 'do-not-print',
      } as Env),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeConfigurationError);
        assert.ok(error.missing.includes('SUPPORT_ODOO_TOKEN'));
        assert.ok(!error.message.includes('do-not-print'));
        return true;
      },
    );
  });

  it('accepts a complete production environment', () => {
    const env = Object.fromEntries(
      PRODUCTION_RUNTIME_VARIABLES.map((name) => [name, 'configured']),
    ) as unknown as Env;
    env.RUNTIME_PROFILE = 'production';
    assert.doesNotThrow(() => assertRuntimeEnvironment(env));
  });
});

