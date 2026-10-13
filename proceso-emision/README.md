# Solicitud de Emisión — Seguro de Viaje SENIOR +79

> **Estado:** en construcción (parte 1 de la fase de emisión automática). Todavía no está
> activo en el formulario.

## Flujo

1. El cliente recibe la **propuesta** (proyecto Cotizaciones 2026, ver el README de la raíz).
2. Acepta la propuesta y escanea el **QR**, que lo lleva al formulario **"Solicitud de
   Emisión de Póliza de Seguro de Viaje"**.
3. Cuando envía el formulario, `Code.gs` arma **tres correos** y los manda a Power Automate.
   Power Automate los envía desde el buzón compartido **segurodeviaje@segurosatlas.com.mx**.

| Correo | Para | Contenido | Adjuntos |
|---|---|---|---|
| `SOLICITUD DE TCI \|\| NUEVA POLIZA \|\| <sucursal>` | mesacontroldanos@segurosatlas.com.mx | Solo los 14 datos del contratante | CSF |
| `SOLICITUD DE TCC \|\| NUEVA POLIZA \|\| <sucursal>` | cotizacionesdanos@segurosatlas.com.mx | Solo los 14 datos del contratante | — |
| `SOLICITUD DE EMISIÓN \|\| SENIOR +79 \|\| <contratante> \|\| <folio>` | segurodeviaje@segurosatlas.com.mx | Todo el formulario, por secciones | Todo lo que subió el cliente + **SLIP en PDF** |

Los tres llevan siempre en copia a equintanar@ (Eloisa Quintanar) y mhidalgo@ (Miguel Cárdenas), en `COPIA_SIEMPRE`.

### Datos del TCI / TCC

| Renglón | Origen |
|---|---|
| Nombre del Asegurado / Razón Social | *Nombre Completo del Contratante*, en mayúsculas |
| Tipo de movimiento | Fijo: **Nueva** |
| Producto o Ramo | Fijo: **131** |
| Nombre y clave del agente | *Nombre de Agente* + *Clave de Agente*, como `NOMBRE \|\| CLAVE` |
| Moneda | Fijo: **USD** |
| Giro | Fijo: **Seguro de Viaje (Sector: 24, Subsector: 145, Giro: 1)** |
| Clave de Sucursal | *Clave de Sucursal* (también va en el asunto). Se pasa a mayúsculas; si escriben "g00 - Guadalajara" se toma `G00` |
| RFC | *RFC* |
| CURP / Ocupación | Del formulario; **N/A** si es persona moral |
| Domicilio | *Domicilio del Contratante*, en mayúsculas |
| Tel | *Teléfono*; N/A si viene vacío |
| Correo electrónico | *Correo Electronico*, el que capture el cliente |
| Ejecutivo | *Clave de tu Ejecutivo* + *Nombre de tu Ejecutivo*, resaltado en amarillo |

**Persona física o moral:** se decide por el RFC, sin preguntar en el formulario. Un RFC de
12 caracteres es de persona moral y uno de 13 es de persona física.

## SLIP

El SLIP es el documento que Seguro de Viaje sube al sistema interno. En cada solicitud se llena
solo su recuadro **ASEGURADOS** y se adjunta en **PDF** al correo de Seguro de Viaje como
`SLIP_<folio>.pdf`. El resto del documento no cambia.

- **Plantillas:** hay una por plan en `plantillas-slip/`
  (`PLANTILLA_SLIP_MASTER`, `_MASTER_SMART`, `_MASTER_ELITE`, `_MASTER_PREMIUM`, en `.rtf`).
  Salen de los SLIP originales, sin los datos de asegurados anteriores. La de **Elite** usa el
  recuadro de 6 columnas, porque el original traía uno viejo de 3. En la de Master se corrigió
  el encabezado "NACIMI/ENTO".
  `herramientas/preparar_plantillas_slip.py` las vuelve a generar si cambian los originales.
- **Plan:** se elige con la respuesta de *Producto Elegido* (`CONFIG_EMISION.SLIP`).
- **Columnas:** nombre completo, fecha de nacimiento (dd/mm/aaaa), sexo (M/F), contacto de
  emergencia, su teléfono y beneficiario.
  - Una fila por asegurado (1 a 5).
  - Arial 7, igual que el original.
  - Nombres en mayúsculas; los vacíos salen como `-`.
- **Conversión a PDF:** el script llena el RTF y Power Automate lo convierte a PDF con Word
  (OneDrive), el mismo motor que la propuesta, así que el formato queda idéntico.
- **Si algo falla** (plantilla no encontrada o plan sin plantilla), el correo lo avisa en rojo
  y el adjunto lleva el motivo. La solicitud se envía igual.

## Cambios necesarios en el formulario

- [ ] En cada sección de asegurado, agregar **Sexo** (opción múltiple *Masculino* /
      *Femenino*, obligatoria) con los títulos `Sexo`, `Sexo 2`, `Sexo 3`, `Sexo 4` y `Sexo 5`.
      La va a necesitar el SLIP.

- [ ] Agregar **Folio de la propuesta** como primera pregunta de "Información para emisión":
  - respuesta corta y obligatoria;
  - descripción sugerida: "Se llena solo si entraste desde el QR o el botón de tu
    propuesta.";
  - llega prellenada desde el QR o el botón de la propuesta, y con ella el correo a Seguro
    de Viaje trae el folio sin tener que leerlo del PDF;
  - después saca el enlace prellenado (ver el README de la raíz, "Google Drive y formulario
    de emisión") para llenar `PREFILL_EMISION` en el script de la propuesta.
- [ ] Agregar **Clave de Sucursal** (sección "Información para emisión"):
  - respuesta corta y obligatoria;
  - validación: *Expresión regular* → *Coincide con* → `^[A-Za-z][A-Za-z0-9]{2}$`, con el
    mensaje "Escribe la clave de 3 caracteres de tu sucursal, por ejemplo G00, E82 o M20";
  - no conviene una lista desplegable: las sucursales no son fijas y una que falte
    bloquearía la solicitud.
  - Claves vistas en las emisiones de 2026: C00, C01, C16, D00, D70, DF4, E59, E82, F02,
    F04, F10, F19, F20, G00, G05, G11, G15, G22, H00, H02, L00, L01, L06, L07, M00, M05,
    M14, M20, M25, MC1, MC7, MCA, MCC, ML0, MS1, MS5, MSJ, P00, P01, P06, P07, P09, P12,
    Q00, Q02, T00, T02, T03, Y00, Y01, Y02, Y10, Y15, Y17.
- [ ] Agregar **Clave de tu Ejecutivo** como pregunta obligatoria, y hacer obligatoria
      **Nombre de tu Ejecutivo**.
- [ ] Recomendado: separar la pregunta de archivos en dos, ambas obligatorias:
      **Adjunta tu CSF (Constancia de Situación Fiscal)** y **Adjunta tu INE o pasaporte**.
      Así solo la CSF viaja al TCI. Si se quedan en una sola pregunta, al TCI va todo lo que
      se suba en ella.
- [ ] Renombrar "Adjunta la cotización recibida" a **"Adjunta la propuesta recibida"**. El
      script acepta los dos títulos.

Después de editar el formulario, ejecuta **`revisarFormulario()`** en su Apps Script: no envía nada, marca con ✅/❌ cada dato que necesitan el TCI y el TCC y lista todas las preguntas.

Los títulos de las preguntas se comparan sin distinguir mayúsculas, acentos ni espacios. Si
se renombra una pregunta, agrega el nuevo título en `CONFIG_EMISION.PREGUNTAS` o
`CONFIG_EMISION.SECCIONES`. Si una pregunta no aparece en `SECCIONES`, sale igual en el
correo de Seguro de Viaje dentro de "Otros".

## Puesta en marcha

### Apps Script (Extensiones › Apps Script, desde el **formulario**, no desde la hoja)

1. Pega `Code.gs` completo.
2. Proyecto › Configuración: activa *Mostrar el archivo de manifiesto* y pega
   `appsscript.json`. Esto agrega Drive API v2, que se usa para leer el folio del PDF.
3. En `configurarPropiedades()`, pega la URL del flujo de Power Automate y ejecútala una vez.
4. Activadores › Añadir:
   - función `onFormSubmitSolicitudEmision`
   - origen *Desde el formulario*
   - evento *Al enviarse el formulario*
5. Prueba con `probarCorreosEmision()`:
   - manda los tres correos con datos ficticios y `[PRUEBA]` en el asunto;
   - solo llegan a `CORREOS_PRUEBAS` (mhidalgo@), nunca a Mesa Control ni a Cotizaciones.
6. **Modo pruebas** (`MODO_PRUEBAS: true`, como viene): los envíos reales del formulario
   también llegan solo a `CORREOS_PRUEBAS`, los tres (TCI, TCC y solicitud general), con
   `[PRUEBA]` en el asunto y una franja amarilla que dice a quién irían en producción y con
   qué adjuntos. Para que Eloisa también los reciba, descomenta su correo en
   `CORREOS_PRUEBAS`.
7. **Paso a producción:** cambia `MODO_PRUEBAS` a `false` y guarda.

### Power Automate (flujo nuevo, separado del de la propuesta)

1. **Disparador:** *Cuando se recibe una solicitud HTTP*, con el esquema
   `POWER_AUTOMATE_SCHEMA.json`.
2. **Aplicar a cada uno** sobre `correos`.
3. Dentro del ciclo, **Seleccionar** (*Select*):
   - De: `adjuntos` del elemento actual (elígelo en el contenido dinámico del ciclo)
   - Asignar `Name` = `item()?['nombre']`
   - Asignar `ContentBytes` = `item()?['contenidoBase64']`
4. Dentro del ciclo, **Enviar un correo electrónico desde un buzón compartido (V2)**:
   - Buzón: segurodeviaje@segurosatlas.com.mx
   - Para: `para`; CC: `cc`; Asunto: `asunto`; Cuerpo: `cuerpoHtml`
   - Datos adjuntos: cambia a *matriz completa* y usa la salida de **Seleccionar**.

Un correo sin adjuntos manda una matriz vacía y Outlook lo envía igual.

#### SLIP en el flujo

1. Sube las 4 plantillas de `plantillas-slip/` a Google Drive, en cualquier carpeta de la
   cuenta dueña del script del formulario. **No les cambies el nombre.**
2. En el flujo, pega el esquema nuevo de `POWER_AUTOMATE_SCHEMA.json`, que agrega `slip`.
3. Entre el disparador y **Apply to each**, agrega dos pasos de OneDrive for Business:
   - **Create file:**
     - Carpeta: `/Cotizaciones Plantilla`.
     - Nombre (fx): `triggerBody()?['slip']?['nombreRtf']`.
     - Contenido (fx): `base64ToBinary(triggerBody()?['slip']?['contenidoBase64'])`.
   - **Convert file:**
     - Archivo (fx): `outputs('Create_file')?['body/Id']`.
     - Tipo de destino: **PDF**.
4. En el correo, en **Attachments** (modo matriz completa), cambia `body('Select')` por:

   ```
   if(equals(item()?['tipo'],'SEGURO_VIAJE'), union(body('Select'), createArray(addProperty(addProperty(json('{}'),'Name',triggerBody()?['slip']?['nombrePdf']),'ContentBytes',body('Convert_file')?['$content']))), body('Select'))
   ```

   Así el SLIP solo va en el correo de Seguro de Viaje. TCI y TCC quedan igual.

## Pendientes

- [ ] Acuse al cliente de que su solicitud de emisión se recibió, si se requiere.
