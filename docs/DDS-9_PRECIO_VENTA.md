# DDS-9: precio de venta positivo

Corrección técnica del 26/11/2026. Incidencia: https://esan-calidadec-ldznsm4o.atlassian.net/browse/DDS-9

La interfaz ya exigía un precio positivo, pero la API aceptaba crear o editar una presentación con precio cero. Era posible registrar una venta de total cero y descontar stock.

## Comportamiento después del cambio

- Crear o editar una presentación exige un precio entero entre 1 y 1.000.000.000 céntimos; precio cero devuelve HTTP 400.
- Si una base anterior conserva un precio cero o inválido, la venta devuelve HTTP 409 y pide corregirlo. No cambia el registro existente automáticamente.
- Una cesta que contiene esa presentación se rechaza completa: conserva productos, ventas, caja y movimientos.
- El administrador puede corregir el precio mediante la edición habitual y volver a vender. Se conserva la idempotencia.
- Apertura/cierre de caja y costes de compra admiten sus ceros válidos; el límite monetario general no cambió.

## Verificación registrada

Base del cambio: `008b6bb701351e1cc3c9d1d831967a3d0e94ece2`. Rama de trabajo: `codex/dds-9-precio-positivo`.

El 26/11/2026 se ejecutaron:

```text
npm.cmd run check
npm.cmd run build
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=2 server/tests/*.test.ts
```

Check y build correctos. Suite completa: **103 aprobadas, 0 fallos y 0 omitidas**, incluyendo las ocho regresiones nuevas de `server/tests/sale-price.test.ts`. Tres verifican validadores y cinco ejercitan HTTP con una base PGlite temporal aislada. Las ocho están incluidas en las 103.

La fixture de compatibilidad persiste un precio cero directamente en una base temporal para representar un dato anterior a la corrección. Se comprueba que se pueda abrir esa base, rechazar la venta, corregir el registro y vender sin duplicación. Nunca usa la base de la demostración.

Logs originales: carpeta `tmp/stockfix-continuacion-20261126/` del espacio de trabajo académico. Su ejecución corresponde al árbol de trabajo de este cambio; el PR identificará el commit publicado.

## Revisión humana pendiente

Otro integrante debe revisar el diff y los casos, registrar su revisión en el PR y comprobar el criterio de aceptación. El resultado automatizado no acredita esa aprobación ni el cierre del DoD. Jira permanece abierto hasta completar el flujo acordado.
