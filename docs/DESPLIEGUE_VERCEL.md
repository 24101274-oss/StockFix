# StockFix publicado

Aplicación académica: https://stockfix-24101274.vercel.app

El frontend React/TypeScript se construye con Vite y se sirve por HTTPS en Vercel. La función `api/index.ts` entrega la misma API Fastify. Drizzle utiliza el controlador `pg` para la base persistente **Neon PostgreSQL**, conectada al proyecto `stockfix` del equipo `julio-p`. Función y base se ubican en `iad1`. La copia local conserva PGlite.

## Persistencia y concurrencia

El servidor publicado usa `DATABASE_URL`, `ADMIN_PASSWORD`, `CASHIER_PASSWORD` y `APP_ORIGIN` desde variables de entorno. Las claves de demostración local no se ofrecen en la pantalla publicada. Los accesos privados se entregan a Julio por archivo local ignorado en Git; no se incluyen en documentos ni capturas.

Los archivos de una función no almacenan la base de datos. Los datos y las sesiones permanecen en PostgreSQL. Un arranque adicional no revoca todas las sesiones cloud. La migración desde credenciales públicas iniciales conserva la revocación de las sesiones de la cuenta afectada.

Las operaciones comerciales toman un bloqueo transaccional compartido de PostgreSQL antes de comprobar y modificar existencias, caja o idempotencia. Esto protege también cuando dos instancias de la API trabajan a la vez. La cola local de PGlite se conserva para su modalidad de una conexión.

## Inicialización reproducible

La integración Neon fue provisionada mediante el Marketplace de Vercel, plan `free_v3`, región `iad1`, sin auth/realtime adicionales. La cuenta y sus términos fueron autorizados por Julio. No se instalaron servicios de IA externos ni tareas programadas.

Después de vincular un proyecto propio y descargar sus variables protegidas con la CLI, la inicialización del histórico se puede ejecutar así:

```powershell
node node_modules/tsx/dist/cli.mjs server/demo/cloud-bootstrap.ts
```

El script usa `.env.local`, exige una base vacía o el mismo manifiesto, importa en una transacción y conserva los registros de una repetición. Genera accesos privados en `tmp/cloud`, carpeta ignorada. Revisar el destino de la conexión antes de ejecutarlo; los datos locales habituales no se modifican.

## Verificación del 26 de noviembre de 2026

- TypeScript/build correctos; suite integrada **156 aprobadas, cero fallos y cero omitidas**.
- Prueba PostgreSQL en un esquema temporal nuevo: dos instancias conservaron la sesión; dos ventas concurrentes de la última unidad produjeron estados 200 y 409, una sola venta y stock cero. El esquema temporal se eliminó al finalizar; el histórico publicado permaneció intacto.
- Recorrido real con Edge en la URL pública: ingreso privado, seis productos, 368 ventas sintéticas, doce series de pronóstico, diez evaluadas y doce saldos de reposición listos.
- Descargas CSV y Excel desde los botones de la aplicación; acceso del cajero a planificación rechazado con 403. Sin errores de JavaScript ni cambios en el estado operativo durante las consultas.

```powershell
node node_modules/tsx/dist/cli.mjs scripts/verify-postgres.ts
```

Esa verificación crea únicamente un esquema `qa_cloud_…` con identificador aleatorio y lo elimina después. Utiliza la conexión directa de Neon para aislar el esquema y las mismas transacciones de la aplicación. Requiere las variables descargadas en `.env.local`.

Evidencias: [recorrido publicado](evidencias/Entrega-Vercel/verificacion-publicada.json), [PostgreSQL](evidencias/Entrega-Vercel/verificacion-postgres.json), [pruebas](evidencias/Entrega-Vercel/pruebas.txt), [resumen](evidencias/Entrega-Vercel/resumen.png), [pronóstico](evidencias/Entrega-Vercel/prediccion.png) y [reposición](evidencias/Entrega-Vercel/reposicion.png).

Se aplicaron las correcciones compatibles de dependencias antes de publicar. Quedaron dos avisos moderados transitivos relacionados con `uuid` en ExcelJS; no se forzó una sustitución incompatible de la biblioteca de reportes. Los datos siguen siendo sintéticos y los comprobantes de PRUEBA.
