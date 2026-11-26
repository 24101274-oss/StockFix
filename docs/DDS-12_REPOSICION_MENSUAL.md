# HU11 / DDS-12: reposición mensual por presentación

El administrador puede planificar cantidades por reabastecer y fechas de pedido utilizando el pronóstico de DDS-11, el inventario actual de puesto/almacén y supuestos explícitos. La consulta no crea compras, traslados ni órdenes. Las decisiones se registran posteriormente mediante los flujos del negocio.

## Recorrido de uso

1. Abrir **Reposición mensual** como administrador.
2. Elegir entre uno y doce meses futuros, reserva porcentual, plazo en días y producto. Pulsar **Calcular reposición**.
3. Elegir la presentación física. Consultar stock actual, consumo previo al primer mes, gráfico y balance mensual.
4. Abrir **Ajustar escenario** si se desea declarar recepciones pendientes o consumo del resto del mes actual. Cada recepción requiere producto, presentación, destino, cantidad, fecha y estado. Esos datos se conservan solo durante la estancia en la página.
5. Volver a calcular para aplicar los supuestos. Las exportaciones se deshabilitan mientras haya cambios sin aplicar.
6. Descargar CSV o Excel. Si las operaciones del negocio cambiaron desde el cálculo, el servidor exige recalcular antes de exportar.

El cajero no puede acceder al módulo ni a sus endpoints. Los datos sintéticos conservan su identificación en pantalla, respuestas y descargas. Los supuestos de recepciones son escenarios: no acreditan pedidos reales a un proveedor.

## Una cuenta por saldo físico

Cada empaque cerrado de más de una pieza mantiene un saldo independiente. Todas las presentaciones de una pieza comparten el único saldo de **unidades sueltas** (`presentationId: null`): sus demandas se agregan antes de consumir inventario. Así no se asigna la misma existencia a dos presentaciones unitarias distintas.

`getPackagingStock` verifica que el desglose concuerde con el total de piezas. Un total conocido sin desglose coherente sigue siendo insuficiente para inferir paquetes cerrados. Si falta conteo de puesto o almacén, se bloquea la recomendación de ese saldo. Tampoco se convierten automáticamente piezas sueltas en empaques ni se abren paquetes para cubrir unidades: el desempaque es una operación explícita separada.

La demanda física proviene del pronóstico de cada presentación/ubicación. Para empaques se convierte con `ceil(piezas / tamaño_actual)`; para unidades se conserva la cantidad de piezas. Cada dato y su equivalente físico se comprueban contra el límite de 1.000.000.000. La capacidad conjunta del producto se vuelve a validar al registrar operaciones reales, porque sumar varios saldos puede exceder el límite.

## Balance y reserva

La reserva es una meta al cierre del mes, calculada como `ceil(demanda_en_presentaciones × porcentaje / 100)` en cada ubicación. La propuesta inicial del formulario es 10 %, modificable de 0 a 100; no se presenta como acuerdo real con el negocio. El plazo inicial de 14 días es también un supuesto editable.

```text
disponible = apertura + entradas elegibles
meta = demanda + reserva
excedente_almacén = max(0, disponible_almacén − meta_almacén)
traslado = min(excedente_almacén, max(0, meta_puesto − disponible_puesto))
compra_puesto = max(0, meta_puesto − disponible_puesto − traslado)
compra_almacén = max(0, meta_almacén − disponible_almacén + traslado)
saldo_condicionado = disponible ± traslado + compra_sugerida − demanda
```

El traslado conserva cantidades: entra al puesto la misma cantidad que sale del almacén. Se protege primero la demanda y la reserva propias del almacén. La apertura del mes siguiente es el saldo condicionado del anterior; la reserva no se consume ni se vuelve a sumar como mercadería.

Ejemplo de regla, no una venta observada: demanda de 20 paquetes, stock de 8 y reserva de 10 % producen una meta de 22 y una sugerencia de 14 paquetes. Si se ejecuta, el cierre queda en 2; con la misma demanda del mes siguiente, la compra requerida es 20, no 22.

Los saldos futuros son **condicionales a ejecutar las recomendaciones y recibirlas a tiempo**. También se informa el cierre sin la compra de ese mes y la demanda que quedaría sin cubrir. Un faltante se muestra por separado; no se arrastra como si fuera mercadería física negativa.

## Fechas, recepciones y mes parcial

La fecha del plan la fija el servidor en America/Lima al consultar las existencias. No se combina stock de hoy con un corte histórico elegido por el cliente. Los meses futuros empiezan después del mes actual.

El criterio temporal es conservador: la demanda mensual y la reserva deben estar disponibles el **día 1**. No se calcula una fecha exacta diaria de quiebre. Por ello:

- Una entrada pendiente futura anterior o igual a ese día se incorpora una vez.
- Una recepción posterior al día 1 se difiere al siguiente inicio de mes. Se explica la diferencia.
- Las entradas recibidas se excluyen: ya deben estar reflejadas en el stock. Las canceladas tampoco se agregan.
- Una entrada que sigue pendiente y cuya fecha ya venció se excluye hasta confirmar o actualizar el escenario.
- Las que quedan fuera del horizonte o filtro se identifican y no se suman.

Las compras existentes de `/api/purchases` están recibidas y ya modificaron el stock. No se vuelven a sumar en la planificación. Las recepciones futuras proceden únicamente de las filas explícitas del escenario, identificadas por ID único.

La fecha límite de pedido es `día_1_del_mes − plazo_en_días`. Si pedir hoy produciría una llegada posterior, aparece un aviso de riesgo y el saldo condicional no se presenta como disponibilidad garantizada.

El **consumo previo** permite descontar salidas estimadas entre el corte y el inicio del primer mes. Con valor cero se supone que no hay salidas en ese intervalo; la aplicación lo indica expresamente. Las salidas se descuentan del stock actual antes de incorporar recepciones futuras. Si superan las existencias, se muestra un faltante que requiere intervención; no se inventa una compra ejecutada.

## API y exportación coherente

```text
POST /api/replenishment/preview
Body: { horizon, leadTimeDays, reservePercent, productId?, receipts, bridgeDemand }

POST /api/replenishment/export?format=csv|xlsx
Body: { scenario, snapshot }
```

Ambos requieren sesión de administrador. La validación rechaza campos desconocidos, referencias ajenas al catálogo activo, cantidades inválidas, IDs repetidos y consumos duplicados del mismo saldo físico/ubicación. El servidor genera dos pronósticos del corte actual, uno por ubicación, y calcula el plan de solo lectura.

La respuesta incluye la huella SHA-256 del plan. Al exportar, se recalcula con los datos actuales y se compara esa huella. Si cambió, devuelve HTTP 409 con una instrucción para recalcular. Los archivos incluyen procedencia, fecha, parámetros, unidades, saldos, demanda, reserva, traslados, sugerencias, fechas, recepciones y advertencias. Excel añade hojas de entradas y supuestos. Un conteo desconocido queda vacío y no se transforma en cero.

## Evidencia de demostración

Las capturas y JSON corresponden al build servido con la API y a la base sintética de DDS-10. Se distinguen el plan inicial y otro escenario que se introdujo mediante la interfaz: consumo previo de dos paquetes en puesto y uno en almacén; recepción hipotética de 50 paquetes al almacén el 1/12/2026; otra de siete al puesto el 15/12/2026; y una fila de nueve ya recibidos que se excluye.

En ese escenario se propuso trasladar 17 paquetes en diciembre. Los siete de recepción tardía se contabilizaron en enero y la fila recibida no se sumó. Son resultados del escenario académico, no operaciones comerciales ejecutadas.

## Verificación del 26/11/2026

```text
npm.cmd run check
npm.cmd run build
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=2 server/tests/*.test.ts
```

TypeScript y build correctos. Suite integrada: **156 aprobadas, 0 fallos, 0 omitidas**; incluye 136 anteriores y 20 nuevas de este bloque (12 del motor y ocho de API/exportación). No es una medida de cobertura de código.

Se verifican ecuaciones y arrastre mensual, reservas, redondeo, protección de demanda del almacén antes de trasladar, saldo unitario compartido, conteos desconocidos, consumo previo y faltantes, recepciones únicas/diferidas/recibidas/canceladas/vencidas, límites físicos, fechas y año bisiesto, permisos, validación estricta y exportaciones coherentes con el JSON. Una modificación real de stock en una base temporal invalida la huella y produce HTTP 409 al intentar exportar el plan anterior.

El recorrido real con Edge 158 comprobó 12 saldos listos en el escenario inicial, los tres supuestos de recepción y el consumo previo descritos arriba, filtro por producto, traslado de 17 paquetes, filas diferidas/excluidas, descarga CSV/Excel desde sus botones y bloqueo de exportación mientras hay cambios sin aplicar. También se modificó el consumo previo a 50 sobre un stock de dos paquetes: se mostraron explícitamente los 48 sin cubrir. Se revisó la vista de 390px y el acceso al último destino del menú móvil. Cero errores de JavaScript; productos, ventas, compras, movimientos y caja permanecieron idénticos. Navegador y servidor se cerraron al terminar.

- [Pantalla inicial](evidencias/DDS-12/reposicion.png).
- [Balance, traslado y compra sugerida](evidencias/DDS-12/balance.png).
- [Fechas y tratamiento de recepciones](evidencias/DDS-12/recepciones.png).
- [Vista móvil](evidencias/DDS-12/movil.png).
- [Faltante previo mostrado con su cantidad](evidencias/DDS-12/consumo-sin-cubrir.png).
- [Plan inicial completo](evidencias/DDS-12/plan-inicial.json).
- [Plan del escenario explícito](evidencias/DDS-12/plan-escenario.json).
- [Verificación de UI/API](evidencias/DDS-12/verificacion-ui.json).
- [Registro de las 156 pruebas](evidencias/DDS-12/pruebas.txt).

## Revisión del equipo

Único revisor previsto para esta ronda: **Fabrizzio Cosme, `Fabrizzio071204`**. Debe revisar balance, unidades, cobertura, plazos, recepciones, exportaciones y pruebas antes de registrar su decisión. La revisión de código y la aceptación funcional del Product Owner son registros separados; ambas siguen pendientes al preparar el incremento.

Incidencia: https://esan-calidadec-ldznsm4o.atlassian.net/browse/DDS-12
