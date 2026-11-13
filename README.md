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

## Procedencia y límites

Ver `PROCEDENCIA.md` y `../evidencias/procedencia.json`. El proyecto original no incluía un archivo LICENSE ni un campo license para el código propio; no se ha inventado una licencia. Las dependencias conservan sus licencias dentro de `node_modules` y se identifican en `package-lock.json`.

Esta entrega cubre un caso local académico de inventario y ventas. La integración tributaria, impresión directa en hardware, alojamiento productivo y costos reales pertenecen a trabajo posterior. No se presenta la planificación del equipo como ceremonias o actividades ya realizadas.
