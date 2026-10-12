/**
 * Módulo: Notificación Automática — Solicitud de Emisión
 * (Seguro de Viaje SENIOR 79+, Seguros Atlas — DINE)
 *
 * Vive dentro del proyecto de Apps Script ligado al FORMULARIO de
 * "Solicitud de Emisión de Póliza de Seguro de Viaje" (no en la Hoja de
 * respuestas, y no en el mismo proyecto que el script principal de
 * cotizaciones). Ver README.md de esta carpeta para el contexto completo,
 * arquitectura, y pasos para desplegar.
 */

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
