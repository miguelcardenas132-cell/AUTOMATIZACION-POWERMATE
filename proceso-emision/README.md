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
| `SOLICITUD DE EMISIÓN \|\| SENIOR +79 \|\| <contratante> \|\| <folio>` | segurodeviaje@segurosatlas.com.mx | Todo el formulario, por secciones | Todo lo que subió el cliente |

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

## Cambios necesarios en el formulario

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
   - solo llegan a `CORREO_PRUEBAS` (mhidalgo@), nunca a Mesa Control, Cotizaciones ni Eloisa.

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

## Pendientes

- [ ] Siguientes partes:
  - QR de la propuesta apuntando a este formulario;
  - textos de "Solicita tu póliza" en el PDF y el correo;
  - acuse al cliente, si se requiere.
