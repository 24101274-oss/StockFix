# HU09 / DDS-10: histórico sintético reproducible

Esta ampliación prepara los datos de la predicción mensual. El motor de pronóstico y las recomendaciones de reposición corresponden a DDS-11 y DDS-12.

## Escenario verificado el 26/11/2026

```powershell
npm.cmd run demo:seed -- --as-of 2026-11-26 --seed stockfix-2026 --months 36
```

- Base independiente: `data/forecast-demo`; el importador protege `data/demo-db` y sus subcarpetas.
- Periodo completo: noviembre de 2023 a octubre de 2026. Noviembre de 2026 es parcial, observado hasta el día 26.
- Datos ficticios: 6 productos, 368 ventas, 74 compras recibidas, 3.861 movimientos y 184 sesiones de caja cerradas.
- ID: `synthetic-v1-30e8fb46ab0e8c1e4b3fe7fa`.
- SHA-256 del contenido operativo generado: `84ee07d6f443ff58e3f2a5eb3e35e7f2557dfca013341c4002f236162ef257f3`.
- La segunda carga devolvió `unchanged`, con el mismo manifiesto y sin duplicación.

Cada producto dispone de unidad y paquete. El stock conserva empaques cerrados y piezas sueltas por puesto/almacén. Las ventas guardan las piezas y el precio de la presentación de su momento. Compras, movimientos y caja concuerdan con los saldos finales. Las compras se pagan fuera de caja por transferencia; las sesiones diarias registran por separado sus medios de cobro.

El conjunto incluye tendencia, estacionalidad anual, demanda intermitente con ceros observados y un producto nuevo. La cobertura indica desde cuándo se observó cada producto: un mes sin ventas dentro de esa cobertura no equivale a un periodo anterior sin observación.

## Repetición y protección del destino

La carga valida semilla, fecha real de calendario y un rango de 12 a 60 meses antes de crear archivos. Escribe productos, proveedores, operaciones, contadores y manifiesto en una transacción. Un marcador propio reconoce el destino; una carpeta ajena, configuración distinta o inicialización incompleta se rechazan sin borrarlas.

Repetir una carga correcta verifica su identidad y la presencia de los registros originales. Conserva los cambios posteriores de ventas, caja y stock. El marcador y la base son locales y quedan fuera de Git. Para un escenario distinto se usa una carpeta nueva. Detener antes cualquier proceso que utilice el destino de carga.

## Identificación en pantalla y archivos

La interfaz autenticada muestra **DATOS SINTÉTICOS DE DEMOSTRACIÓN**, la fecha observada y la descarga del manifiesto. El origen está disponible mediante `GET /api/demo-dataset`; su manifiesto descargable usa `GET /api/demo-dataset/manifest.json`. Sin sesión se rechazan estas consultas.

Los CSV/XLSX conservan sus columnas y llevan el prefijo `DATOS_SINTETICOS_DEMOSTRACION-` en el nombre. Las respuestas incluyen `X-StockFix-Data-Origin: synthetic` y el ID del dataset. Una base sin este histórico conserva sus nombres habituales. El cajero puede identificar la procedencia, pero mantiene la restricción sobre reportes administrativos.

## Verificación

```text
npm.cmd run check
npm.cmd run build
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=2 server/tests/*.test.ts
```

Check y build correctos. Suite completa: **119 aprobadas, 0 fallos, 0 omitidas**. Incluye 103 pruebas anteriores y 16 nuevas: ocho de generación y reglas, cinco del importador/CLI y tres de procedencia/permisos/exportación. No es una medida de cobertura de código.

Las pruebas verifican identidad y reproducción, calendario/Lima, periodos observados, cantidades y dinero, conciliación de movimientos/empaques/caja, destinos protegidos, repetición después de una venta real en base temporal, reinicio, autenticación y exportaciones CSV/XLSX.

También se ejecutó el recorrido real con Microsoft Edge sin ventana: ingreso académico, banner, resumen e historial de 368 ventas, descarga del manifiesto y exportación CSV. La curva semanal se contrastó con la API tras terminar su animación. No hubo errores de JavaScript; el navegador y el servidor de prueba se cerraron al terminar.

### Evidencias del recorrido

- [Resumen con origen sintético](evidencias/DDS-10/resumen.png).
- [Ventas del histórico](evidencias/DDS-10/ventas.png).
- [Manifiesto descargado](evidencias/DDS-10/manifiesto.json).
- [Resultado del recorrido UI/API](evidencias/DDS-10/verificacion-ui.json).
- [Registro de las 119 pruebas](evidencias/DDS-10/pruebas.txt).

## Revisión y aceptación

Revisor previsto para este bloque: **Franco Pichilingue, `franco0410`**, conforme a la rotación acordada. Debe comprobar el diff, la carga/repetición y las evidencias, y registrar su decisión en el PR. La aprobación de código y la aceptación funcional del Product Owner son registros separados. El incremento aún no se presenta como aceptado.

Incidencia: https://esan-calidadec-ldznsm4o.atlassian.net/browse/DDS-10
