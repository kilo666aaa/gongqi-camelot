import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

function devFixturePlugin(connectionString: string): Plugin {
  return {
    name: 'gongqi-real-pg-dev-fixture',
    apply: 'serve',
    async configureServer(server) {
      const { createDevFixture } = await server.ssrLoadModule(
        '/devFixture.ts',
      ) as typeof import('./devFixture');
      const fixture = createDevFixture(connectionString);
      server.middlewares.use(fixture.handle);
      server.httpServer?.once('close', () => {
        void fixture.close();
      });
    },
  };
}

export default defineConfig(({ command }) => {
  const fixtureEnabled = command === 'serve' && process.env.GQ_WEB_FIXTURE === '1';
  const connectionString = process.env.GQ_TEST_DATABASE_URL;
  if (fixtureEnabled && !connectionString) {
    throw new Error('GQ_TEST_DATABASE_URL is required when GQ_WEB_FIXTURE=1');
  }

  return {
    envDir: '../..',
    base: command === 'build' ? '/app/' : '/',
    plugins: [
      react(),
      ...(fixtureEnabled && connectionString ? [devFixturePlugin(connectionString)] : []),
    ],
    define: {
      __GQ_DEV_FIXTURE__: JSON.stringify(fixtureEnabled),
    },
    server: { host: '127.0.0.1' },
  };
});
