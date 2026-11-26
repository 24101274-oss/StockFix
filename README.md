# StockFix Académico

Copia académica de una implementación previa de StockFix Web del usuario. Se reutiliza la base existente; no se afirma que el equipo haya creado desde cero todos sus módulos para este parcial. Los cambios de esta entrega preparan un caso ficticio, separan la base de datos y verifican dos requerimientos funcionales del curso Calidad de Software.

**RF-01:** registrar/editar productos y contar sus existencias por presentación y ubicación. **RF-02:** registrar una venta con precios del servidor, cálculo de total/vuelto, descuento de stock y documento interno identificado como PRUEBA.

Todos los productos, cantidades y precios de este catálogo son ficticios. No se copió la base de datos del negocio original ni su archivo `.env`. El sistema no emite comprobantes electrónicos válidos. Las consultas externas de DNI/RUC están deshabilitadas en el arranque académico y no requieren claves, SUNAT ni servicios de pago.

## Ejecución local

Requiere Node.js 22.12 o posterior y npm. Desde esta carpeta:

```powershell
npm ci
npm run dev
```

Si las dependencias ya están incluidas en la computadora de preparación, omitir `npm ci`. Abrir http://127.0.0.1:5174. La API escucha en http://127.0.0.1:3341. La base PGlite se crea en `data/demo-db` y conserva las operaciones al reiniciar.

| Perfil local | Correo | Clave pública de demostración |
| --- | --- | --- |
| Administrador | admin@stockfix.local | AdminDemo2026! |
| Cajero | cajero@stockfix.local | CajeroDemo2026! |

Para repetir la demostración desde un estado limpio, detener los servidores y cambiar `DATA_DIR` por una carpeta nueva dentro de esta copia. Una base nueva carga únicamente el catálogo ficticio de `server/seed/catalog.json`. No eliminar ni apuntar a bases de otros proyectos.

## Demostración de los dos requerimientos

1. Ingresar como administrador. En Inventario, crear un producto con una presentación Paquete de 100 y precio S/ 2,50. Un código de barras ya registrado debe rechazarse; el SKU se genera automáticamente.
2. Contar 10 paquetes y 0 unidades sueltas en el puesto. El total será 1.000 unidades. Los conteos reemplazan el stock de la ubicación; no representan una compra.
3. Abrir caja con S/ 100,00 si todavía no existe una caja abierta.
4. En Nueva venta, seleccionar el producto, 2 paquetes y efectivo recibido S/ 10,00. Confirmar. El total debe ser S/ 5,00, el vuelto S/ 5,00 y el stock restante 8 paquetes/800 unidades.
5. Revisar el historial y el documento interno PR-… con la marca PRUEBA. Intentar vender más paquetes que los disponibles debe bloquearse sin alterar stock, venta ni caja.

Los productos Bolsas académicas, Vasos académicos y Platos académicos ya tienen existencias ficticias para explorar la interfaz. La verificación automática también agrega un producto CP-01, deja 8 paquetes y una venta; esas operaciones son pruebas documentadas.

## Verificación reproducible

```powershell
npm run check
npm run build
npm test
node scripts/verify-academic.mjs
```

El último comando levanta API/Vite con ventanas ocultas, ejecuta CP-01 a CP-08 por HTTP, reinicia la API para verificar persistencia y deja los servidores activos para la revisión visual. Requiere que 3341 y 5174 estén libres. Guarda resultados y registros en `../evidencias`; `servidores.json` contiene los PID creados. Para detenerlos, comprobar esos PID y usar `Stop-Process -Id <PID>`.

Las pruebas heredadas están en `server/tests`. Algunas usan una base en memoria y otras crean carpetas temporales bajo `tmp` de esta copia; no acceden a la base original. Las consultas externas se prueban con respuestas simuladas explícitas. El registro de evidencia distingue la suite heredada de los ocho casos nuevos de la copia académica.

## Histórico sintético para la predicción mensual (HU09 / DDS-10)

Esta preparación genera un histórico ficticio con semilla fija: 36 meses completos anteriores al mes de corte y operaciones del mes parcial hasta la fecha indicada. Incluye productos de demostración, estacionalidad, tendencia, demanda intermitente, meses sin ventas y productos nuevos con cobertura identificada. Los importes y las cantidades son datos sintéticos, no resultados de un negocio.

Desde la carpeta del proyecto, con la aplicación detenida para el destino de carga:

```powershell
npm.cmd run demo:seed -- --as-of 2026-11-26 --seed stockfix-2026 --months 36
$env:DATA_DIR = (Resolve-Path './data/forecast-demo').Path
npm.cmd run build
npm.cmd start
```

Abrir http://127.0.0.1:3341 e ingresar con un acceso académico del apartado anterior. La aplicación muestra **DATOS SINTÉTICOS DE DEMOSTRACIÓN** y permite descargar el manifiesto. Los archivos CSV/XLSX descargados desde esa base llevan el mismo aviso en su nombre y una cabecera HTTP que identifica su origen, conservando sus columnas.

El destino predeterminado es `data/forecast-demo`, separado de `data/demo-db`. El importador rechaza el destino habitual y las bases no identificadas como propias de esta demostración. Repetir la misma configuración conserva los registros y evita duplicarlos. Para otro escenario, elegir una carpeta nueva mediante `--data-dir`; no cambiar la semilla ni la fecha sobre una base que ya contiene un histórico distinto.

El manifiesto conserva origen, versión, semilla, fecha de corte en America/Lima, cobertura por producto, conteos y hash del conjunto generado. Una observación cero después de la introducción del producto se diferencia del periodo anterior en que no se observaba. El mes parcial está identificado para que el modelo posterior no lo interprete como un mes completo.

Este bloque prepara los datos y su trazabilidad. Ver `docs/DDS-10_HISTORICO_SINTETICO.md` para los criterios y la verificación.

## Predicción mensual (HU10 / DDS-11)

Como administrador, abrir **Predicción mensual**, seleccionar fecha de corte, horizonte, ubicación y producto, y pulsar **Calcular pronóstico**. La gráfica separa meses completos, mes parcial y estimación futura; la tabla muestra piezas y su equivalente redondeado en presentaciones actuales. Los filtros aplicados se conservan al exportar CSV o Excel.

Se utilizan métodos estadísticos explicables: último mes, promedio de tres meses, tendencia lineal y, con historia suficiente, mismo mes del año anterior. Desde seis meses completos se comparan mediante tres cortes temporales de un paso, sin usar datos futuros. Se informa MAE y sesgo en piezas; entre tres y cinco meses se utiliza promedio sin afirmar evaluación suficiente. Con menos de tres meses se informa historial insuficiente.

El módulo consulta ventas registradas y excluye anulaciones. No cambia stock, caja ni compras. Los ceros se incluyen únicamente dentro de la cobertura observada; las ventas pueden subestimar demanda cuando faltó stock. El error sobre datos sintéticos demuestra el recorrido académico y no garantiza resultados comerciales. El cálculo local no necesita claves ni servicios de IA externos.

Ver [manual, metodología y evidencia](docs/DDS-11_PRONOSTICO_MENSUAL.md).

## Reposición mensual (HU11 / DDS-12)

Abrir **Reposición mensual** como administrador. Elegir horizonte, reserva porcentual, plazo y producto; calcular y revisar cada presentación. El módulo protege la demanda/reserva del almacén y propone trasladar su excedente al puesto antes de sugerir compras. Las presentaciones unitarias comparten una sola cuenta de piezas sueltas; los empaques cerrados conservan su propio saldo. Un conteo desconocido bloquea la sugerencia correspondiente.

En **Ajustar escenario** se declaran cantidades pendientes por recibir, sus fechas y destinos, y consumo previo al primer mes. Las compras ya recibidas están incluidas en stock y no se suman otra vez. El escenario no guarda pedidos ni registra movimientos. Supone que la demanda mensual debe estar disponible el día 1; una recepción posterior se difiere al mes siguiente. Los saldos futuros dependen de ejecutar las recomendaciones a tiempo.

Los CSV/Excel usan el cálculo aplicado. Si cambia el stock o el resultado antes de descargar, se exige recalcular. Los supuestos duran solo mientras permanezcas en la página. Ver [reglas, manual y evidencias](docs/DDS-12_REPOSICION_MENSUAL.md).

## Procedencia y límites

Ver `PROCEDENCIA.md` y `../evidencias/procedencia.json`. El proyecto original no incluía un archivo LICENSE ni un campo license para el código propio; no se ha inventado una licencia. Las dependencias conservan sus licencias dentro de `node_modules` y se identifican en `package-lock.json`.

Esta entrega cubre un caso local académico de inventario y ventas. La integración tributaria, impresión directa en hardware, alojamiento productivo y costos reales pertenecen a trabajo posterior. No se presenta la planificación del equipo como ceremonias o actividades ya realizadas.
