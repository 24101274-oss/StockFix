# Control de cambios de StockFix Académico

- main: línea base de la copia académica. La base funcional es preexistente.
- develop: rama de integración.
- feature/*: cambios de alcance acotado. El autor vincula la historia y adjunta pruebas.
- hotfix/*: corrección urgente desde main. Se revisa en PR y se replica en develop.

Para cada cambio, un revisor distinto del autor verifica criterios, pruebas y evidencia antes de aprobar el PR. Al cierre, el Product Owner valida la entrega y se etiqueta el commit aprobado.

v0.1.0-academico identifica la línea base local. El repositorio remoto, la protección de main, el PR y la revisión por pares se registrarán al realizarse.
