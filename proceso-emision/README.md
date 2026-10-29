# Solicitud de Emisión — Seguro de Viaje SENIOR +79

> **Estado (octubre 2026): en pruebas.** El formulario, el script y el flujo están armados y
> probados de punta a punta. `MODO_PRUEBAS` sigue activo: todo llega solo a mhidalgo@ hasta
> que se libere (ver "Paso a producción").

## Flujo

1. El cliente recibe la **propuesta** (proyecto Cotizaciones 2026, ver el README de la raíz).
2. Acepta la propuesta y escanea el **QR**, que lo lleva al formulario **"Solicitud de
   Emisión de Póliza de Seguro de Viaje"**.
3. Cuando envía el formulario, `Code.gs` arma **tres correos** y los manda a Power Automate.
   Power Automate los envía desde el buzón compartido **segurodeviaje@segurosatlas.com.mx**.

| Correo | Para | Contenido | Adjuntos |
|---|---|---|---|
| `SOLICITUD DE TCI \|\| NUEVA POLIZA \|\| <sucursal>` | mesacontroldanos@segurosatlas.com.mx | Solo los 14 datos del contratante | CSF + INE o pasaporte |
| `SOLICITUD DE TCC \|\| NUEVA POLIZA \|\| <sucursal>` | cotizacionesdanos@segurosatlas.com.mx | Solo los 14 datos del contratante | CSF + INE o pasaporte |
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

## El formulario

Formulario **"Solicitud de Emisión de Póliza de Seguro de Viaje"**: 8 secciones, máximo 5
asegurados. Por las cargas de archivos, Google pide iniciar sesión para responderlo.

| Sección | Preguntas que usa el script |
|---|---|
| 1. Información para emisión | Folio de la propuesta (llega prellenado), Nombre de Agente, Clave de Agente, Nombre de tu Ejecutivo, Clave de tu Ejecutivo, Clave de Sucursal, Producto Elegido, Costo en USD, Adjunta la propuesta recibida, Adjunta tu CSF (Constancia de Situación Fiscal), Adjunta tu INE o pasaporte |
| 2. Información del Viaje | Destino, Fecha de Salida, Fecha de Regreso (las tres llegan prellenadas) |
| 3. Contratante | Nombre Completo del Contratante, Domicilio del Contratante (…), RFC, CURP (PERSONA FISICA), Correo Electronico, Teléfono, Ocupación |
| 4. Asegurado 1 | Nombre Completo, Fecha de Nacimiento, Sexo, Contacto de Emergencia, Teléfono Contacto de Emergencia, Nombre Beneficiario, Domicilio del Asegurado (…), ¿Deseas agregar un segundo asegurado? |
| 5 a 8. Asegurado 2 a 5 | Los mismos con el número al final (`Nombre Completo 2`, `Sexo 2`…). La pregunta "¿Deseas agregar…?" lleva *Ir a la sección según la respuesta*: **No → Enviar el formulario** |

- **Clave de Sucursal:** respuesta corta con validación `^[A-Za-z][A-Za-z0-9]{2}$`.
  Claves vistas en las emisiones de 2026: C00, C01, C16, D00, D70, DF4, E59, E82, F02, F04,
  F10, F19, F20, G00, G05, G11, G15, G22, H00, H02, L00, L01, L06, L07, M00, M05, M14, M20,
  M25, MC1, MC7, MCA, MCC, ML0, MS1, MS5, MSJ, P00, P01, P06, P07, P09, P12, Q00, Q02, T00,
  T02, T03, Y00, Y01, Y02, Y10, Y15, Y17.
- **Sexo:** opción múltiple *Masculino / Femenino*. La usa el SLIP; si falta, la columna
  sale con `-`. **Pendiente de confirmar** que esté en las 5 secciones de asegurados.
- **Comparación de títulos:** sin distinguir mayúsculas, acentos ni espacios.
  - Si se renombra una pregunta, agrega el título nuevo en `CONFIG_EMISION.PREGUNTAS` o
    `SECCIONES`.
  - Lo que no esté en `SECCIONES` sale igual en el correo de Seguro de Viaje, en "Otros".
- **`revisarFormulario()`:** no envía nada. Marca ✅/❌ cada dato que necesitan el TCI y el
  TCC y lista todas las preguntas.
- **`obtenerIdsPrellenado()`:** imprime los `entry.NNNN` de folio, destino y fechas para
  `PREFILL_EMISION` del script de la propuesta. Hay que correrla otra vez si se recrea alguna
  de esas preguntas.

## Puesta en marcha

### Apps Script

Se abre desde el **formulario** (modo edición › ⋮ › Apps Script). La hoja de respuestas
tiene un proyecto viejo ("Proyecto sin título") con la versión anterior: **no se usa** y no
debe tener activadores.

1. Pega `Code.gs` completo.
2. ⚙️ Configuración › *Mostrar el archivo de manifiesto* › pega `appsscript.json`. Agrega
   Drive API v2, que solo se usa si el folio no llega prellenado y hay que leerlo del PDF.
3. En `configurarPropiedades()` pega la URL del flujo (debe terminar en `&sig=…`) y ejecútala
   una vez.
4. Activadores › Añadir:
   - función `onFormSubmitSolicitudEmision`;
   - origen *Desde el formulario*;
   - evento *Al enviarse el formulario*.
5. Sube las 4 plantillas de `plantillas-slip/` a Google Drive de la misma cuenta, **sin
   cambiarles el nombre ni convertirlas** a Documentos de Google.

### Power Automate: flujo "Solicitud de Emisión SV"

```
manual (HTTP) → Create file → Convert file → Apply to each (correos)
                                               ├─ Select (adjuntos)
                                               └─ Send an email from a shared mailbox (V2)
```

1. **manual** (*When an HTTP request is received*):
   - *Who can trigger the flow*: **Anyone**;
   - esquema: `POWER_AUTOMATE_SCHEMA.json`.
2. **Create file** (OneDrive for Business), para el SLIP:
   - carpeta `/Cotizaciones Plantilla`;
   - nombre `triggerBody()?['slip']?['nombreRtf']`;
   - contenido `base64ToBinary(triggerBody()?['slip']?['contenidoBase64'])`.
3. **Convert file**:
   - archivo `outputs('Create_file')?['body/Id']`;
   - destino **PDF**.
4. **Apply to each** sobre `correos`. Dentro:
   - **Select**:
     - De: `items('Apply_to_each')?['adjuntos']`;
     - `Name` = `item()?['nombre']`;
     - `ContentBytes` = `base64ToBinary(item()?['contenidoBase64'])`.
   - **Send an email from a shared mailbox (V2)**:
     - buzón `segurodeviaje@segurosatlas.com.mx`;
     - Para `item()?['para']`, CC `item()?['cc']`, Asunto `item()?['asunto']`;
     - Cuerpo `item()?['cuerpoHtml']`, sin el `<p class="editor-paragraph">`;
     - **Attachments** (modo matriz completa):

       ```
       if(equals(item()?['tipo'],'SEGURO_VIAJE'), union(body('Select'), createArray(addProperty(addProperty(json('{}'),'Name',triggerBody()?['slip']?['nombrePdf']),'ContentBytes',body('Convert_file')))), body('Select'))
       ```

**Regla de los adjuntos:** `ContentBytes` siempre tiene que ir como **archivo**, con
`base64ToBinary(...)` o `body('Convert_file')`, nunca como texto. Si va como texto, Outlook lo
vuelve a codificar y el adjunto llega dañado ("Acrobat no pudo abrir…").

## Pruebas

Con `MODO_PRUEBAS: true`, los tres correos de **cualquier** envío del formulario llegan solo
a `CORREOS_PRUEBAS` (mhidalgo@):
- sin copia a nadie;
- con `[PRUEBA]` en el asunto;
- con una franja amarilla que dice a quién irían en producción y con qué adjuntos, SLIP
  incluido.

Nunca llegan a Mesa Control Daños ni a Cotizaciones Daños.

**Prueba del proceso completo:**
1. Pide una propuesta en el formulario de propuestas **con tu correo**. Ese formulario no
   tiene modo pruebas: la propuesta va al correo capturado, con copia oculta a segurodeviaje@.
2. Escanea el QR del PDF o da clic en "Solicitar emisión". El formulario debe abrir con folio,
   destino y fechas ya llenos.
3. Llénalo con archivos de prueba (propuesta, CSF, INE).
4. Revisa los 3 correos:

   | Correo | Adjuntos |
   |---|---|
   | TCI | CSF + INE |
   | TCC | CSF + INE |
   | Solicitud de emisión | Propuesta + CSF + INE + SLIP del plan elegido |

   Todos los adjuntos deben abrir sin error.

Casos para cubrir: 1 y 5 asegurados, persona física y moral, y cada uno de los 4 planes
(cada uno tiene su SLIP).

`probarCorreosEmision()` manda los tres correos con datos ficticios **sin archivos** y el SLIP
de Master Elite. Sirve para revisar el formato rápido, no los adjuntos.

## Paso a producción

- [ ] Pruebas completas aprobadas: los 4 planes y persona física y moral.
- [ ] `Sexo` en las 5 secciones de asegurados.
- [ ] Sin activadores en el proyecto viejo de la hoja de respuestas.
- [ ] Cambiar `MODO_PRUEBAS: true` a `false` en `Code.gs` y guardar.
- [ ] Primer caso real: confirmar con Mesa Control y Cotizaciones Daños que el TCI y el TCC
      llegaron completos.

## Pendientes

- [ ] Acuse al cliente de que su solicitud de emisión se recibió, si se requiere.
