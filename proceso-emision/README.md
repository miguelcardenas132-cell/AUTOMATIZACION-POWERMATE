# Módulo: Notificación Automática — Solicitud de Emisión (Seguro de Viaje SENIOR 79+)

> **Estado (octubre 2026): pausado, pendiente de adaptar.** Se trajo tal cual
> del repo `Cotizaciones_2026-TCI-s` (rama `claude/proceso-emision-7kwxht`, la
> versión más reciente; la rama `claude/form-auto-email-script-9krhmn` es una
> versión anterior del mismo script). Desde entonces la propuesta cambió:
>
> - La emisión ya no se pide con este formulario: el correo de la propuesta
>   pide responder por correo con el formato de emisión (que va adjunto),
>   la propuesta aceptada, la CSF y la INE o pasaporte.
> - El folio ya no tiene el formato `COT-<fila>-<fecha>-<hora>` que busca
>   `extraerFolioDePdf_`; ahora es el de la hoja (`SEGURO_VIAJE_+79-...`).
> - El documento ya no se llama "cotización" sino "Propuesta de Seguro".
>
> Sirve como base para la siguiente fase (proceso autónomo hasta la
> emisión); antes de volver a usarlo hay que actualizar esos tres puntos.

## Contexto general

Este módulo es parte del sistema de cotización automatizada SENIOR 79+ de Seguros
Atlas (DINE — Dirección de Negocios Especiales), construido a costo cero con
Google Workspace + Microsoft 365. El sistema principal (captura → cálculo →
generación de PDF → distribución → evidencia) ya está documentado por separado.

Este módulo específico **no genera cotizaciones** — es un formulario aparte:
cuando el cliente/agente ya recibió su cotización en PDF y quiere tramitar la
emisión de la póliza, llena un segundo formulario ("Solicitud de Emisión de
Póliza de Seguro de Viaje"), y este script le avisa a Mike por correo con toda
la información, en formato legible y sin que tenga que revisar Sheets.

## Objetivo del módulo

- Al enviarse el formulario de solicitud de emisión → mandar un correo HTML
  con toda la información organizada por secciones.
- Adjuntar los PDFs que suba el cliente (cotización original + identificación/CSF).
- Detectar automáticamente el folio de la cotización (`COT-...`) leyendo el
  texto del PDF adjunto — el formulario nunca pide el folio manualmente.
- Cero costo, cero dependencias fuera de Google Workspace.

## Arquitectura — IMPORTANTE

- El script **vive dentro del Formulario de Google** (Extensiones → Apps
  Script desde el propio Form), **NO** dentro de la Hoja de respuestas.
- Es un proyecto de Apps Script **separado** del script principal de
  cotizaciones (el que arma el PDF y usa `e.range.getSheet()`, ligado a la
  Hoja "RESPUESTAS"). Ambos proyectos coexisten sin chocar porque cada uno
  vive en su propio contenedor (bound script), aunque los dos manejen
  triggers "al enviar formulario / al enviar respuesta".
- Trigger configurado: función `onFormSubmitSolicitudEmision`, evento
  **"Al enviarse el formulario"**, origen **"Desde el formulario"**.
- Servicio avanzado requerido: **Drive API v2** (Servicios (+) → Drive API →
  Añadir), usado solo para la extracción de folio vía OCR/conversión a texto.

## Estado actual

✅ Funcional en ambiente de pruebas. Enviando correctamente a
`mhidalgo@segurosatlas.com.mx` (temporal, para validación con el manager antes
de mover a producción).

Pendiente de mover a producción: cambiar `CORREO_DESTINO` a
`segurodeviaje@segurosatlas.com.mx` (la línea ya está preparada, comentada,
lista para descomentar).

## Estructura del formulario (8 secciones)

Esta lista es la fuente de verdad para el objeto `SECCIONES` del script — si
se agrega o quita una pregunta al formulario, hay que reflejarlo aquí Y en el
código (el match es por **texto exacto** del título de la pregunta):

1. **Información para emisión** — Nombre de Agente, Clave de Agente, Nombre de
   tu Ejecutivo, Sucursal, Producto Elegido, Costo en USD, Adjunta la
   cotización recibida (archivo), Adjunta tu CSF/INE/Identificación
   Migratoria (archivo)
2. **Información del Viaje** — Destino, Fecha de Salida, Fecha de Regreso
3. **Contratante (Persona Física o Moral)** — Nombre Completo del
   Contratante, Domicilio del Contratante, RFC, CURP (PERSONA FISICA),
   Correo Electronico, Teléfono, Ocupación
4. **Información del Asegurado (1)** — Nombre Completo, Fecha de Nacimiento,
   Contacto de Emergencia, Teléfono Contacto de Emergencia, Nombre
   Beneficiario, Domicilio del Asegurado, ¿Deseas agregar un segundo
   asegurado?
5. **Asegurado 2** — mismos campos + "2", condicional a la pregunta anterior
6. **Asegurado 3** — mismos campos + "3", condicional
7. **Asegurado 4** — mismos campos + "4", condicional
8. **Asegurado 5** — mismos campos + "5" (sin pregunta de "¿agregar otro?",
   es el máximo)

Las secciones de asegurados 2–5 son condicionales: si el cliente contesta
"No", esas preguntas no llegan en `e.response` y la sección completa no se
imprime en el correo (no aparecen bloques vacíos).

## Código actual completo

```javascript
function onFormSubmitSolicitudEmision(e) {
  if (!e || !e.response) {
    Logger.log('⚠️ Este evento no viene de un envío real del formulario. e.response no existe.');
    return;
  }

  // 🧪 AMBIENTE DE PRUEBAS — activo
  var CORREO_DESTINO = "mhidalgo@segurosatlas.com.mx";
  // ✅ PRODUCCIÓN — descomentar esta línea y comentar la de arriba cuando se mueva
  // var CORREO_DESTINO = "segurodeviaje@segurosatlas.com.mx";

  // ============================================================
  // MAPA DE SECCIONES — el texto debe coincidir EXACTO con el
  // título de la pregunta en el formulario
  // ============================================================
  var SECCIONES = [
    {
      titulo: "Información para emisión",
      preguntas: [
        "Nombre de Agente",
        "Clave de Agente",
        "Nombre de tu Ejecutivo",
        "Sucursal",
        "Producto Elegido",
        "Costo en USD",
        "Adjunta la cotización recibida",
        "Adjunta tu CSF (Constancia de Situación Fiscal) o INE o Identificación Migratoria de residencia mexicana"
      ]
    },
    {
      titulo: "Información del Viaje",
      preguntas: ["Destino", "Fecha de Salida", "Fecha de Regreso"]
    },
    {
      titulo: "Contratante (Persona Física o Moral)",
      preguntas: [
        "Nombre Completo del Contratante",
        "Domicilio del Contratante (Calle, No. Ext y/o Int, Colonia, Municipio o Delegación, C.P.)",
        "RFC",
        "CURP (PERSONA FISICA)",
        "Correo Electronico",
        "Teléfono",
        "Ocupación"
      ]
    },
    {
      titulo: "Información del Asegurado (1)",
      preguntas: [
        "Nombre Completo",
        "Fecha de Nacimiento",
        "Contacto de Emergencia",
        "Teléfono Contacto de Emergencia",
        "Nombre Beneficiario",
        "Domicilio del Asegurado (Calle, No. Ext y/o Int, Colonia, Municipio o Delegación, C.P.)",
        "¿Deseas agregar un segundo asegurado?"
      ]
    },
    {
      titulo: "Asegurado 2",
      preguntas: [
        "Nombre Completo 2", "Fecha de Nacimiento 2", "Contacto de Emergencia 2",
        "Teléfono Contacto de Emergencia 2", "Nombre Beneficiario 2",
        "¿Deseas agregar un tercer asegurado?"
      ]
    },
    {
      titulo: "Asegurado 3",
      preguntas: [
        "Nombre Completo 3", "Fecha de Nacimiento 3", "Contacto de Emergencia 3",
        "Teléfono Contacto de Emergencia 3", "Nombre Beneficiario 3",
        "¿Deseas agregar un cuarto asegurado?"
      ]
    },
    {
      titulo: "Asegurado 4",
      preguntas: [
        "Nombre Completo 4", "Fecha de Nacimiento 4", "Contacto de Emergencia 4",
        "Teléfono Contacto de Emergencia 4", "Nombre Beneficiario 4",
        "¿Deseas agregar un quinto asegurado?"
      ]
    },
    {
      titulo: "Asegurado 5",
      preguntas: [
        "Nombre Completo 5", "Fecha de Nacimiento 5", "Contacto de Emergencia 5",
        "Teléfono Contacto de Emergencia 5", "Nombre Beneficiario 5"
      ]
    }
  ];

  // ============================================================
  // 1. Leer todas las respuestas y guardarlas en un mapa {pregunta: filaHtml}
  // ============================================================
  var respuestas = e.response.getItemResponses();
  var mapaFilas = {};
  var adjuntos = [];
  var folioEncontrado = "";
  var preguntasUsadas = {}; // para detectar cuáles no cayeron en ninguna sección

  respuestas.forEach(function(item) {
    var pregunta = item.getItem().getTitle();
    var tipo = item.getItem().getType();
    var filaHtml;

    if (tipo == FormApp.ItemType.FILE_UPLOAD) {
      var idsArchivos = item.getResponse();
      var nombresArchivos = [];

      idsArchivos.forEach(function(fileId) {
        var archivo = DriveApp.getFileById(fileId);
        adjuntos.push(archivo.getBlob());
        nombresArchivos.push(archivo.getName());

        if (!folioEncontrado) {
          var folioDeEsteArchivo = extraerFolioDePdf_(fileId);
          if (folioDeEsteArchivo) folioEncontrado = folioDeEsteArchivo;
        }
      });

      filaHtml = filaTabla_(pregunta, '📎 ' + nombresArchivos.join(", ") + ' (adjunto)');
    } else {
      filaHtml = filaTabla_(pregunta, item.getResponse());
    }

    mapaFilas[pregunta] = filaHtml;
  });

  // ============================================================
  // 2. Armar cada sección solo con las preguntas que sí llegaron
  //    (las condicionales, ej. Asegurado 3, simplemente no aparecen)
  // ============================================================
  var bloquesSecciones = "";

  SECCIONES.forEach(function(seccion) {
    var filasSeccion = "";
    seccion.preguntas.forEach(function(pregunta) {
      if (mapaFilas.hasOwnProperty(pregunta)) {
        filasSeccion += mapaFilas[pregunta];
        preguntasUsadas[pregunta] = true;
      }
    });

    if (filasSeccion) {
      bloquesSecciones += bloqueSeccion_(seccion.titulo, filasSeccion);
    }
  });

  // Cualquier pregunta que no haya caído en ninguna sección (por texto
  // distinto al de la lista) se muestra igual, para no perder información
  var filasOtros = "";
  Object.keys(mapaFilas).forEach(function(pregunta) {
    if (!preguntasUsadas[pregunta]) filasOtros += mapaFilas[pregunta];
  });
  if (filasOtros) {
    bloquesSecciones += bloqueSeccion_("Otros", filasOtros);
  }

  // ============================================================
  // 3. Folio, asunto y envío
  // ============================================================
  var fecha = new Date().toLocaleString("es-MX");

  var bannerFolio = folioEncontrado
    ? '<div style="background-color:#e6f4f3;border:1px solid #027370;border-radius:4px;padding:8px 14px;margin-bottom:14px;font-size:13px;">' +
        '<strong style="color:#027370;">Folio de cotización:</strong> ' + folioEncontrado +
      '</div>'
    : '<div style="background-color:#fff4e5;border:1px solid #e0a800;border-radius:4px;padding:8px 14px;margin-bottom:14px;font-size:13px;color:#7a5b00;">' +
        '⚠️ No se pudo detectar el folio automáticamente. Revisar el PDF adjunto manualmente.' +
      '</div>';

  var asunto = folioEncontrado
    ? "Nueva solicitud de emisión — Folio " + folioEncontrado
    : "Nueva solicitud de emisión — Seguro de Viaje";

  // Tabla exterior fija a 600px — esto es lo que evita que se expanda
  // a todo el ancho de la pantalla en Gmail/Outlook
  var html =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f0f0;padding:20px 0;">' +
      '<tr><td align="center">' +
        '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid #e0e0e0;border-radius:6px;overflow:hidden;font-family:Arial, sans-serif;">' +
          '<tr><td style="background-color:#027370;padding:18px 20px;">' +
            '<h2 style="color:#ffffff;margin:0;font-size:18px;">Nueva Solicitud de Emisión — Seguro de Viaje</h2>' +
          '</td></tr>' +
          '<tr><td style="padding:14px 20px 6px;">' +
            bannerFolio +
            '<p style="color:#555555;font-size:13px;margin:0 0 4px;">Se recibió una nueva solicitud a través del formulario:</p>' +
          '</td></tr>' +
          '<tr><td style="padding:0 20px 10px;">' +
            bloquesSecciones +
            '<p style="color:#888888;font-size:12px;margin-top:8px;">Fecha de solicitud: ' + fecha + '</p>' +
          '</td></tr>' +
          '<tr><td style="background-color:#f5f5f5;padding:12px 20px;text-align:center;">' +
            '<p style="color:#999999;font-size:11px;margin:0;">Seguros Atlas · Dirección de Negocios Especiales · Seguro de Viaje</p>' +
          '</td></tr>' +
        '</table>' +
      '</td></tr>' +
    '</table>';

  MailApp.sendEmail({
    to: CORREO_DESTINO,
    subject: asunto,
    htmlBody: html,
    attachments: adjuntos
  });
}

// ============================================================
// Helpers de formato
// ============================================================

/** Fila individual pregunta/respuesta dentro de la tabla de una sección */
function filaTabla_(pregunta, valor) {
  return '<tr>' +
    '<td style="padding:8px 10px;border-bottom:1px solid #eeeeee;font-weight:bold;color:#027370;width:42%;font-size:12.5px;">' + pregunta + '</td>' +
    '<td style="padding:8px 10px;border-bottom:1px solid #eeeeee;color:#333333;font-size:12.5px;">' + valor + '</td>' +
  '</tr>';
}

/** Bloque completo de una sección: encabezado verde + su tabla de filas */
function bloqueSeccion_(titulo, filasHtml) {
  return '<div style="margin-bottom:14px;">' +
    '<div style="background-color:#e6f4f3;border-left:4px solid #027370;padding:6px 10px;margin-bottom:2px;">' +
      '<span style="color:#027370;font-weight:bold;font-size:13px;">' + titulo + '</span>' +
    '</div>' +
    '<table style="width:100%;border-collapse:collapse;">' + filasHtml + '</table>' +
  '</div>';
}

/**
 * Convierte un PDF de Drive a texto (Drive API), busca el patrón de folio
 * "COT-<fila>-<fecha>-<hora>" y borra el documento temporal.
 */
function extraerFolioDePdf_(fileId) {
  var docTemporalId = null;
  try {
    var archivoOriginal = DriveApp.getFileById(fileId);
    var blob = archivoOriginal.getBlob();

    var recurso = {
      title: 'TEMP_OCR_' + fileId,
      mimeType: MimeType.GOOGLE_DOCS
    };

    var docConvertido = Drive.Files.insert(recurso, blob, { ocr: true, ocrLanguage: 'es' });
    docTemporalId = docConvertido.id;

    var texto = DocumentApp.openById(docTemporalId).getBody().getText();

    var match = texto.match(/COT-\d+-\d{8}-\d{6}/);
    return match ? match[0] : "";

  } catch (error) {
    Logger.log('No se pudo extraer folio de ' + fileId + ': ' + error.message);
    return "";
  } finally {
    if (docTemporalId) {
      try { DriveApp.getFileById(docTemporalId).setTrashed(true); } catch (e2) {}
    }
  }
}
```

## Problemas resueltos durante la construcción (bitácora de debugging)

1. **`TypeError: Cannot read properties of undefined (reading 'response')`**
   al ejecutar manualmente con ▶ desde el editor — `e` no existe fuera de un
   disparo real del trigger. Solución: agregar guard clause
   `if (!e || !e.response) return;` al inicio, y solo probar llenando el
   formulario en vista previa, nunca con Ejecutar directo.

2. **`TypeError: Cannot read properties of undefined (reading 'getItemResponses')`**
   con el trigger ya disparado como "Activador" (no "Editor") — causa real:
   el script estaba pegado en el proyecto de Apps Script **de la Hoja**, no
   del **Formulario**. El origen de evento "Desde el formulario" solo está
   disponible si el script vive dentro del Form. Al estar en el proyecto de
   la Hoja, el trigger se registraba como "Desde la hoja de cálculo" y el
   objeto `e` llegaba con la forma equivocada (`e.range` en vez de
   `e.response`). Solución: mover el script al editor de Apps Script propio
   del formulario de solicitud de emisión, y renombrar la función a
   `onFormSubmitSolicitudEmision` para evitar cualquier colisión de nombre
   con el `onFormSubmit` del script principal de cotizaciones.

3. **El HTML del correo se expandía a todo el ancho de la pantalla** —
   Gmail/Outlook ignoran `max-width` en un `<div>` suelto (motores de
   renderizado tipo Word/Outlook no soportan CSS moderno en divs de forma
   consistente). Solución: envolver todo en una tabla exterior
   `width="100%"` que centra + una tabla interior `width="600"` fija, patrón
   estándar de plantillas de email.

## Pendientes

- [ ] **Mover a producción**: descomentar `CORREO_DESTINO =
      "segurodeviaje@segurosatlas.com.mx"` y comentar la línea de pruebas,
      una vez que el manager valide el formato en las pruebas actuales.
- [ ] **Prefijo `[PRUEBA]` en el asunto** mientras siga en ambiente de
      pruebas, para que no se confunda con una solicitud real si se reenvía
      por error (propuesto, no implementado aún).
- [ ] **Logo de Atlas en base64** arriba del encabezado del correo, igual
      que en el PDF de cotización (propuesto, no implementado aún).
- [ ] Validar con Mike si el match de folio (`COT-\d+-\d{8}-\d{6}`) sigue
      siendo válido si en algún momento cambia el formato de folio del
      script principal — si cambia allá, hay que actualizar el regex aquí
      también, están desacoplados.
- [ ] Confirmar si se requiere copiar también estos correos/adjuntos a
      SharePoint como respaldo de auditoría (igual que el flujo principal de
      cotizaciones), o si con el respaldo en Drive (archivos originales del
      formulario) es suficiente.

## Datos de referencia

| Dato | Valor |
|---|---|
| Correo de pruebas (temporal) | mhidalgo@segurosatlas.com.mx |
| Correo de producción (pendiente activar) | segurodeviaje@segurosatlas.com.mx |
| Formato de folio esperado | `COT-<fila>-<yyyyMMdd>-<HHmmss>` (ej. `COT-42-20260814-153045`) |
| Servicio avanzado requerido | Drive API v2 (Servicios → Drive API → Añadir) |
| Función del trigger | `onFormSubmitSolicitudEmision` |
| Evento del trigger | Al enviarse el formulario |
| Origen del trigger | Desde el formulario (¡no desde la hoja!) |
| Color corporativo | Verde/Teal Atlas `#027370` |

## Cómo trabajar en este módulo

Este README está pensado para dar contexto completo sin tener que releer todo
el hilo de la conversación original. Al retomar el trabajo:

1. Copiar el código de la sección "Código actual completo" al editor de Apps
   Script del **formulario** de solicitud de emisión (no de la Hoja).
2. Confirmar que el servicio Drive API v2 esté activado en ese proyecto.
3. Confirmar que el trigger apunte a `onFormSubmitSolicitudEmision`, evento
   "Al enviarse el formulario", origen "Desde el formulario".
4. Para cualquier cambio en las preguntas del formulario, actualizar tanto el
   formulario como el objeto `SECCIONES` en el código — el match es por
   texto exacto.
