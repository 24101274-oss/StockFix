import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../server/app.js';

let application: ReturnType<typeof buildApp> | undefined;
function getApplication() {
  if (!application) {
    const origin = process.env.APP_ORIGIN;
    application = buildApp({ databaseUrl: process.env.DATABASE_URL, production: true, seed: false,
      serveStatic: false, allowedOrigins: [origin, process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined].filter((value): value is string => Boolean(value)),
      lookup: { token: '', dniEnabled: false, rucEnabled: false } });
    application.catch(() => { application = undefined; });
  }
  return application;
}
export default async function handler(request: IncomingMessage, response: ServerResponse) {
  // Vercel's named rewrite adds its route match to the query. It is transport
  // metadata, not an application filter. Preserve every other query parameter.
  const address = new URL(request.url ?? '/', 'https://stockfix.invalid');
  if (address.searchParams.get('path') === address.pathname.replace(/^\/api\//, '')) {
    address.searchParams.delete('path');
    request.url = address.pathname + address.search;
  }
  if (!process.env.DATABASE_URL) { response.statusCode = 503; response.end('Configuración de datos pendiente.'); return; }
  try {
    const app = await getApplication();
    await app.ready();
    await new Promise<void>(resolve => {
      response.once('finish', resolve);
      response.once('close', resolve);
      app.server.emit('request', request, response);
    });
  } catch {
    response.statusCode = 503;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ message: 'El servicio está iniciando. Vuelve a intentar.' }));
  }
}
