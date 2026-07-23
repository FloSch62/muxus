import { loadConfig } from './config.js';
import { startServer } from './server.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

let server;
try {
  server = await startServer(config);
} catch (err) {
  console.error(err);
  process.exit(1);
}

server.app.log.info(`Muxus ready at ${server.url}`);

if (config.openBrowser) {
  const { default: open } = await import('open');
  await open(server.browserUrl).catch(() => {
    /* Headless environments keep serving; credentials are deliberately not logged. */
  });
}
