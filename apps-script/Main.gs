/**
 * Cotizador Seguro de Viaje SENIOR 79+ — Seguros Atlas (DINE)
 * Capa 3 (Apps Script) + Puente hacia Power Automate.
 *
 * Flujo: Form Submit -> leer fila -> armar datos -> render HTML -> PDF (html2pdf.app)
 *        -> guardar en Drive -> notificar a Power Automate por webhook.
 */

// ============================================================
// CONFIGURACIÓN
// ============================================================

/**
 * Ejecutar UNA SOLA VEZ desde el editor de Apps Script (menú Ejecutar).
 * Guarda los valores sensibles en Script Properties para no exponerlos
 * en el código fuente / control de versiones.
 */
function configurarPropiedades() {
  PropertiesService.getScriptProperties().setProperties({
    CARPETA_DRIVE_ID: 'PEGAR_ID_CARPETA_DRIVE',
    WEBHOOK_POWER_AUTOMATE_URL: 'PEGAR_URL_HTTP_TRIGGER_POWER_AUTOMATE',
    HTML2PDF_API_KEY: 'PEGAR_API_KEY_HTML2PDF_APP'
  });
}

const CONFIG = {
  VIGENCIA_DIAS: 7,
  MAX_ASEGURADOS: 10,
  PRODUCTO_ANUAL_MULTIVIAJE: 'Anual Multiviaje',

  // Ajustar estos textos para que coincidan EXACTO con los encabezados
  // (fila 1) de la hoja de respuestas del formulario.
  ENCABEZADOS: {
    TITULAR: 'Nombre del titular',
    CORREO_DESTINO: 'Correo de contacto',
    CORREO_CC: 'Correo CC',
    PRODUCTO: 'Producto',
    FECHA_INICIO: 'Fecha de inicio del viaje',
    FECHA_FIN: 'Fecha de fin del viaje',
    TIPO_PRODUCTO: 'Individual o Grupal', // Columna AF
    PRIMA_TOTAL: 'Prima total',
    ESTADO: 'Estado de envío' // Columna opcional para trazabilidad; si no existe, se omite
  }
};

// ============================================================
// TRIGGER PRINCIPAL
// ============================================================

/**
 * Trigger instalable "Al enviar formulario" (no usar getLastRow():
 * e.range.getRow() evita leer la fila equivocada si dos personas
 * cotizan casi al mismo tiempo).
 */
function onFormSubmit(e) {
  const sheet = e.range.getSheet();
  const fila = e.range.getRow();
  const encabezados = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  try {
    const valores = sheet.getRange(fila, 1, 1, sheet.getLastColumn()).getValues()[0];
    const obtenerValor = (nombreEncabezado) => {
      const indice = encabezados.findIndex((h) => h.toString().trim() === nombreEncabezado);
      if (indice === -1) throw new Error('Encabezado no encontrado: ' + nombreEncabezado);
      return valores[indice];
    };

    const data = construirDatosCotizacion_(fila, encabezados, valores, obtenerValor);
    const htmlContenido = generarHtmlCotizacion_(data);
    const pdfBlob = generarPdf_(htmlContenido, data.nombreArchivo);
    const archivoPdf = guardarPdfEnDrive_(pdfBlob, data.nombreArchivo);

    enviarWebhookPowerAutomate_(archivoPdf, data);

    marcarEstadoFila_(sheet, fila, encabezados, 'Enviado a Power Automate ✅');
  } catch (error) {
    Logger.log('Error en onFormSubmit (fila ' + fila + '): ' + error.message);
    marcarEstadoFila_(sheet, fila, encabezados, 'ERROR: ' + error.message);
    throw error; // conserva el fallo visible en las ejecuciones de Apps Script
  }
}

// ============================================================
// LÓGICA DE NEGOCIO
// ============================================================

function construirDatosCotizacion_(fila, encabezados, valores, obtenerValor) {
  const H = CONFIG.ENCABEZADOS;
  const producto = obtenerValor(H.PRODUCTO);
  const esAnualMultiviaje = producto === CONFIG.PRODUCTO_ANUAL_MULTIVIAJE;

  const hoy = new Date();
  const vigencia = new Date(hoy.getTime());
  vigencia.setDate(vigencia.getDate() + CONFIG.VIGENCIA_DIAS);

  const asegurados = [];
  for (let i = 1; i <= CONFIG.MAX_ASEGURADOS; i++) {
    const nombre = obtenerValorSeguro_(encabezados, valores, 'Asegurado ' + i + ' Nombre');
    if (!nombre || nombre.toString().trim() === '') continue; // omite renglones vacíos
    asegurados.push({
      numero: asegurados.length + 1,
      nombre: nombre,
      edad: obtenerValorSeguro_(encabezados, valores, 'Asegurado ' + i + ' Edad'),
      prima: obtenerValorSeguro_(encabezados, valores, 'Asegurado ' + i + ' Prima')
    });
  }

  const folio = 'COT-' + fila + '-' + Utilities.formatDate(hoy, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');

  return {
    folio: folio,
    fila: fila,
    titular: obtenerValor(H.TITULAR),
    correoDestino: obtenerValor(H.CORREO_DESTINO),
    correoCC: obtenerValor(H.CORREO_CC),
    producto: producto,
    esAnualMultiviaje: esAnualMultiviaje,
    fechaInicio: esAnualMultiviaje ? null : formatearFecha_(obtenerValor(H.FECHA_INICIO)),
    fechaFin: esAnualMultiviaje ? null : formatearFecha_(obtenerValor(H.FECHA_FIN)),
    vigenciaTexto: Utilities.formatDate(vigencia, Session.getScriptTimeZone(), 'dd/MM/yyyy'),
    primaTotal: obtenerValor(H.PRIMA_TOTAL),
    tipoProducto: obtenerValor(H.TIPO_PRODUCTO), // Individual / Grupal — columna AF
    asegurados: asegurados,
    nombreArchivo: 'Cotizacion_' + folio + '.pdf'
  };
}

function obtenerValorSeguro_(encabezados, valores, nombreEncabezado) {
  const indice = encabezados.findIndex((h) => h.toString().trim() === nombreEncabezado);
  return indice === -1 ? '' : valores[indice];
}

function formatearFecha_(valor) {
  if (!valor) return '';
  const fecha = valor instanceof Date ? valor : new Date(valor);
  return Utilities.formatDate(fecha, Session.getScriptTimeZone(), 'dd/MM/yyyy');
}

// ============================================================
// GENERACIÓN DE HTML Y PDF
// ============================================================

function generarHtmlCotizacion_(data) {
  const template = HtmlService.createTemplateFromFile('PlantillaCotizacion');
  template.data = data;
  return template.evaluate().getContent();
}

function generarPdf_(htmlContenido, nombreArchivo) {
  const apiKey = getPropiedad_('HTML2PDF_API_KEY');
  const respuesta = UrlFetchApp.fetch('https://api.html2pdf.app/v1/generate', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ html: htmlContenido, apiKey: apiKey }),
    muteHttpExceptions: true
  });

  if (respuesta.getResponseCode() !== 200) {
    throw new Error('html2pdf.app respondió ' + respuesta.getResponseCode() + ': ' + respuesta.getContentText());
  }

  return respuesta.getBlob().setName(nombreArchivo);
}

function guardarPdfEnDrive_(pdfBlob, nombreArchivo) {
  const carpeta = DriveApp.getFolderById(getPropiedad_('CARPETA_DRIVE_ID'));
  return carpeta.createFile(pdfBlob).setName(nombreArchivo);
}

// ============================================================
// PUENTE HACIA POWER AUTOMATE
// ============================================================

function enviarWebhookPowerAutomate_(archivoPdf, data) {
  const payload = {
    folio: data.folio,
    fileId: archivoPdf.getId(),
    fileUrl: archivoPdf.getUrl(),
    nombreArchivo: data.nombreArchivo,
    correoDestino: data.correoDestino,
    correoCC: data.correoCC,
    tipoProducto: data.tipoProducto, // Individual / Grupal — usado por Power Automate para el anexo
    producto: data.producto,
    titular: data.titular,
    primaTotal: data.primaTotal,
    fechaGeneracion: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX")
  };

  const respuesta = UrlFetchApp.fetch(getPropiedad_('WEBHOOK_POWER_AUTOMATE_URL'), {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (respuesta.getResponseCode() >= 300) {
    throw new Error('Power Automate respondió ' + respuesta.getResponseCode() + ': ' + respuesta.getContentText());
  }
}

// ============================================================
// UTILIDADES
// ============================================================

function getPropiedad_(nombre) {
  const valor = PropertiesService.getScriptProperties().getProperty(nombre);
  if (!valor) throw new Error('Falta configurar la propiedad "' + nombre + '". Ejecuta configurarPropiedades().');
  return valor;
}

function marcarEstadoFila_(sheet, fila, encabezados, mensaje) {
  const indiceEstado = encabezados.findIndex((h) => h.toString().trim() === CONFIG.ENCABEZADOS.ESTADO);
  if (indiceEstado === -1) return; // columna opcional: si no existe en la hoja, se omite
  sheet.getRange(fila, indiceEstado + 1).setValue(mensaje + ' — ' + new Date());
}
