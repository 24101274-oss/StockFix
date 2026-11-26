# HU10 / DDS-11: predicción mensual de ventas

El administrador dispone de **Predicción mensual** para estimar las ventas por producto activo, presentación y ubicación. Es un cálculo estadístico local: no requiere una API de inteligencia artificial ni envía el histórico a terceros. La recomendación de reposición corresponde al siguiente incremento, DDS-12.

## Cómo usarla

1. Ingresar como administrador y abrir **Predicción mensual**.
2. Elegir una fecha de corte, entre 1 y 12 meses futuros, ubicación y producto. Presionar **Calcular pronóstico**.
3. Elegir la serie que se desea revisar. La gráfica diferencia meses completos, mes parcial y pronóstico.
4. Consultar el método, los meses utilizados, el MAE y el sesgo. Abrir **Ver comparación de métodos** para examinar la evaluación temporal.
5. Revisar la tabla: muestra presentaciones equivalentes redondeadas hacia arriba y, debajo, las piezas originalmente estimadas. Exportar CSV o Excel con los filtros del cálculo visible.

El cajero no tiene acceso a la pantalla ni a sus endpoints. El cálculo y las exportaciones son de consulta: no registran ventas, compras, reservas ni movimientos de inventario.

## Fechas, cobertura y cantidades

- Las fechas se interpretan en **America/Lima**. Las ventas anuladas y posteriores al corte se excluyen.
- Solo se entrena con meses completos. El mes del corte se muestra como parcial y no entra al entrenamiento ni a la comparación de métodos.
- El primer mes futuro es el posterior al corte. Con corte 26/11/2026 y tres meses se estiman diciembre de 2026, enero y febrero de 2027. El modelo respeta la distancia desde el último mes completo; no confunde diciembre con noviembre.
- El manifiesto sintético define la cobertura de cada producto. Dentro de ella, un mes sin ventas cuenta como cero; antes del inicio no se inventan observaciones.
- Sin manifiesto, la cobertura se infiere a partir del primer registro de la serie, excluyendo su primer mes si empezó después del día 1. Se advierte que esta inferencia supone continuidad de los registros.
- Se usan hasta 60 meses completos por serie. Un producto nuevo con menos de tres meses completos informa historial insuficiente.
- `SaleItem.units` ya representa las piezas totales de una línea. No se vuelve a multiplicar por `quantity`. La venta se asocia a su presentación registrada.
- El tamaño actual de la presentación permite convertir piezas estimadas a presentaciones equivalentes mediante `ceil(piezas / tamaño_actual)`. Si cambió el tamaño respecto de una venta histórica se muestra un aviso; la cantidad equivalente no modifica el pronóstico original.

## Métodos y evaluación temporal

Con tres a cinco meses se utiliza el promedio de los últimos tres, sin afirmar que exista una evaluación comparativa suficiente. Desde seis meses completos se reservan los últimos tres como cortes sucesivos de evaluación de un mes: cada corte utiliza exclusivamente los meses anteriores a él.

Los candidatos son último mes, promedio móvil de tres meses y tendencia lineal por mínimos cuadrados. El método de mismo mes del año anterior participa cuando cada corte dispone de al menos doce meses previos. Se selecciona el menor error absoluto medio, con desempate determinista. Después se ajusta el método seleccionado con el historial completo disponible y se estima el horizonte solicitado.

```text
MAE = promedio(|predicción − observado|)
sesgo = promedio(predicción − observado)
```

Ambos se expresan en piezas físicas. Un sesgo positivo indica sobreestimación; uno negativo, subestimación. El MAE del método base «último mes» se conserva en el resultado. No se presenta un porcentaje de exactitud ni un intervalo de confianza sin cálculo que lo respalde. Las predicciones se redondean a piezas enteras no negativas.

Esta evaluación comprueba el comportamiento histórico a un paso. No demuestra la exactitud de cada mes de un horizonte largo. Tampoco mide la demanda perdida: ventas cero durante un quiebre de stock pueden ocultar compradores que no fueron atendidos. Los datos sintéticos permiten demostrar y probar el módulo; su error no acredita desempeño comercial real.

## API y trazabilidad

```text
GET /api/forecast?cutoff=2026-11-26&horizon=3&location=all
GET /api/forecast/export?cutoff=2026-11-26&horizon=3&location=all&format=csv
GET /api/forecast/export?cutoff=2026-11-26&horizon=3&location=all&format=xlsx
```

Filtro opcional: `productId`. La fecha debe existir y no superar hoy en Lima. Ubicaciones: `all`, `puesto`, `almacen`. Se rechazan parámetros desconocidos o inválidos. Requiere sesión y rol administrador. Las exportaciones incluyen procedencia, corte, producto, presentación, mes, método y métricas. Si la base contiene el histórico de DDS-10, el origen sigue identificado en pantalla, cabeceras y nombre de descarga.

Código: `shared/forecast.ts`, `server/forecast/engine.ts`, `server/forecast/routes.ts` y `src/pages/ForecastPage.tsx`. Pruebas: `server/tests/forecast-engine.test.ts` y `server/tests/forecast-api.test.ts`.

## Verificación del 26/11/2026

```text
npm.cmd run check
npm.cmd run build
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=2 server/tests/*.test.ts
```

TypeScript y build correctos. Suite integrada: **136 aprobadas, 0 fallos, 0 omitidas**; son 119 anteriores y 17 nuevas (11 del motor, seis de API/exportación). Esta cifra no representa cobertura de código.

Los casos verifican cortes temporales estrictos y métricas exactas, comparación con el método base, selección estacional, desfase entre el mes completo y el primer mes futuro, Lima/año bisiesto, ceros conocidos frente a periodos sin cobertura, unidades físicas sin multiplicación duplicada, cambios de tamaño, cantidades inválidas, permisos y exportaciones coherentes con JSON. Las consultas y descargas preservan productos, ventas, compras, movimientos y caja.

Recorrido real con Microsoft Edge 158 sin ventana, sirviendo el build y la API sobre `data/forecast-demo`: 12 series listas, diez evaluadas con tres cortes y dos del producto nuevo con tres meses y promedio sin MAE. Corte 26/11/2026, futuro diciembre de 2026, enero y febrero de 2027. Se probaron filtros por producto/puesto, selección de serie, comparación de métodos, descargas CSV/Excel desde sus botones, vista de 390 px sin desbordamiento horizontal y aviso de historial insuficiente al retroceder el corte. Cero errores de JavaScript; productos, ventas, compras y caja permanecieron idénticos. El navegador y servidor se cerraron al terminar.

- [Pantalla de predicción](evidencias/DDS-11/prediccion.png).
- [Gráfica y comparación temporal](evidencias/DDS-11/evaluacion.png).
- [Producto nuevo sin evaluación suficiente](evidencias/DDS-11/producto-nuevo.png).
- [Vista móvil](evidencias/DDS-11/movil.png).
- [Historial insuficiente: no se inventa un pronóstico](evidencias/DDS-11/historial-insuficiente.png).
- [Resultado completo del cálculo](evidencias/DDS-11/pronostico.json).
- [Verificación UI/API y métricas por serie](evidencias/DDS-11/verificacion-ui.json).
- [Registro de las 136 pruebas](evidencias/DDS-11/pruebas.txt).

## Revisión del equipo

Revisor de esta ronda: **Victor Carbajal, `Vicar31`**. Debe comprobar las reglas temporales, las unidades por presentación, los permisos, el recorrido de pantalla y la evidencia de pruebas. Su decisión en GitHub y la aceptación funcional del Product Owner son registros distintos; ambas siguen pendientes al preparar este incremento. El enlace del PR se registra en DDS-11 al publicarlo.

Incidencia: https://esan-calidadec-ldznsm4o.atlassian.net/browse/DDS-11
