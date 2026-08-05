import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/webhooks/index.ts',
    'src/webhooks/adapters/express.ts',
    'src/webhooks/adapters/fastify.ts',
    'src/webhooks/adapters/hono.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  external: ['express', 'fastify', 'hono'],
})
