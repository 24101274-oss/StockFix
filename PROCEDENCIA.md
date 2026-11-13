# Procedencia de la copia académica

La base funcional corresponde a StockFix Web, versión 0.1.0, un proyecto previo del usuario de ventas e inventario. Su código React/TypeScript/Fastify/Drizzle/PGlite ya contenía catálogo, stock, ventas, caja, permisos y pruebas. La reutilización fue autorizada para el parcial del curso; no se atribuye su creación completa al equipo de esta entrega.

La copia incluye `src`, `shared`, `server`, configuración, manifiesto y lock de dependencias. Excluye el `.env` original, `data`, `tmp`, documentos comerciales y referencias, `.git` y `dist`. Las dependencias se copiaron físicamente; no hay enlaces a la base del negocio.

Cambios de esta entrega:

- Catálogo nuevo de tres productos ficticios, con cantidades y precios ilustrativos.
- Eliminación del RUC del negocio en configuración e interfaz; identificadores de los tests sustituidos por valores ficticios de formato válido.
- Marca de versión académica y conservación de la etiqueta PRUEBA en documentos.
- API 3341 y Vite 5174 en 127.0.0.1, base separada `data/demo-db` y orígenes locales explícitos.
- Consultas externas deshabilitadas en el arranque, sin copiar tokens.
- Guía de ejecución, demostración y verificador de ocho casos HTTP con persistencia tras reinicio.

La comparación de hashes SHA-256 y el listado de modificaciones están en `../evidencias/procedencia.json`. El archivo también verifica que el original se mantuvo intacto respecto de la lectura inicial. No se crearon commits ni ramas para presentar el código previo como trabajo nuevo.

No se encontró licencia propia en la raíz del proyecto previo. Las bibliotecas externas conservan su información de licencia y copyright en sus paquetes. Esto no autoriza ni demuestra una publicación comercial o una licencia nueva sobre el conjunto.
