# Propuesta de Seguro de Viaje SENIOR +79 — Automatización

Seguros Atlas · Seguro de Viaje (DINE — Dirección de Negocios Especiales)

Proyecto de Apps Script: **Cotizaciones 2026** (ID `1LpY-U8AGMcjErPLIhX4B50I7NUx7BUu4yFqYIX8VYL3AA15_ETAeHDZF`), con los archivos `Main.gs`, `ASSETS_BASE64.gs` y `QR_GENERADOR.gs`.

Un agente o cliente llena un Google Form. En menos de un minuto recibe, desde el buzón
compartido **segurodeviaje@segurosatlas.com.mx**, una de dos respuestas:

- **Propuesta aprobada:** un correo con el resumen, las primas y un botón **"Solicitar
  emisión"**, que trae adjunto el PDF de la propuesta. El PDF lleva un **QR de emisión**.
  El botón y el QR abren el formulario de solicitud de emisión con el folio, el destino y las
  fechas ya escritos (ver `proceso-emision/`).
- **Solicitud no procesada:** un correo de rechazo que explica el motivo, sin adjuntos.

```
Google Form ─► Google Sheet ─► Apps Script (reglas + HTML) ─► webhook ─► Power Automate
                                                                           │
                                   PDF de la propuesta (OneDrive/Word Online)
                                                                           ▼
                                               Outlook · buzón compartido segurodeviaje@
```

Apps Script tiene **toda** la regla de negocio y arma los documentos. Power Automate solo
convierte el HTML a PDF y envía el correo.

## Contenido del repositorio

| Archivo | Qué es |
|---|---|
| `apps-script/APPS_SCRIPT_SIMPLIFICADO_FINAL.js` | Script principal: se pega completo en `Main.gs` del proyecto de Apps Script **Cotizaciones 2026**. |
| `apps-script/ASSETS_BASE64.gs` | Logos y QR de nueva propuesta del PDF, en base64. Va como segundo archivo `.gs` del mismo proyecto. |
| `apps-script/QR_GENERADOR.gs` | Genera el QR de emisión de cada propuesta (librería qrcode-generator, MIT). Va como tercer archivo `.gs` del mismo proyecto. |
| `apps-script/respaldos/` | Versión anterior, que adjuntaba el formato de emisión en blanco. Ver "Regresar a la versión con formato de emisión". |
| `apps-script/POWER_AUTOMATE_SCHEMA.json` | Esquema JSON del disparador HTTP de Power Automate. |
| `apps-script/test_webhook.py` | Envía al flujo un payload de prueba igual al de producción, sin pasar por el formulario. |
| `herramientas/generar_ejemplos.js` | Regenera `ejemplos/` con el código real (datos ficticios). |
| `ejemplos/` | Propuesta (HTML y PDF), correo aprobado y un correo por cada motivo de rechazo. |
| `proceso-emision/` | Script del formulario "Solicitud de Emisión": manda en automático las solicitudes de TCI, TCC y la emisión completa a Seguro de Viaje. Ver su README. |

## Reglas de negocio

| Regla | Valor | Dónde se cambia (`CONFIG`) |
|---|---|---|
| Edad elegible | De 79 años 11 meses a 89 años 11 meses, a la fecha de salida | `EDAD_MINIMA`, `EDAD_MAXIMA`, `EDAD_MESES_ADICIONALES` |
| Anticipación mínima | 5 días hábiles (lunes a viernes, sin festivos) antes de la salida | `DIAS_ANTICIPACION_MINIMA` |
| Máximo de asegurados | 5 por propuesta (cupo del formato grupal) | `MAX_ASEGURADOS` |
| Vigencia de la propuesta | Envío + 5 días hábiles, o 3 días hábiles antes de la salida, lo que ocurra primero | `VIGENCIA_DIAS_HABILES`, `DIAS_HABILES_LIMITE_EMISION` |
| Solicitud de emisión | Hasta 72 horas hábiles antes de iniciar el viaje | Texto del PDF y del correo |
| Primas | Se leen del Sheet (`PrimaMaster`, `PrimaSmart`, `PrimaElite`, `PrimaPremium`); el script no tiene tarifas propias | Fórmulas del Sheet |

Los pasajeros que no cumplen la edad no frenan la propuesta. Quedan fuera de ella y el correo
lo informa en un aviso.

### Estatus

El script evalúa las reglas en este orden, y la primera que aplica define el estatus:

| Estatus | Cuándo | Resultado |
|---|---|---|
| `RECHAZADO_FECHAS` | La fecha de regreso no es posterior a la de salida | Correo de rechazo |
| `RECHAZADO_TIEMPO` | Menos de 5 días hábiles antes de la salida | Correo de rechazo |
| `RECHAZADO_SIN_ELEGIBLES` | Ningún pasajero en el rango de edad | Correo de rechazo |
| `RECHAZADO_EXCESO_ASEGURADOS` | Más de 5 asegurados elegibles | Correo de rechazo |
| `APROBADO` | Pasa todo lo anterior | Correo con el PDF de la propuesta y el botón "Solicitar emisión" |

Todos los rechazos llevan el asunto **"Solicitud de Propuesta de Seguro no procesada"**. Las
propuestas aprobadas usan esta nomenclatura:
`Propuesta Seguro de Viaje Senior +79 - <salida ddMMyyyy> // <días>D, <DESTINO 3 letras> <envío ddMMyyyy>`.
El PDF se llama igual, pero con ` - ` en lugar de ` // `.

## Puesta en marcha

### 1. Google Form y Google Sheet

- Encabezados obligatorios de la hoja de respuestas (fila 1). Deben escribirse exactamente así;
  el script no distingue mayúsculas ni toma en cuenta espacios sobrantes:
  `Perfil`, `Escribe tu Clave y Nombre de Agente Completo`, `Nombre completo de quien solicita`,
  `Correo electrónico de quien solicita`, `Quieres enviar tu propuesta a algún otro correo?`,
  `Destino`, `Fecha de Salida`, `Fecha de Regreso`, `Folio`, `PrimaMaster`, `PrimaSmart`,
  `PrimaElite`, `PrimaPremium`.
- Por cada asegurado (1 a 5): `Nombre Asegurado N` y `Fecha de Nacimiento Asegurado N`. Si
  los nombres cambian, ajusta `CONFIG.ASEGURADOS`. `listarEncabezados()` muestra los
  encabezados reales.
- Opcional: una columna `Estado de envío`, donde el script anota el resultado de cada fila.
- El formulario debe permitir **máximo 5 asegurados**.

### 2. Apps Script (Extensiones › Apps Script, desde el Sheet)

1. Pega `APPS_SCRIPT_SIMPLIFICADO_FINAL.js` completo en `Main.gs` (proyecto **Cotizaciones 2026**).
2. Crea los archivos `ASSETS_BASE64.gs` y `QR_GENERADOR.gs` y pega en cada uno su contenido.
3. Ejecuta **una vez** `configurarPropiedades()`. Guarda en Script Properties la carpeta de
   Drive donde se respaldan las propuestas (`CARPETA_SALIDA_ID`) y la URL del webhook
   (`WEBHOOK_POWER_AUTOMATE_URL`). Si el flujo se recrea, la URL cambia: actualízala y
   vuelve a ejecutar la función.
4. Activadores › Añadir activador: función `onFormSubmit`, origen *De la hoja de cálculo*,
   evento *Al enviar el formulario*.
5. Zona horaria del proyecto: `America/Mexico_City`.

Pruebas de un solo clic, ejecutables desde el editor. Cada una manda un correo real al flujo,
dirigido a `prueba@example.com`; cambia ese correo en `construirDatosPrueba_` para recibirlas:

| Función | Caso |
|---|---|
| `testearTodo()` | Aprobado: 2 elegibles + 1 excluido |
| `testearRechazoPorTiempo()` | Salida en 2 días |
| `testearRechazoFechas()` | Regreso antes de la salida |
| `testearRechazoSinElegibles()` | Nadie en rango de edad |
| `testearRechazoExcesoAsegurados()` | 6 asegurados elegibles |
| `procesarPegadoMasivo()` | Procesa filas pegadas a mano en la hoja (se salta las que ya tienen `Estado de envío`) |

### 3. Google Drive y formulario de emisión

- El logo y la firma del correo son imágenes públicas de Drive (`URL_LOGO_CORREO`,
  `URL_FIRMA_CORREO`).
- **QR y botón de emisión:** apuntan a `URL_FORMULARIO_EMISION`. Para que el formulario abra
  con los datos de la propuesta ya escritos, llena `PREFILL_EMISION` con los identificadores
  `entry.NNNN` de cuatro preguntas: *Folio de la propuesta*, *Destino*, *Fecha de Salida* y
  *Fecha de Regreso*.
  1. Formulario de emisión en modo edición › **⋮** › **Obtener enlace prellenado**.
  2. Escribe cualquier valor en esas cuatro preguntas › **Obtener enlace** › **Copiar enlace**.
  3. Cada `entry.NNNN=valor` del enlace corresponde a una pregunta.

  Si un identificador queda vacío, esa pregunta no se prellena y el resto sigue funcionando.

### 4. Power Automate

1. **Disparador:** *Cuando se recibe una solicitud HTTP*, con el esquema de
   `POWER_AUTOMATE_SCHEMA.json`.
2. **Condición:** `estatus` es igual a `APROBADO`. Cualquier rechazo, incluso uno nuevo, cae
   en la rama *Falso*.
3. **Rama Verdadero:**
   - OneDrive › *Crear archivo*, con el contenido `base64ToBinary(triggerBody()?['htmlBase64'])`.
   - OneDrive › *Convertir archivo* a PDF.
   - Outlook › *Enviar un correo electrónico desde un buzón compartido (V2)*:
     - Buzón: segurodeviaje@segurosatlas.com.mx.
     - Para: `emailCliente`. CC: `correoCC`. Asunto: `asunto`.
     - Cuerpo: `cuerpoCorreoHtml`, **sin** el `<p class="editor-paragraph">` que agrega el editor.
     - Adjunto: nombre `nombreArchivo`; contenido, la salida de *Convertir archivo*.
4. **Rama Falso:** el mismo envío desde el buzón compartido, con el cuerpo `cuerpoCorreoHtml`
   y sin adjuntos.

Para probar el flujo sin el formulario:

```bash
node herramientas/generar_ejemplos.js            # actualiza /ejemplos
python3 apps-script/test_webhook.py "<URL del flujo>" --email tu@correo.com
python3 apps-script/test_webhook.py "<URL del flujo>" --asegurados 1        # propuesta individual
python3 apps-script/test_webhook.py "<URL del flujo>" --estatus RECHAZADO_TIEMPO
```

## Mantenimiento

- **Textos del PDF:** `generarHtmlCotizacion_` y las funciones que lo siguen. El PDF debe
  quedar en **1 hoja carta**: después de cualquier cambio, revisa `ejemplos/propuesta_aprobada.pdf`.
- **Textos del correo:** `construirCorreoAprobado_`, `construirCorreoRechazo_` y los
  `motivoRechazo*_`. El correo usa tablas y estilos en línea por compatibilidad con Outlook
  de escritorio. No uses `<ul>`, márgenes ni `max-width` sin el bloque `<!--[if mso]>`.
- **Errores:** si una fila falla, el script escribe `ERROR: <mensaje>` en `Estado de envío`.
  El detalle queda en Apps Script › Ejecuciones.

## Regresar a la versión con formato de emisión

Antes de cambiar al formulario de emisión, el correo aprobado adjuntaba también el formato
de emisión en blanco (individual o grupal) desde Google Drive, y el PDF pedía enviar la
documentación por correo. Esa versión quedó guardada en `apps-script/respaldos/` y en la
etiqueta de git `respaldo-formato-emision`. Para volver a ella:

1. Pega `respaldos/APPS_SCRIPT_con_formato_emision_2026-10-13.js` en `Main.gs`. Esa
   versión no usa `QR_GENERADOR.gs`; puedes dejar el archivo, no estorba.
2. En Power Automate:
   - pon de nuevo en el disparador el esquema
     `respaldos/POWER_AUTOMATE_SCHEMA_con_formato_emision_2026-10-13.json`;
   - en la rama Verdadero, agrega otra vez el paso de Google Drive *Obtener contenido de
     archivo mediante ruta* (ruta `formatoEmisionRuta`);
   - agrega el segundo adjunto: nombre `formatoEmisionNombre` y contenido
     `body('Get_file_content_using_path')`.
3. Los formatos tienen que seguir en **Mi unidad/COTIZACIONES**:
   `SOLICITUD EMISION INDIVIDUAL.pdf` y `SOLICITUD DE SEGURO DE VIAJE_GRUPAL v2.pdf`.

## Seguridad

La URL del webhook contiene su firma de acceso (`sig=`). Cualquiera que la tenga puede
disparar el flujo. Esa URL está escrita en `configurarPropiedades()` y, por lo tanto, en este
repositorio. Si el repositorio se comparte fuera del equipo, regenera la URL en Power
Automate, guárdala solo en Script Properties y bórrala del código.
