# Solicitud de Emisión — Seguro de Viaje SENIOR +79

> **Estado (noviembre 2026): piloto.** El formulario, el script y el flujo están armados y
> probados de punta a punta. `ETAPA: 'PILOTO'`: los tres correos de cada solicitud real llegan
> a segurodeviaje@ con copia a Eloisa y Miguel; todavía nada llega a Mesa Control ni a
> Cotizaciones Daños (ver "Etapas").

## Flujo

1. El cliente recibe la **propuesta** (proyecto Cotizaciones 2026, ver el README de la raíz).
2. Acepta la propuesta y escanea el **QR**, que lo lleva al formulario **"Solicitud de
   Emisión de Póliza de Seguro de Viaje"**.
3. Cuando envía el formulario, `Code.gs` revisa la **vigencia** de la propuesta (ver
   "Vigencia"). Si está vigente, arma **tres correos** y los manda a Power Automate.
   Power Automate los envía desde el buzón compartido **segurodeviaje@segurosatlas.com.mx**.

| Correo | Para | Contenido | Adjuntos |
|---|---|---|---|
| `SOLICITUD DE TCI \|\| NUEVA POLIZA \|\| <sucursal>` | mesacontroldanos@segurosatlas.com.mx | Solo los 14 datos del contratante | CSF + INE o pasaporte |
| `SOLICITUD DE TCC \|\| NUEVA POLIZA \|\| <sucursal>` | cotizacionesdanos@segurosatlas.com.mx | Solo los 14 datos del contratante | CSF + INE o pasaporte |
| `SOLICITUD DE EMISIÓN \|\| SENIOR +79 \|\| <contratante> \|\| <folio>` | segurodeviaje@segurosatlas.com.mx | Todo el formulario, por secciones | Todo lo que subió el cliente + **SLIP en PDF** |

Los tres llevan siempre en copia a equintanar@ (Eloisa Quintanar) y mhidalgo@ (Miguel Cárdenas), en `COPIA_SIEMPRE`.

Además sale una **confirmación al cliente**, *Confirmación de Solicitud \|\| Seguro de Viaje
SENIOR +79 \|\| <folio>*, al correo capturado en el formulario y sin copias. Es el mismo formato
del correo a Seguro de Viaje (todo el formulario por secciones y los archivos que subió), **sin
el SLIP** ni los avisos internos, con este texto al inicio: *"Hemos recibido tu solicitud de
emisión con base en la siguiente información y los documentos adjuntos. Nuestro equipo ya se
encuentra trabajando en ella, y en un lapso máximo de 72 hrs estarás recibiendo tu póliza."*
Lleva la firma para clientes (Ext. 5114). Si no capturó correo, no sale y el expediente lo avisa.

### Vigencia

La solicitud de emisión se **rechaza sola** si llega después del envío de la propuesta
**+ 72 horas hábiles** (3 días hábiles).

Es la misma fecha que aparece en el PDF como "VIGENCIA HASTA EL …". Días hábiles = lunes a
viernes, sin descontar festivos.

- La fecha de envío (*Marca temporal*) se lee de la **hoja de respuestas de propuestas**,
  buscando el folio. No dependen de lo que se capture en el formulario de emisión.
- **Fuera de vigencia:** no sale TCI, TCC ni expediente. Sale un solo correo, *Solicitud de
  emisión no procesada \|\| Propuesta fuera de vigencia \|\| <folio>*, al correo capturado
  en el formulario, con copia a segurodeviaje@, Eloisa y Miguel. Explica hasta cuándo valía la
  propuesta, trae el botón **Solicitar nueva propuesta** y lleva la firma para clientes
  (Ext. 5114).
- **No se pudo validar** (sin `ID_HOJA_PROPUESTAS`, sin folio, o el folio no está en la hoja):
  **no se rechaza**. Salen los tres correos y el expediente lleva un aviso naranja para revisar
  la vigencia a mano.
- Los días se configuran en `CONFIG_EMISION.VIGENCIA.DIAS_HABILES_DESDE_ENVIO` y en
  `VIGENCIA_DIAS_HABILES` del proyecto Cotizaciones 2026. Si se cambia uno, cambiar el otro.

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
6. **Vigencia:** pega en `CONFIG_EMISION.VIGENCIA.ID_HOJA_PROPUESTAS` el ID de la hoja de
   respuestas de propuestas (lo que va entre `/d/` y `/edit` en su URL). Guarda y ejecuta
   `probarVigencia()` una vez: pide permiso para leer Hojas de cálculo (sin ese permiso el
   activador falla) y muestra el folio más reciente con su vigencia. La hoja de propuestas debe
   tener la columna **"Folio de propuesta"** o **"Estado de envío"**, que es donde Cotizaciones
   2026 deja el folio completo.

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
   - **Select**. Ahí se suma el SLIP al correo de Seguro de Viaje, para que todos los adjuntos
     sigan el mismo camino:
     - **De:**

       ```
       if(equals(items('Apply_to_each')?['tipo'],'SEGURO_VIAJE'), union(items('Apply_to_each')?['adjuntos'], createArray(addProperty(addProperty(json('{}'),'nombre',triggerBody()?['slip']?['nombrePdf']),'contenidoBase64',body('Convert_file')?['$content']))), items('Apply_to_each')?['adjuntos'])
       ```

     - `Name` = `item()?['nombre']`;
     - `ContentBytes` = `base64ToBinary(item()?['contenidoBase64'])`.
   - **Send an email from a shared mailbox (V2)**:
     - buzón `segurodeviaje@segurosatlas.com.mx`;
     - Para `item()?['para']`, CC `item()?['cc']`, Asunto `item()?['asunto']`;
     - Cuerpo `item()?['cuerpoHtml']`, sin el `<p class="editor-paragraph">`;
     - **Attachments** (modo matriz completa): `body('Select')`.

**Regla de los adjuntos:** todos pasan por **Select** y salen con
`ContentBytes = base64ToBinary(...)`, que los entrega como archivo. Si un adjunto se arma
fuera de Select o va como texto, Outlook lo vuelve a codificar y llega dañado ("Acrobat no
pudo abrir…").

## Etapas

`ETAPA` en `Code.gs` decide a quién llegan los correos de cada envío del formulario. Se cambia
el valor, se guarda y listo; no hay que tocar el activador ni Power Automate.

| `ETAPA` | TCI | TCC | Expediente | Copia |
|---|---|---|---|---|
| `'PRUEBAS'` | `CORREOS_PRUEBAS` | `CORREOS_PRUEBAS` | `CORREOS_PRUEBAS` | nadie |
| `'PILOTO'` | segurodeviaje@ | segurodeviaje@ | segurodeviaje@ | Eloisa y Miguel |
| `'PRODUCCION'` | mesacontroldanos@ | cotizacionesdanos@ | segurodeviaje@ | Eloisa y Miguel |

El rechazo por vigencia va al cliente en `'PILOTO'` y `'PRODUCCION'`; en `'PRUEBAS'` va a
`CORREOS_PRUEBAS`.

- **PRUEBAS:** `[PRUEBA]` en el asunto y una franja amarilla con los destinatarios y adjuntos
  reales, SLIP incluido.
- **PILOTO:** los correos salen en su formato final, sin franja ni `[PRUEBA]`. Si hace falta
  pedir el TCI o el TCC durante el piloto, se reenvía tal cual a Daños.
- Cualquier otro valor se trata como `'PRUEBAS'`.

## Pruebas

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

`probarRechazoVigencia()` manda a `CORREOS_PRUEBAS` el correo de rechazo por vigencia con
datos ficticios. `probarVigencia()` no manda nada: revisa la conexión con la hoja de propuestas.

`probarCorreosEmision()` manda los tres correos con datos ficticios **sin archivos** y el SLIP
de Master Elite. Sirve para revisar el formato rápido, no los adjuntos.

## Paso a producción

- [ ] Pruebas completas aprobadas: los 4 planes y persona física y moral.
- [ ] `Sexo` en las 5 secciones de asegurados.
- [ ] Sin activadores en el proyecto viejo de la hoja de respuestas.
- [x] Piloto: `ETAPA: 'PILOTO'` (todo a segurodeviaje@, ~20 días).
- [ ] Cambiar `ETAPA: 'PILOTO'` a `'PRODUCCION'` en `Code.gs` y guardar.
- [ ] Primer caso real: confirmar con Mesa Control y Cotizaciones Daños que el TCI y el TCC
      llegaron completos.

## Pendientes

