import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { createDocumentLookup, DocumentLookupError, type LookupFetch } from '../document-lookup';

const TOKEN = 'mock-token-never-valid-outside-tests';
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const dniResponse = (dni: string) => ({ success: true, message: 'exito', data: { numero: dni, nombre_completo: '  PRUEBA LOCAL,   CLIENTE  ', nombres: 'CLIENTE', apellido_paterno: 'PRUEBA', apellido_materno: 'LOCAL', codigo_verificacion: 1, direccion: '', direccion_completa: '' } });
const rucResponse = (ruc: string) => ({ success: true, message: 'exito', data: { ruc, nombre_o_razon_social: '  EMPRESA   DE PRUEBA  ', direccion: 'AV. PRUEBA 123', direccion_completa: 'AV. PRUEBA 123, LIMA', estado: 'ACTIVO', condicion: 'HABIDO' } });
function assertSafeError(statusCode: number) {
  return (error: unknown) => {
    assert.ok(error instanceof DocumentLookupError);
    assert.equal(error.statusCode, statusCode);
    assert.match(error.message, /manual/i);
    assert.doesNotMatch(error.message, /mock-token|https:\/\/|Bearer|12345678/);
    return true;
  };
}

test('API Perú official POST contract normalizes DNI and RUC, with credentials only in headers', async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  const lookup = createDocumentLookup({ token: TOKEN, fetch: async (url, options) => {
    requests.push({ url, options });
    const body = JSON.parse(String(options.body)) as { dni?: string; ruc?: string };
    return jsonResponse(body.dni ? dniResponse(body.dni) : rucResponse(body.ruc!));
  } });
  const dni = await lookup.lookup('DNI', '12345678', 'user');
  const ruc = await lookup.lookup('RUC', '20000000001', 'user');
  assert.deepEqual({ ...dni, fetchedAt: undefined }, { documentType: 'DNI', document: '12345678', name: 'PRUEBA LOCAL, CLIENTE', address: '', source: 'api_peru', cached: false, fetchedAt: undefined });
  assert.equal(ruc.name, 'EMPRESA DE PRUEBA');
  assert.equal(ruc.address, 'AV. PRUEBA 123, LIMA');
  assert.equal(requests[0].url, 'https://api.apiperu.pe/dni');
  assert.equal(requests[1].url, 'https://api.apiperu.pe/ruc');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[0].options.body)), { dni: '12345678' });
  assert.deepEqual(JSON.parse(String(requests[1].options.body)), { ruc: '20000000001' });
  assert.equal(new Headers(requests[0].options.headers).get('Authorization'), `Bearer ${TOKEN}`);
  assert.equal(requests[0].options.redirect, 'error');
  assert.ok(dni.fetchedAt);
  assert.doesNotMatch(JSON.stringify(lookup.status()), /token|Bearer|https:/);
});

test('unconfigured or disabled provider permits manual fallback without any outbound call', async () => {
  let calls = 0;
  const mock: LookupFetch = async () => { calls++; return jsonResponse({}); };
  const disabled = createDocumentLookup({ token: '', fetch: mock });
  assert.deepEqual(disabled.status(), { provider: 'api_peru', configured: false, dniEnabled: false, rucEnabled: false });
  await assert.rejects(disabled.lookup('DNI', '12345678', 'user'), assertSafeError(404));
  const partial = createDocumentLookup({ token: TOKEN, dniEnabled: false, rucEnabled: true, fetch: mock });
  assert.equal(partial.status().rucEnabled, true);
  assert.equal(partial.status().dniEnabled, false);
  await assert.rejects(partial.lookup('DNI', '12345678', 'user'), assertSafeError(404));
  assert.equal(calls, 0);
});

test('provider token failures and exhausted quotas become safe 503 errors, never application 401', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    const lookup = createDocumentLookup({ token: TOKEN, fetch: async () => { calls++; return jsonResponse({ message: `Debug https://example.invalid/${TOKEN} Bearer ${TOKEN} DNI12345678` }, status); } });
    await assert.rejects(lookup.lookup('DNI', '12345678', 'user'), assertSafeError(503));
    assert.equal(calls, 1, 'there are no automatic provider retries');
  }
});

test('timeout aborts the request and returns manual fallback without provider credentials', async () => {
  let signal: AbortSignal | null | undefined;
  const lookup = createDocumentLookup({ token: TOKEN, timeoutMs: 15, fetch: async (_url, options) => {
    signal = options.signal;
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error(`Internal ${TOKEN}`)), { once: true }));
  } });
  await assert.rejects(lookup.lookup('DNI', '12345678', 'user'), assertSafeError(503));
  assert.equal(signal?.aborted, true);
});

test('malformed envelopes, mismatched documents, non-JSON and oversized bodies are rejected', async () => {
  const responses = [
    jsonResponse({ success: true, data: { numero: '87654321', nombre_completo: 'OTRO DOCUMENTO' } }),
    jsonResponse({ success: true, data: { numero: '12345678' } }),
    jsonResponse({ success: false, message: `Internal ${TOKEN}` }),
    new Response('<html>provider error</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('{not JSON', { headers: { 'Content-Type': 'application/json' } }),
    jsonResponse({ ...dniResponse('12345678'), irrelevant: 'x'.repeat(70 * 1024) }),
  ];
  for (const response of responses) {
    const lookup = createDocumentLookup({ token: TOKEN, fetch: async () => response });
    await assert.rejects(lookup.lookup('DNI', '12345678', 'user'), assertSafeError(503));
  }
});

test('concurrent requests share one lookup and later calls use a bounded, expiring cache', async () => {
  let calls = 0;
  let time = 1000;
  let release: ((value: Response) => void) | undefined;
  const lookup = createDocumentLookup({ token: TOKEN, now: () => time, cacheTtlMs: 50, cacheMaxEntries: 1, rateLimit: 60, fetch: async (_url, options) => {
    calls++;
    const document = (JSON.parse(String(options.body)) as { dni: string }).dni;
    if (calls === 1) return new Promise<Response>(resolve => { release = resolve; });
    return jsonResponse(dniResponse(document));
  } });
  const first = lookup.lookup('DNI', '12345678', 'user');
  const concurrent = lookup.lookup('DNI', '12345678', 'another-user');
  assert.equal(calls, 1);
  release!(jsonResponse(dniResponse('12345678')));
  assert.equal((await first).cached, false);
  assert.equal((await concurrent).cached, true);
  assert.equal((await lookup.lookup('DNI', '12345678', 'user')).cached, true);
  assert.equal(calls, 1);
  await lookup.lookup('DNI', '12345679', 'user');
  await lookup.lookup('DNI', '12345678', 'user');
  assert.equal(calls, 3, 'the cache evicts beyond its configured maximum');
  time = 2000;
  assert.equal((await lookup.lookup('DNI', '12345678', 'user')).cached, false);
  assert.equal(calls, 4, 'expired results cause one fresh provider request');
});

test('each authenticated user has a bounded query rate and no outbound call after their limit', async () => {
  let calls = 0;
  let time = 1000;
  const lookup = createDocumentLookup({ token: TOKEN, rateLimit: 2, rateWindowMs: 1000, now: () => time, fetch: async () => { calls++; return jsonResponse(dniResponse('12345678')); } });
  await lookup.lookup('DNI', '12345678', 'user-a');
  await lookup.lookup('DNI', '12345678', 'user-a');
  await assert.rejects(lookup.lookup('DNI', '12345678', 'user-a'), assertSafeError(429));
  assert.equal(calls, 1);
  await lookup.lookup('DNI', '12345678', 'user-b');
  time = 2001;
  await lookup.lookup('DNI', '12345678', 'user-a');
  assert.equal(calls, 1);
});

let app: FastifyInstance;
let cookie: string;
let outboundCalls = 0;
let mockStatus = 200;
before(async () => {
  app = await buildApp({ seed: false, lookup: { token: TOKEN, rateLimit: 3, fetch: async (url, options) => {
    outboundCalls++;
    const body = JSON.parse(String(options.body)) as { dni?: string; ruc?: string };
    if (mockStatus !== 200) return jsonResponse({ message: `Internal ${TOKEN}`, success: false }, mockStatus);
    return jsonResponse(url.endsWith('/dni') ? dniResponse(body.dni!) : rucResponse(body.ruc!));
  } } });
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@stockfix.local', password: 'AdminDemo2026!' } });
  assert.equal(response.statusCode, 200);
  cookie = String(response.headers['set-cookie']).split(';')[0];
});
after(async () => { await app.close(); });
const get = (url: string, authenticated = true) => app.inject({ method: 'GET', url: `/api${url}`, headers: authenticated ? { cookie } : {} });
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api${url}`, headers: { cookie }, payload: payload as object });

test('HTTP endpoints require authentication and reject invalid format before external calls', async () => {
  assert.equal((await get('/lookup/status', false)).statusCode, 401);
  assert.equal((await get('/lookup/dni/12345678', false)).statusCode, 401);
  assert.equal((await get('/lookup/ruc/20000000001', false)).statusCode, 401);
  assert.equal((await get('/lookup/dni/123')).statusCode, 400);
  assert.equal((await get('/lookup/ruc/20000000000')).statusCode, 400);
  assert.equal(outboundCalls, 0);
  const status = await get('/lookup/status');
  assert.deepEqual(status.json(), { provider: 'api_peru', configured: true, dniEnabled: true, rucEnabled: true });
  assert.doesNotMatch(status.body, /mock-token|https:/);
});

test('stored DNI/RUC customers and suppliers are returned first and reuse the existing customer', async () => {
  const customer = await post('/customers', { documentType: 'DNI', document: '11112222', name: 'CLIENTE GUARDADO', address: 'DIRECCIÓN GUARDADA' });
  assert.equal(customer.statusCode, 200, customer.body);
  const company = await post('/customers', { documentType: 'RUC', document: '20000000001', name: 'EMPRESA GUARDADA', address: '' });
  assert.equal(company.statusCode, 200, company.body);
  const supplier = await post('/suppliers', { ruc: '20000000001', name: 'PROVEEDOR GUARDADO', address: '', phone: '' });
  assert.equal(supplier.statusCode, 200, supplier.body);
  const dni = await get('/lookup/dni/11112222');
  assert.equal(dni.json().source, 'registro_local');
  assert.equal(dni.json().customer.id, customer.json().id);
  assert.equal(dni.json().document, '11112222');
  const ruc = await get('/lookup/ruc/20000000001');
  assert.equal(ruc.json().customer.id, company.json().id);
  assert.equal(ruc.json().name, 'EMPRESA GUARDADA');
  assert.equal(outboundCalls, 0);
});

test('external HTTP lookup does not auto-create customers and token failure keeps the local session', async () => {
  const external = await get('/lookup/dni/12345678');
  assert.equal(external.statusCode, 200, external.body);
  assert.equal(external.json().source, 'api_peru');
  assert.equal(external.json().documentType, 'DNI');
  assert.equal((await get('/customers')).json().length, 2);
  assert.equal((await get('/lookup/dni/12345678')).json().cached, true);
  assert.equal(outboundCalls, 1);
  mockStatus = 401;
  const failure = await get('/lookup/dni/12345679');
  assert.equal(failure.statusCode, 503, failure.body);
  assert.match(failure.json().message, /manualmente/);
  assert.doesNotMatch(failure.body, /mock-token|https:/);
  assert.equal((await get('/auth/me')).statusCode, 200);
  assert.equal((await get('/lookup/dni/11112222')).statusCode, 200);
});

test('HTTP rate limit returns 429 with Retry-After while stored customer lookup still works', async () => {
  const before = outboundCalls;
  const limited = await get('/lookup/dni/12345680');
  assert.equal(limited.statusCode, 429, limited.body);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.match(limited.json().message, /manualmente/);
  assert.equal(outboundCalls, before);
  assert.equal((await get('/lookup/dni/11112222')).statusCode, 200);
});
