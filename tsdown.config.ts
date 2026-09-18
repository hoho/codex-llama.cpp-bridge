import { defineConfig } from 'tsdown';

const entry = ['src/bridge.ts', 'src/server.ts', 'src/cli.ts'];

export default defineConfig([
  {
    entry,
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: true,
    target: 'node22',
  },
  {
    entry,
    format: ['esm'],
    dts: {
      emitDtsOnly: true,
      sourcemap: false,
    },
    sourcemap: false,
    clean: false,
    target: 'node22',
  },
]);
