/**
 * Cotizador Seguro de Viaje SENIOR 79+ — Seguros Atlas (DINE)
 * VERSIÓN SIMPLIFICADA — sin html2pdf.app.
 *
 * html2pdf.app generaba PDFs en blanco con COTIZACION_SENIOR79_v6_FINAL.html
 * (CSS/tablas complejas). Nueva responsabilidad de Apps Script:
 *   1) Leer la fila del formulario.
 *   2) Sustituir los tokens {{...}} sobre la plantilla real (guardada en Drive).
 *   3) Guardar el HTML resultante en Drive con codificación UTF-8 explícita.
 *   4) Disparar el webhook a Power Automate, que convierte ese HTML a PDF
 *      con Word Online / OneDrive y lo distribuye por Outlook corporativo.
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
    const htmlContenido = generarHtmlDesdeTokens_(data.tokens);
    const archivoHtml = guardarHtmlEnDrive_(htmlContenido, data.nombreArchivo);

    enviarWebhookPowerAutomate_(archivoHtml, data);

    marcarEstadoFila_(sheet, fila, encabezados, 'HTML generado y enviado a Power Automate ✅');
  } catch (error) {
    Logger.log('Error en onFormSubmit (fila ' + fila + '): ' + error.message);
    marcarEstadoFila_(sheet, fila, encabezados, 'ERROR: ' + error.message);
    throw error;
  }
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

  // Filtro SENIOR: solo califican asegurados entre EDAD_MINIMA y EDAD_MAXIMA.
  const asegurados = [];
  for (let i = 1; i <= CONFIG.MAX_ASEGURADOS; i++) {
    const nombre = obtenerValorSeguro_(encabezados, valores, CONFIG.ASEGURADO_PREFIJO + i + ' Nombre');
    const edadNum = Number(obtenerValorSeguro_(encabezados, valores, CONFIG.ASEGURADO_PREFIJO + i + ' Edad'));
    if (!nombre || nombre.toString().trim() === '') continue;
    if (isNaN(edadNum) || edadNum < CONFIG.EDAD_MINIMA || edadNum > CONFIG.EDAD_MAXIMA) continue;
    asegurados.push({ nombre: nombre.toString().trim(), edad: edadNum });
  }
  const numAsegurados = asegurados.length;
  const listaAsegurados = asegurados.map((a) => a.nombre + ' (' + a.edad + ' años)').join(', ');

  // La plantilla espera "—" en fechas/días para Anual Multiviaje (no las oculta).
  let fechaInicio = '—';
  let fechaFin = '—';
  let cantidadDias = '—';
  if (!esAnualMultiviaje) {
    const inicio = obtenerValor(H.FECHA_INICIO);
    const fin = obtenerValor(H.FECHA_FIN);
    fechaInicio = formatearFecha_(inicio);
    fechaFin = formatearFecha_(fin);
    cantidadDias = String(calcularDias_(inicio, fin));
  }

  const primaMaster = Math.round((Number(obtenerValor(H.PRIMA_MASTER)) || 0) * 100) / 100;
  const primaSmart = Math.round((Number(obtenerValor(H.PRIMA_SMART)) || 0) * 100) / 100;
  const primaElite = Math.round((Number(obtenerValor(H.PRIMA_ELITE)) || 0) * 100) / 100;
  const primaPremium = Math.round((Number(obtenerValor(H.PRIMA_PREMIUM)) || 0) * 100) / 100;

  const folio = 'COT-' + fila + '-' + Utilities.formatDate(hoy, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const destino = obtenerValor(H.DESTINO);

  return {
    folio: folio,
    destino: destino,
    emailCliente: obtenerValor(H.EMAIL_CLIENTE),
    correoCC: obtenerValor(H.CORREO_CC),
    fechaInicio: fechaInicio,
    fechaFin: fechaFin,
    cantidadDias: cantidadDias,
    vigenciaCotizacion: vigenciaCotizacion,
    numAsegurados: numAsegurados,
    listaAsegurados: listaAsegurados,
    primaMaster: primaMaster,
    primaSmart: primaSmart,
    primaElite: primaElite,
    primaPremium: primaPremium,
    nombreArchivo: 'Cotizacion_' + folio + '.html',
    tokens: {
      FOLIO: folio,
      FECHA_COTIZACION: Utilities.formatDate(hoy, Session.getScriptTimeZone(), "dd 'de' MMMM 'de' yyyy"),
      VIGENCIA: vigenciaCotizacion,
      ASEGURADO_1: asegurados[0] ? asegurados[0].nombre + ', ' + asegurados[0].edad + ' años' : '',
      ASEGURADO_2: asegurados[1] ? asegurados[1].nombre + ', ' + asegurados[1].edad + ' años' : '',
      ASEGURADO_3: asegurados[2] ? asegurados[2].nombre + ', ' + asegurados[2].edad + ' años' : '',
      ASEGURADO_4: asegurados[3] ? asegurados[3].nombre + ', ' + asegurados[3].edad + ' años' : '',
      ASEGURADO_5: asegurados[4] ? asegurados[4].nombre + ', ' + asegurados[4].edad + ' años' : '',
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
// PUENTE HACIA POWER AUTOMATE
// ============================================================

function enviarWebhookPowerAutomate_(archivoHtml, data) {
  const payload = {
    // Metadatos y PDF
    htmlFileId: archivoHtml.getId(),
    htmlFileUrl: archivoHtml.getUrl(),
    nombreArchivo: data.nombreArchivo,
    folio: data.folio,
    emailCliente: data.emailCliente,
    correoCC: data.correoCC,

    // Datos del viaje
    destino: data.destino,
    fechaInicio: data.fechaInicio,
    fechaFin: data.fechaFin,
    cantidadDias: data.cantidadDias,
    vigenciaCotizacion: data.vigenciaCotizacion,
    numAsegurados: data.numAsegurados,
    listaAsegurados: data.listaAsegurados,

    // Regla dinámica: Grupal si califica más de un asegurado (79-89 años),
    // sin importar lo que reporte la hoja de cálculo.
    tipoProducto: (data.numAsegurados > 1) ? 'Grupal' : 'Individual',

    // Primas por plan
    primaMaster: data.primaMaster,
    primaSmart: data.primaSmart,
    primaElite: data.primaElite,
    primaPremium: data.primaPremium,

    // Auditoría
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
// PRUEBA DE UN SOLO CLIC (sin depender del formulario ni de la hoja)
// ============================================================

/**
 * Ejecutar directamente desde el editor (▶) para validar de punta a punta:
 * generación del HTML, guardado en Drive y envío del webhook, con datos
 * MOCK ya filtrados (Roberto García, 82 años, y María López, 85 años —
 * Brasil). El filtro de edad 79-89 vive en construirTokens_, que esta
 * prueba no ejercita porque no lee la hoja; aquí se valida el resto del
 * flujo con dos asegurados ya calificados para confirmar tipoProducto=Grupal.
 */
function testearTodo() {
  Logger.log('=== INICIO testearTodo() ===');
  try {
    const hoy = new Date();
    const vigencia = new Date(hoy.getTime());
    vigencia.setDate(vigencia.getDate() + CONFIG.VIGENCIA_DIAS);
    const folio = 'COT-TEST-' + Utilities.formatDate(hoy, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');

    const fechaInicio = new Date(hoy.getTime() + 15 * 24 * 60 * 60 * 1000);
    const fechaFin = new Date(hoy.getTime() + 25 * 24 * 60 * 60 * 1000);
    const asegurados = [
      { nombre: 'Roberto García', edad: 82 },
      { nombre: 'María López', edad: 85 }
    ];
    const numAsegurados = asegurados.length;
    const listaAsegurados = asegurados.map((a) => a.nombre + ' (' + a.edad + ' años)').join(', ');
    const primaMaster = 45.5;
    const primaSmart = 65;
    const primaElite = 95;
    const primaPremium = 125;

    const datosPrueba = {
      folio: folio,
      destino: 'Brasil',
      emailCliente: 'prueba@example.com',
      correoCC: 'contacto@example.com',
      fechaInicio: formatearFecha_(fechaInicio),
      fechaFin: formatearFecha_(fechaFin),
      cantidadDias: String(calcularDias_(fechaInicio, fechaFin)),
      vigenciaCotizacion: Utilities.formatDate(vigencia, Session.getScriptTimeZone(), "dd 'de' MMMM 'de' yyyy"),
      numAsegurados: numAsegurados,
      listaAsegurados: listaAsegurados,
      primaMaster: primaMaster,
      primaSmart: primaSmart,
      primaElite: primaElite,
      primaPremium: primaPremium,
      nombreArchivo: 'Cotizacion_' + folio + '.html',
      tokens: {
        FOLIO: folio,
        FECHA_COTIZACION: Utilities.formatDate(hoy, Session.getScriptTimeZone(), "dd 'de' MMMM 'de' yyyy"),
        VIGENCIA: Utilities.formatDate(vigencia, Session.getScriptTimeZone(), "dd 'de' MMMM 'de' yyyy"),
        ASEGURADO_1: asegurados[0].nombre + ', ' + asegurados[0].edad + ' años',
        ASEGURADO_2: asegurados[1].nombre + ', ' + asegurados[1].edad + ' años',
        ASEGURADO_3: '',
        ASEGURADO_4: '',
        ASEGURADO_5: '',
        NUM_ASEGURADOS: String(numAsegurados),
        DESTINO: 'Brasil',
        FECHA_INICIO: formatearFecha_(fechaInicio),
        FECHA_FIN: formatearFecha_(fechaFin),
        CANTIDAD_DIAS: String(calcularDias_(fechaInicio, fechaFin)),
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

    const htmlContenido = generarHtmlDesdeTokens_(datosPrueba.tokens);
    const archivoHtml = guardarHtmlEnDrive_(htmlContenido, datosPrueba.nombreArchivo);
    Logger.log('✅ HTML generado y guardado en Drive.');
    Logger.log('URL: ' + archivoHtml.getUrl());
    Logger.log('fileId: ' + archivoHtml.getId());

    enviarWebhookPowerAutomate_(archivoHtml, datosPrueba);
    Logger.log('✅ Webhook enviado a Power Automate sin errores.');
  } catch (error) {
    Logger.log('❌ Error en testearTodo(): ' + error.message);
  }
  Logger.log('=== FIN testearTodo() ===');
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
