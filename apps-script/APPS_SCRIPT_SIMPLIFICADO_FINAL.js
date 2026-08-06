/**
 * Cotizador Seguro de Viaje SENIOR 79+ — Seguros Atlas (DINE)
 * VERSIÓN SIMPLIFICADA — sin html2pdf.app.
 *
 * Toda la regla de negocio vive aquí. Power Automate solo emite el correo:
 * recibe el cuerpo HTML ya armado y el adjunto listo para convertir a PDF.
 *
 *   1) Leer la fila del formulario.
 *   2) Validar anticipación (mínimo 5 días naturales antes del viaje).
 *   3) Filtrar asegurados elegibles (79-89 años) y registrar los excluidos.
 *   4) Sustituir los tokens {{...}} sobre la plantilla real (guardada en Drive).
 *   5) Guardar el HTML en Drive (auditoría) con codificación UTF-8 explícita.
 *   6) Construir el cuerpo HTML del correo (aprobación o rechazo).
 *   7) Disparar el webhook a Power Automate.
 *
 * NOTA SOBRE EL ADJUNTO: Apps Script NO produce el PDF (por eso se descartó
 * html2pdf.app). Se envía `htmlBase64` con el HTML ya procesado; Power
 * Automate hace base64ToBinary() -> guarda en OneDrive -> "Convert file"
 * (Word Online) -> PDF. Así el flow tampoco necesita el conector de Drive.
 */

// ============================================================
// CONFIGURACIÓN
// ============================================================

/**
 * Ejecutar UNA SOLA VEZ desde el editor de Apps Script.
 * Guarda los valores sensibles en Script Properties (no van en el código).
 */
function configurarPropiedades() {
  PropertiesService.getScriptProperties().setProperties({
    PLANTILLA_HTML_ID: 'ID_DEL_ARCHIVO_COTIZACION_SENIOR79_v6_FINAL_EN_DRIVE',
    CARPETA_SALIDA_ID: 'ID_CARPETA_DRIVE_DONDE_SE_GUARDA_EL_HTML_GENERADO',
    WEBHOOK_POWER_AUTOMATE_URL: 'URL_DEL_TRIGGER_HTTP_DE_POWER_AUTOMATE'
  });
}

const CONFIG = {
  VIGENCIA_DIAS: 7,
  MAX_ASEGURADOS: 5, // la plantilla solo tiene renglones {{ASEGURADO_1}}..{{ASEGURADO_5}}
  PRODUCTO_ANUAL_MULTIVIAJE: 'Anual Multiviaje',
  EDAD_MINIMA: 79,
  EDAD_MAXIMA: 89,
  DIAS_ANTICIPACION_MINIMA: 5,

  ESTATUS: {
    APROBADO: 'APROBADO',
    RECHAZADO_TIEMPO: 'RECHAZADO_TIEMPO',
    RECHAZADO_SIN_ELEGIBLES: 'RECHAZADO_SIN_ELEGIBLES'
  },

  // Ajustar a los encabezados reales (fila 1) de la hoja de respuestas.
  ENCABEZADOS: {
    DESTINO: 'Destino',
    EMAIL_CLIENTE: 'Correo de contacto',
    CORREO_CC: 'Correo CC',
    PRODUCTO: 'Producto',
    FECHA_INICIO: 'Fecha de inicio del viaje',
    FECHA_FIN: 'Fecha de fin del viaje',
    PRIMA_MASTER: 'Prima Master',
    PRIMA_SMART: 'Prima Master Smart',
    PRIMA_ELITE: 'Prima Master Elite',
    PRIMA_PREMIUM: 'Prima Master Premium',
    ESTADO: 'Estado de envío' // Columna opcional para trazabilidad
  },
  ASEGURADO_PREFIJO: 'Asegurado ' // columnas "Asegurado 1 Nombre"/"Asegurado 1 Edad".."Asegurado 5 ..."
};

// Paleta corporativa usada en el correo (misma que la plantilla PDF).
const COLORES = {
  VERDE: '#0d5e3a',
  VERDE_CLARO: '#eef4f1',
  AZUL: '#0f2b48',
  BORDE: '#cbd5e1',
  AMBAR_FONDO: '#fff8e1',
  AMBAR_BORDE: '#f0ad4e',
  ROJO_FONDO: '#fdecea',
  ROJO_BORDE: '#d9534f'
};

// ============================================================
// TRIGGER PRINCIPAL
// ============================================================

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

    const data = construirTokens_(fila, encabezados, valores, obtenerValor);
    procesarSolicitud_(data);

    marcarEstadoFila_(sheet, fila, encabezados, data.estatus + ' — enviado a Power Automate');
  } catch (error) {
    Logger.log('Error en onFormSubmit (fila ' + fila + '): ' + error.message);
    marcarEstadoFila_(sheet, fila, encabezados, 'ERROR: ' + error.message);
    throw error;
  }
}

/**
 * Decide la ruta según el estatus: las solicitudes rechazadas no generan
 * cotización ni adjunto, solo el correo formal de rechazo.
 */
function procesarSolicitud_(data) {
  if (data.estatus !== CONFIG.ESTATUS.APROBADO) {
    data.cuerpoCorreoHtml = construirCorreoRechazo_(data);
    enviarWebhookPowerAutomate_(null, data);
    return;
  }

  const htmlContenido = generarHtmlDesdeTokens_(data.tokens);
  const archivoHtml = guardarHtmlEnDrive_(htmlContenido, data.nombreArchivo);
  data.cuerpoCorreoHtml = construirCorreoAprobado_(data);
  enviarWebhookPowerAutomate_(archivoHtml, data, htmlContenido);
}

// ============================================================
// LÓGICA DE NEGOCIO
// ============================================================

function construirTokens_(fila, encabezados, valores, obtenerValor) {
  const H = CONFIG.ENCABEZADOS;
  const producto = obtenerValor(H.PRODUCTO);
  const esAnualMultiviaje = producto === CONFIG.PRODUCTO_ANUAL_MULTIVIAJE;

  const hoy = new Date();
  const vigenciaDate = new Date(hoy.getTime());
  vigenciaDate.setDate(vigenciaDate.getDate() + CONFIG.VIGENCIA_DIAS);
  const vigenciaCotizacion = Utilities.formatDate(vigenciaDate, Session.getScriptTimeZone(), "dd 'de' MMMM 'de' yyyy");

  // --- Filtro SENIOR: solo califican asegurados de 79 a 89 años ---
  const asegurados = [];
  const pasajerosExcluidos = [];
  for (let i = 1; i <= CONFIG.MAX_ASEGURADOS; i++) {
    const nombreCrudo = obtenerValorSeguro_(encabezados, valores, CONFIG.ASEGURADO_PREFIJO + i + ' Nombre');
    if (!nombreCrudo || nombreCrudo.toString().trim() === '') continue;

    const nombre = nombreCrudo.toString().trim();
    const edadNum = Number(obtenerValorSeguro_(encabezados, valores, CONFIG.ASEGURADO_PREFIJO + i + ' Edad'));

    if (isNaN(edadNum) || edadNum < CONFIG.EDAD_MINIMA || edadNum > CONFIG.EDAD_MAXIMA) {
      pasajerosExcluidos.push({ nombre: nombre, edad: isNaN(edadNum) ? null : edadNum });
      continue;
    }
    asegurados.push({ nombre: nombre, edad: edadNum });
  }
  const numAsegurados = asegurados.length;
  const listaAsegurados = asegurados.map((a) => a.nombre + ' (' + a.edad + ' años)').join(', ');

  // --- Fechas del viaje ---
  // La plantilla espera "—" en fechas/días para Anual Multiviaje (no las oculta).
  const inicioRaw = esAnualMultiviaje ? null : obtenerValor(H.FECHA_INICIO);
  const finRaw = esAnualMultiviaje ? null : obtenerValor(H.FECHA_FIN);
  const fechaInicio = esAnualMultiviaje ? '—' : formatearFecha_(inicioRaw);
  const fechaFin = esAnualMultiviaje ? '—' : formatearFecha_(finRaw);
  const cantidadDias = esAnualMultiviaje ? '—' : String(calcularDias_(inicioRaw, finRaw));

  // --- Regla de anticipación: mínimo 5 días naturales ---
  // Anual Multiviaje no tiene fecha de inicio de viaje, así que la regla
  // no le aplica (diasAnticipacion queda en null y no se evalúa).
  const diasAnticipacion = esAnualMultiviaje ? null : calcularDiasAnticipacion_(hoy, inicioRaw);

  let estatus = CONFIG.ESTATUS.APROBADO;
  if (diasAnticipacion !== null && diasAnticipacion < CONFIG.DIAS_ANTICIPACION_MINIMA) {
    estatus = CONFIG.ESTATUS.RECHAZADO_TIEMPO;
  } else if (numAsegurados === 0) {
    // Ningún pasajero cae en el rango 79-89: no hay nada que cotizar.
    estatus = CONFIG.ESTATUS.RECHAZADO_SIN_ELEGIBLES;
  }

  // --- Primas: solo se calculan si la solicitud procede ---
  const aprobado = estatus === CONFIG.ESTATUS.APROBADO;
  const primaMaster = aprobado ? leerPrima_(obtenerValor(H.PRIMA_MASTER)) : 0;
  const primaSmart = aprobado ? leerPrima_(obtenerValor(H.PRIMA_SMART)) : 0;
  const primaElite = aprobado ? leerPrima_(obtenerValor(H.PRIMA_ELITE)) : 0;
  const primaPremium = aprobado ? leerPrima_(obtenerValor(H.PRIMA_PREMIUM)) : 0;

  const folio = 'COT-' + fila + '-' + Utilities.formatDate(hoy, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const destino = obtenerValor(H.DESTINO);

  return {
    folio: folio,
    estatus: estatus,
    destino: destino,
    emailCliente: obtenerValor(H.EMAIL_CLIENTE),
    correoCC: obtenerValor(H.CORREO_CC),
    esAnualMultiviaje: esAnualMultiviaje,
    fechaInicio: fechaInicio,
    fechaFin: fechaFin,
    cantidadDias: cantidadDias,
    diasAnticipacion: diasAnticipacion,
    vigenciaCotizacion: vigenciaCotizacion,
    numAsegurados: numAsegurados,
    listaAsegurados: listaAsegurados,
    pasajerosExcluidos: pasajerosExcluidos,
    primaMaster: primaMaster,
    primaSmart: primaSmart,
    primaElite: primaElite,
    primaPremium: primaPremium,
    totalMaster: redondear_(primaMaster * numAsegurados),
    totalSmart: redondear_(primaSmart * numAsegurados),
    totalElite: redondear_(primaElite * numAsegurados),
    totalPremium: redondear_(primaPremium * numAsegurados),
    nombreArchivo: 'Cotizacion_' + folio + '.html',
    tokens: {
      FOLIO: folio,
      FECHA_COTIZACION: Utilities.formatDate(hoy, Session.getScriptTimeZone(), "dd 'de' MMMM 'de' yyyy"),
      VIGENCIA: vigenciaCotizacion,
      ASEGURADO_1: etiquetaAsegurado_(asegurados[0]),
      ASEGURADO_2: etiquetaAsegurado_(asegurados[1]),
      ASEGURADO_3: etiquetaAsegurado_(asegurados[2]),
      ASEGURADO_4: etiquetaAsegurado_(asegurados[3]),
      ASEGURADO_5: etiquetaAsegurado_(asegurados[4]),
      NUM_ASEGURADOS: String(numAsegurados),
      DESTINO: destino,
      FECHA_INICIO: fechaInicio,
      FECHA_FIN: fechaFin,
      CANTIDAD_DIAS: cantidadDias,
      PRIMA_MASTER: primaMaster.toFixed(2),
      PRIMA_SMART: primaSmart.toFixed(2),
      PRIMA_ELITE: primaElite.toFixed(2),
      PRIMA_PREMIUM: primaPremium.toFixed(2),
      TOTAL_MASTER: (primaMaster * numAsegurados).toFixed(2),
      TOTAL_SMART: (primaSmart * numAsegurados).toFixed(2),
      TOTAL_ELITE: (primaElite * numAsegurados).toFixed(2),
      TOTAL_PREMIUM: (primaPremium * numAsegurados).toFixed(2)
    }
  };
}

function etiquetaAsegurado_(asegurado) {
  return asegurado ? asegurado.nombre + ', ' + asegurado.edad + ' años' : '';
}

function leerPrima_(valor) {
  return redondear_(Number(valor) || 0);
}

function redondear_(numero) {
  return Math.round(numero * 100) / 100;
}

function obtenerValorSeguro_(encabezados, valores, nombreEncabezado) {
  const indice = encabezados.findIndex((h) => h.toString().trim() === nombreEncabezado);
  return indice === -1 ? '' : valores[indice];
}

function formatearFecha_(valor) {
  if (!valor) return '—';
  const fecha = valor instanceof Date ? valor : new Date(valor);
  return Utilities.formatDate(fecha, Session.getScriptTimeZone(), 'dd/MM/yyyy');
}

function calcularDias_(inicio, fin) {
  if (!inicio || !fin) return '—';
  const fechaInicio = inicio instanceof Date ? inicio : new Date(inicio);
  const fechaFin = fin instanceof Date ? fin : new Date(fin);
  const msPorDia = 24 * 60 * 60 * 1000;
  return Math.round((fechaFin - fechaInicio) / msPorDia) + 1; // inclusive
}

/**
 * Días naturales completos entre hoy y el inicio del viaje.
 * Ambas fechas se normalizan a medianoche para que la hora en que se
 * envía el formulario no altere la cuenta (un viaje que arranca mañana
 * son 1 día de anticipación, se solicite a las 08:00 o a las 23:00).
 * Devuelve null si no hay fecha de inicio válida.
 */
function calcularDiasAnticipacion_(hoy, fechaInicioViaje) {
  if (!fechaInicioViaje) return null;
  const inicio = fechaInicioViaje instanceof Date ? fechaInicioViaje : new Date(fechaInicioViaje);
  if (isNaN(inicio.getTime())) return null;

  const hoyMedianoche = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  const inicioMedianoche = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate());
  const msPorDia = 24 * 60 * 60 * 1000;
  return Math.round((inicioMedianoche - hoyMedianoche) / msPorDia);
}

// ============================================================
// GENERACIÓN DE HTML (reemplazo de tokens sobre la plantilla real)
// ============================================================

function generarHtmlDesdeTokens_(tokens) {
  const plantillaId = getPropiedad_('PLANTILLA_HTML_ID');
  let html = DriveApp.getFileById(plantillaId).getBlob().getDataAsString('UTF-8');

  Object.keys(tokens).forEach((clave) => {
    const patron = new RegExp('\\{\\{' + clave + '\\}\\}', 'g');
    html = html.replace(patron, escaparHtml_(tokens[clave]));
  });

  // Oculta renglones de asegurados vacíos: <li><span id="asegurado_N"></span></li>
  html = html.replace(/<li><span id="asegurado_\d+"><\/span><\/li>\s*/g, '');

  // Quita la franja de control "LIMITE DE LA HOJA A4" (solo sirve en el
  // navegador; no hay que confiar en que Word Online respete @media/no-print).
  html = html.replace(/<div class="marca-limite-a4[^"]*">[\s\S]*?<\/div>\s*/, '');

  // Red de seguridad: cualquier {{TOKEN}} sin sustituir se limpia para que
  // Word Online nunca reciba texto crudo de plantilla en el documento final.
  html = html.replace(/\{\{[A-Z0-9_]+\}\}/g, '—');

  return html;
}

function escaparHtml_(valor) {
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function guardarHtmlEnDrive_(htmlContenido, nombreArchivo) {
  const carpeta = DriveApp.getFolderById(getPropiedad_('CARPETA_SALIDA_ID'));
  const blob = Utilities.newBlob(htmlContenido, 'text/html; charset=UTF-8', nombreArchivo);
  return carpeta.createFile(blob);
}

// ============================================================
// CUERPO HTML DEL CORREO
// ============================================================
// Se arma con tablas y CSS inline porque Outlook (escritorio y web) ignora
// <style> en <head>, flexbox y grid.

function construirAsunto_(data) {
  if (data.estatus === CONFIG.ESTATUS.APROBADO) {
    return 'Cotización Seguro de Viaje SENIOR +79 — ' + data.destino + ' — Folio ' + data.folio;
  }
  return 'Solicitud no procesada — Seguro de Viaje SENIOR +79 — Folio ' + data.folio;
}

function construirCorreoAprobado_(data) {
  const filaResumen = (etiqueta, valor) =>
    '<tr>' +
    '<td style="padding:5px 10px;border-bottom:1px solid ' + COLORES.BORDE + ';font-weight:bold;color:' + COLORES.AZUL + ';width:42%;">' + escaparHtml_(etiqueta) + '</td>' +
    '<td style="padding:5px 10px;border-bottom:1px solid ' + COLORES.BORDE + ';color:#333;">' + escaparHtml_(valor) + '</td>' +
    '</tr>';

  const filaPlan = (plan, total) =>
    '<tr>' +
    '<td style="padding:7px 10px;border:1px solid ' + COLORES.BORDE + ';color:#333;">' + escaparHtml_(plan) + '</td>' +
    '<td style="padding:7px 10px;border:1px solid ' + COLORES.BORDE + ';text-align:right;font-weight:bold;color:' + COLORES.VERDE + ';">$' + total.toFixed(2) + ' USD</td>' +
    '</tr>';

  const resumenViaje = data.esAnualMultiviaje
    ? filaResumen('Producto', 'Anual Multiviaje (cobertura anual, sin fechas fijas)')
    : filaResumen('Fechas del viaje', data.fechaInicio + ' al ' + data.fechaFin) +
      filaResumen('Días de cobertura', data.cantidadDias);

  return '' +
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:640px;">' +

      // Encabezado
      '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:' + COLORES.VERDE + ';border-collapse:collapse;">' +
        '<tr><td style="padding:14px 18px;">' +
          '<div style="font-size:17px;font-weight:bold;color:#ffffff;">Cotización Seguro de Viaje SENIOR +79</div>' +
          '<div style="font-size:11px;color:#cfe6da;margin-top:3px;">Seguros Atlas · Dirección de Negocios Especiales (DINE)</div>' +
        '</td></tr>' +
      '</table>' +

      '<div style="padding:18px;border:1px solid ' + COLORES.BORDE + ';border-top:none;">' +

        '<p style="margin:0 0 14px 0;">Estimado(a) cliente:</p>' +
        '<p style="margin:0 0 16px 0;">Adjunto encontrará la cotización correspondiente a su solicitud. A continuación el resumen de los datos considerados:</p>' +

        // Resumen general
        '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background-color:' + COLORES.VERDE_CLARO + ';margin-bottom:18px;">' +
          filaResumen('Folio', data.folio) +
          filaResumen('Destino', data.destino) +
          resumenViaje +
          filaResumen('Asegurados', String(data.numAsegurados) + ' — ' + data.listaAsegurados) +
          filaResumen('Vigencia de esta cotización', data.vigenciaCotizacion) +
        '</table>' +

        // Tabla comparativa de primas totales
        '<div style="font-size:15px;font-weight:bold;color:' + COLORES.VERDE + ';margin-bottom:6px;">Primas totales por plan</div>' +
        '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin-bottom:8px;">' +
          '<tr>' +
            '<th style="padding:7px 10px;border:1px solid ' + COLORES.BORDE + ';background-color:' + COLORES.VERDE + ';color:#ffffff;text-align:left;font-size:13px;">Plan</th>' +
            '<th style="padding:7px 10px;border:1px solid ' + COLORES.BORDE + ';background-color:' + COLORES.VERDE + ';color:#ffffff;text-align:right;font-size:13px;">Prima total</th>' +
          '</tr>' +
          filaPlan('Master', data.totalMaster) +
          filaPlan('Master Smart', data.totalSmart) +
          filaPlan('Master Elite', data.totalElite) +
          filaPlan('Master Premium', data.totalPremium) +
        '</table>' +
        '<p style="margin:0 0 18px 0;font-size:11px;color:#666;font-style:italic;">Importes en dólares americanos (USD) para ' + data.numAsegurados + ' asegurado(s). Primas netas, sin IVA ni derecho de póliza.</p>' +

        construirAvisoExcluidos_(data.pasajerosExcluidos) +

        // Llamado a revisar el PDF
        '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background-color:' + COLORES.VERDE_CLARO + ';border-left:4px solid ' + COLORES.VERDE + ';margin-bottom:18px;">' +
          '<tr><td style="padding:12px 14px;">' +
            '<strong style="color:' + COLORES.VERDE + ';">Revisión obligatoria del documento adjunto</strong><br>' +
            'El detalle completo de <strong>coberturas, sumas aseguradas, especificaciones y requisitos de emisión</strong> se encuentra únicamente en la cotización en PDF adjunta a este correo. Le solicitamos revisarla en su totalidad antes de aceptar cualquier plan.' +
          '</td></tr>' +
        '</table>' +

        '<p style="margin:0 0 6px 0;">Quedamos a sus órdenes para cualquier aclaración.</p>' +
        '<p style="margin:0;color:#666;font-size:12px;">Dirección de Negocios Especiales · Seguros Atlas</p>' +

      '</div>' +
    '</div>';
}

function construirCorreoRechazo_(data) {
  const motivo = data.estatus === CONFIG.ESTATUS.RECHAZADO_TIEMPO
    ? '<p style="margin:0 0 14px 0;">Su solicitud para el destino <strong>' + escaparHtml_(data.destino) + '</strong>, con fecha de inicio de viaje el <strong>' + escaparHtml_(data.fechaInicio) + '</strong>, ' +
      'no pudo ser procesada porque fue recibida con <strong>' + data.diasAnticipacion + ' día(s) de anticipación</strong>.</p>' +
      '<p style="margin:0 0 14px 0;">Por políticas de la <strong>Dirección de Negocios Especiales</strong>, las solicitudes de cotización deben realizarse con un mínimo de <strong>' + CONFIG.DIAS_ANTICIPACION_MINIMA + ' días naturales de anticipación</strong> al inicio del viaje.</p>' +
      '<p style="margin:0 0 14px 0;">Si las fechas de su viaje lo permiten, le invitamos a enviar nuevamente su solicitud respetando este plazo.</p>'
    : '<p style="margin:0 0 14px 0;">Su solicitud para el destino <strong>' + escaparHtml_(data.destino) + '</strong> no pudo ser procesada porque ' +
      '<strong>ninguno de los pasajeros indicados se encuentra dentro del rango de edad del Producto Senior</strong> (de ' + CONFIG.EDAD_MINIMA + ' a ' + CONFIG.EDAD_MAXIMA + ' años).</p>' +
      '<p style="margin:0 0 14px 0;">Para cotizar a estos pasajeros, favor de solicitar el <strong>producto de viaje estándar</strong>.</p>';

  return '' +
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:640px;">' +

      '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:' + COLORES.VERDE + ';border-collapse:collapse;">' +
        '<tr><td style="padding:14px 18px;">' +
          '<div style="font-size:17px;font-weight:bold;color:#ffffff;">Solicitud de cotización no procesada</div>' +
          '<div style="font-size:11px;color:#cfe6da;margin-top:3px;">Seguros Atlas · Dirección de Negocios Especiales (DINE)</div>' +
        '</td></tr>' +
      '</table>' +

      '<div style="padding:18px;border:1px solid ' + COLORES.BORDE + ';border-top:none;">' +

        '<p style="margin:0 0 14px 0;">Estimado(a) cliente:</p>' +

        '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background-color:' + COLORES.ROJO_FONDO + ';border-left:4px solid ' + COLORES.ROJO_BORDE + ';margin-bottom:18px;">' +
          '<tr><td style="padding:12px 14px;">' + motivo + '</td></tr>' +
        '</table>' +

        '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background-color:' + COLORES.VERDE_CLARO + ';margin-bottom:18px;">' +
          '<tr>' +
            '<td style="padding:5px 10px;font-weight:bold;color:' + COLORES.AZUL + ';width:42%;">Folio de la solicitud</td>' +
            '<td style="padding:5px 10px;color:#333;">' + escaparHtml_(data.folio) + '</td>' +
          '</tr>' +
        '</table>' +

        construirAvisoExcluidos_(data.pasajerosExcluidos) +

        '<p style="margin:0 0 6px 0;">Quedamos a sus órdenes para cualquier aclaración.</p>' +
        '<p style="margin:0;color:#666;font-size:12px;">Dirección de Negocios Especiales · Seguros Atlas</p>' +

      '</div>' +
    '</div>';
}

/**
 * Alerta de pasajeros fuera del rango 79-89. Devuelve cadena vacía si no
 * hubo exclusiones, para no dejar un bloque huérfano en el correo.
 */
function construirAvisoExcluidos_(pasajerosExcluidos) {
  if (!pasajerosExcluidos || pasajerosExcluidos.length === 0) return '';

  const nombres = pasajerosExcluidos
    .map((p) => escaparHtml_(p.nombre) + (p.edad !== null ? ' (' + p.edad + ' años)' : ''))
    .join(', ');

  return '' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background-color:' + COLORES.AMBAR_FONDO + ';border-left:4px solid ' + COLORES.AMBAR_BORDE + ';margin-bottom:18px;">' +
      '<tr><td style="padding:12px 14px;">' +
        '<strong style="color:#8a6d3b;">Aviso importante</strong><br>' +
        'El/los pasajero(s) <strong>' + nombres + '</strong> no fueron incluidos en esta cotización debido a que el Producto Senior aplica exclusivamente para personas de ' + CONFIG.EDAD_MINIMA + ' a ' + CONFIG.EDAD_MAXIMA + ' años. ' +
        'Para cotizar a pasajeros menores a este rango, favor de solicitar el producto de viaje estándar.' +
      '</td></tr>' +
    '</table>';
}

// ============================================================
// PUENTE HACIA POWER AUTOMATE
// ============================================================

/**
 * @param {File|null}   archivoHtml   Archivo en Drive; null si fue rechazada.
 * @param {Object}      data          Datos de la solicitud (incluye cuerpoCorreoHtml).
 * @param {string=}     htmlContenido HTML procesado; se envía en base64 como adjunto.
 */
function enviarWebhookPowerAutomate_(archivoHtml, data, htmlContenido) {
  const aprobado = data.estatus === CONFIG.ESTATUS.APROBADO;

  const payload = {
    // Destinatarios y encabezado del correo
    emailCliente: data.emailCliente,
    correoCC: data.correoCC,
    asunto: construirAsunto_(data),

    // Resultado de la validación
    estatus: data.estatus,

    // Cuerpo del correo ya renderizado: Power Automate solo lo emite.
    cuerpoCorreoHtml: data.cuerpoCorreoHtml,

    // Grupal si califica más de un asegurado (79-89 años), sin importar
    // lo que reporte la hoja de cálculo.
    tipoProducto: (data.numAsegurados > 1) ? 'Grupal' : 'Individual',

    // Adjunto: solo en solicitudes aprobadas. Apps Script no genera PDF
    // (ver nota del encabezado); manda el HTML en base64 y Power Automate
    // lo convierte con Word Online antes de adjuntarlo.
    htmlBase64: aprobado && htmlContenido ? Utilities.base64Encode(htmlContenido, Utilities.Charset.UTF_8) : '',
    nombreArchivo: aprobado ? data.nombreArchivo : '',

    // Auditoría
    folio: data.folio,
    htmlFileId: archivoHtml ? archivoHtml.getId() : '',
    fechaGeneracion: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX")
  };

  const respuesta = UrlFetchApp.fetch(getPropiedad_('WEBHOOK_POWER_AUTOMATE_URL'), {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (respuesta.getResponseCode() >= 300) {
    throw new Error('Power Automate respondió ' + respuesta.getResponseCode() + ': ' + respuesta.getContentText());
  }
}

// ============================================================
// PRUEBAS DE UN SOLO CLIC (sin depender del formulario ni de la hoja)
// ============================================================

/**
 * Caso aprobado: dos asegurados elegibles (Roberto García 82, María López 85)
 * más un pasajero excluido por edad (Ana Ruiz 65) para ver el aviso ámbar.
 * Viaje a 15 días -> cumple la anticipación mínima.
 */
function testearTodo() {
  Logger.log('=== INICIO testearTodo() — caso APROBADO ===');
  try {
    const data = construirDatosPrueba_({ diasHastaViaje: 15 });
    Logger.log('Estatus: ' + data.estatus + ' | anticipación: ' + data.diasAnticipacion + ' días');

    const htmlContenido = generarHtmlDesdeTokens_(data.tokens);
    const archivoHtml = guardarHtmlEnDrive_(htmlContenido, data.nombreArchivo);
    Logger.log('✅ HTML de cotización guardado en Drive.');
    Logger.log('URL: ' + archivoHtml.getUrl());
    Logger.log('fileId: ' + archivoHtml.getId());

    data.cuerpoCorreoHtml = construirCorreoAprobado_(data);
    Logger.log('Asunto: ' + construirAsunto_(data));
    Logger.log('Cuerpo del correo (' + data.cuerpoCorreoHtml.length + ' caracteres):');
    Logger.log(data.cuerpoCorreoHtml);

    enviarWebhookPowerAutomate_(archivoHtml, data, htmlContenido);
    Logger.log('✅ Webhook enviado a Power Automate sin errores.');
  } catch (error) {
    Logger.log('❌ Error en testearTodo(): ' + error.message);
  }
  Logger.log('=== FIN testearTodo() ===');
}

/**
 * Caso rechazado por anticipación: viaje que arranca en 2 días.
 * No debe generar cotización ni primas, solo el correo de rechazo.
 */
function testearRechazoPorTiempo() {
  Logger.log('=== INICIO testearRechazoPorTiempo() ===');
  try {
    const data = construirDatosPrueba_({ diasHastaViaje: 2 });
    Logger.log('Estatus: ' + data.estatus + ' | anticipación: ' + data.diasAnticipacion + ' días');
    Logger.log('Primas calculadas (deben ser 0): ' + data.totalMaster + ' / ' + data.totalPremium);

    data.cuerpoCorreoHtml = construirCorreoRechazo_(data);
    Logger.log('Asunto: ' + construirAsunto_(data));
    Logger.log(data.cuerpoCorreoHtml);

    enviarWebhookPowerAutomate_(null, data);
    Logger.log('✅ Webhook de rechazo enviado sin errores.');
  } catch (error) {
    Logger.log('❌ Error en testearRechazoPorTiempo(): ' + error.message);
  }
  Logger.log('=== FIN testearRechazoPorTiempo() ===');
}

/**
 * Arma un objeto `data` equivalente al de construirTokens_() sin tocar la
 * hoja, reutilizando la misma lógica de estatus, filtro y primas.
 */
function construirDatosPrueba_(opciones) {
  const hoy = new Date();
  const msPorDia = 24 * 60 * 60 * 1000;
  const inicioViaje = new Date(hoy.getTime() + opciones.diasHastaViaje * msPorDia);
  const finViaje = new Date(inicioViaje.getTime() + 10 * msPorDia);

  const encabezados = [
    'Destino', 'Correo de contacto', 'Correo CC', 'Producto',
    'Fecha de inicio del viaje', 'Fecha de fin del viaje',
    'Prima Master', 'Prima Master Smart', 'Prima Master Elite', 'Prima Master Premium',
    'Asegurado 1 Nombre', 'Asegurado 1 Edad',
    'Asegurado 2 Nombre', 'Asegurado 2 Edad',
    'Asegurado 3 Nombre', 'Asegurado 3 Edad'
  ];
  const valores = [
    'Brasil', 'prueba@example.com', 'contacto@example.com', 'Viaje sencillo',
    inicioViaje, finViaje,
    45.5, 65, 95, 125,
    'Roberto García', 82,
    'María López', 85,
    'Ana Ruiz', 65 // excluida por edad: dispara el aviso ámbar
  ];
  const obtenerValor = (nombre) => {
    const indice = encabezados.indexOf(nombre);
    if (indice === -1) throw new Error('Encabezado no encontrado: ' + nombre);
    return valores[indice];
  };

  return construirTokens_(99, encabezados, valores, obtenerValor);
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
  if (indiceEstado === -1) return;
  sheet.getRange(fila, indiceEstado + 1).setValue(mensaje + ' — ' + new Date());
}
