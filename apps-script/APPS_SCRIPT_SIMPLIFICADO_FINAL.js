/**
 * ============================================================================
 * COTIZADOR SEGURO DE VIAJE SENIOR +79 — Seguros Atlas (DINE)
 * ============================================================================
 * Apps Script concentra TODA la regla de negocio y el armado de documentos.
 * Power Automate queda como emisor: recibe el cuerpo del correo ya renderizado
 * y el HTML de la cotización listo para convertir a PDF.
 *
 * FLUJO
 *   1) Trigger "Al enviar el formulario" -> se lee la fila exacta.
 *   2) Se filtran los asegurados elegibles (79-89 años, edad leída directo
 *      de su columna en el Sheet) y se registran los excluidos.
 *   3) Se valida la anticipación mínima (5 días naturales).
 *   4) Si procede, se genera el HTML de la cotización (1 página, tamaño carta)
 *      y se guarda en Drive con codificación UTF-8 explícita.
 *   5) Se construye el cuerpo HTML del correo (aprobación o rechazo).
 *   6) Se dispara el webhook a Power Automate.
 *
 * ESTATUS POSIBLES
 *   APROBADO                 Hay al menos un elegible y se cumple la anticipación.
 *   RECHAZADO_TIEMPO         Menos de 5 días naturales antes de la salida.
 *   RECHAZADO_SIN_ELEGIBLES  Ningún pasajero cae en el rango 79-89.
 *
 * SOBRE EL ADJUNTO: Apps Script no produce el PDF (por eso se descartó
 * html2pdf.app). Manda `htmlBase64` con el HTML ya renderizado; Power Automate
 * hace base64ToBinary() -> Create file -> Convert file (Word Online) -> PDF.
 *
 * DEPENDENCIA: ASSETS_BASE64.gs (logos y código QR incrustados en base64).
 * ============================================================================
 */

// ============================================================================
// 1. CONFIGURACIÓN
// ============================================================================

/**
 * Ejecutar UNA SOLA VEZ desde el editor de Apps Script.
 * Los valores sensibles viven en Script Properties, nunca en el código fuente:
 * la URL del webhook lleva su firma de acceso en el query string.
 */
function configurarPropiedades() {
  PropertiesService.getScriptProperties().setProperties({
    CARPETA_SALIDA_ID: 'ID_CARPETA_DRIVE_DONDE_SE_GUARDA_EL_HTML_GENERADO',
    WEBHOOK_POWER_AUTOMATE_URL: 'URL_DEL_TRIGGER_HTTP_DE_POWER_AUTOMATE'
  });
}

const CONFIG = {
  // --- Reglas de negocio ---
  EDAD_MINIMA: 79,
  EDAD_MAXIMA: 89,
  DIAS_ANTICIPACION_MINIMA: 5,
  VIGENCIA_DIAS: 7,
  MAX_ASEGURADOS: 10,

  ESTATUS: {
    APROBADO: 'APROBADO',
    RECHAZADO_TIEMPO: 'RECHAZADO_TIEMPO',
    RECHAZADO_SIN_ELEGIBLES: 'RECHAZADO_SIN_ELEGIBLES'
  },

  // --- Mapeo de columnas (fila 1 de la hoja de respuestas) ---
  COL_PERFIL: 'Perfil',
  COL_AGENTE_INFO: 'Escribe tu clave y Nombre de Agente',
  COL_NOMBRE_SOLICITANTE: 'Nombre completo de quien solicita',
  COL_EMAIL_CLIENTE: 'Correo electrónico de quien solicita',
  COL_CORREO_CC: 'Quieres enviar tu propuesta a algún otro correo?',
  COL_DESTINO: 'Destino',
  COL_FECHA_INICIO: 'Fecha de Salida',
  COL_FECHA_FIN: 'Fecha de Regreso',

  // Columnas de primas por asegurado. No hay tabla tarifaria en el script:
  // las primas se leen de la hoja, que ya las calcula.
  COL_PRIMA_MASTER: 'Prima Master',
  COL_PRIMA_SMART: 'Prima Master Smart',
  COL_PRIMA_ELITE: 'Prima Master Elite',
  COL_PRIMA_PREMIUM: 'Prima Master Premium',

  // Columna opcional de trazabilidad. Si no existe en la hoja, se ignora.
  COL_ESTADO: 'Estado de envío',

  /**
   * Resolución de las columnas de cada asegurado.
   *
   * Los nombres siguen el patrón 'Nombre Asegurado N'. Las edades YA VIENEN
   * CALCULADAS en su propia columna: el script solo lee el entero, nunca lo
   * deriva de una fecha de nacimiento.
   *
   * Como el encabezado exacto de las edades puede variar, se prueban varios
   * patrones en orden. Si ninguno coincide, usa OVERRIDE_EDAD para fijar el
   * encabezado literal por índice. Ejecuta listarEncabezados() para ver los
   * nombres reales de tu hoja.
   */
  ASEGURADOS: {
    PATRONES_NOMBRE: [
      'Nombre Asegurado {i}',
      'Nombre asegurado {i}',
      'Asegurado {i} Nombre'
    ],
    PATRONES_EDAD: [
      'Edad Asegurado {i}',
      'Edad asegurado {i}',
      'EDAD ASEGURADO {i}',
      'Edad {i}',
      'Asegurado {i} Edad',
      'Nombre Asegurado {i} Edad'
    ],
    // Ejemplo: { 1: 'Edad calculada 1', 2: 'Edad calculada 2' }
    OVERRIDE_NOMBRE: {},
    OVERRIDE_EDAD: {}
  }
};

// Paleta corporativa, compartida por la cotización y el correo.
const COLORES = {
  VERDE: '#0d5e3a',
  VERDE_CLARO: '#eef4f1',
  VERDE_BORDE: '#bcd5c9',
  AZUL: '#0f2b48',
  BORDE: '#cbd5e1',
  GRIS_FILA: '#eaecee',
  GRIS_TABLA: '#f4f5f7',
  TOTAL_FONDO: '#d1e7dd',
  AMBAR_FONDO: '#fff8e1',
  AMBAR_BORDE: '#f0ad4e',
  AMBAR_TEXTO: '#8a6d3b',
  ROJO_FONDO: '#fdecea',
  ROJO_BORDE: '#d9534f'
};

/**
 * Tabla de coberturas y sumas aseguradas.
 * Orden de columnas: [concepto, Master, Master Smart, Master Elite, Master Premium].
 * `nota` se imprime como segunda línea en letra más chica dentro de cada celda.
 */
const COBERTURAS = [
  { concepto: 'I. Cancelación de Viaje', valores: ['2,000', '2,500', '5,000', '7,500'] },
  { concepto: 'II. Interrupción de Viaje', valores: ['2,000', '2,500', '5,000', '7,500'] },
  { concepto: 'III. Equipaje', valores: ['1,400', '1,500', '3,000', '4,500'] },
  { concepto: 'Pérdida o Daño de Equipaje', valores: ['1,000', '1,000', '2,000', '3,000'] },
  { concepto: 'Demora de Equipaje', valores: ['400', '500', '1,000', '1,500'] },
  { concepto: 'V. Gastos Médicos por Accidente o Enfermedad', valores: ['30,000', '50,000', '100,000', '150,000'] },
  { concepto: 'Medicamentos Recetados y Vendajes', valores: ['1,000', '2,000', '3,000', '3,500'] },
  { concepto: 'Aparatos de Ayuda', valores: ['1,000', '2,000', '3,000', '3,500'] },
  { concepto: 'Traslado Médico', valores: ['Incluido', 'Incluido', 'Incluido', 'Incluido'] },
  { concepto: 'Atención Odontológica', valores: ['1,000', '2,000', '3,000', '3,500'] },
  {
    concepto: 'Traslado y Estancia de un Acompañante',
    valores: ['7 días', '7 días', '10 días', '10 días'],
    nota: ['200 USD diarios', '200 USD diarios', '200 USD diarios', '200 USD diarios']
  },
  {
    concepto: 'Traslado y Acompañamiento de Menores',
    valores: ['Incluido', 'Incluido', 'Incluido', 'Incluido'],
    nota: ['hasta 10,000', '', '', '']
  },
  {
    concepto: 'Gastos de Hotel por Convalecencia',
    valores: ['10 días', '10 días', '10 días', '10 días'],
    nota: ['200 USD diarios', '200 USD diarios', '200 USD diarios', '200 USD diarios']
  },
  { concepto: 'Repatriación y/o Servicios por Muerte Accidental', valores: ['30,000', '50,000', '100,000', '150,000'] },
  { concepto: 'Repatriación o Evacuación Médica', valores: ['30,000', '50,000', '100,000', '150,000'] },
  { concepto: 'Asistencia Médica por Enfermedad Preexistente', valores: ['—', '—', '500', '500'] },
  { concepto: 'VII. Demora de Viaje', valores: ['500', '1,000', '2,000', '2,500'] },
  { concepto: 'VIII. Responsabilidad Civil', valores: ['30,000', '50,000', '100,000', '100,000'] },
  { concepto: 'Transferencia de Fondos', valores: ['500', '500', '500', '1,000'] },
  { concepto: 'Asistencia Legal por Accidente de Tránsito', valores: ['1,500', '2,500', '2,500', '5,500'] },
  { concepto: 'Orientación Telefónica', valores: ['Incluido', 'Incluido', 'Incluido', 'Incluido'] },
  { concepto: 'Transmisión de Mensajes Urgentes', valores: ['Incluido', 'Incluido', 'Incluido', 'Incluido'] },
  { concepto: 'Gastos de Búsqueda y Salvamento', valores: ['5,000', '5,000', '5,000', '10,000'] }
];

const PLANES = ['Master', 'Master Smart', 'Master Elite', 'Master Premium'];

// ============================================================================
// 2. TRIGGER PRINCIPAL
// ============================================================================

/**
 * Trigger instalable "Al enviar el formulario".
 * Usa e.range.getRow() y no getLastRow(): si dos personas cotizan casi al
 * mismo tiempo, getLastRow() puede devolver la fila equivocada.
 */
function onFormSubmit(e) {
  const sheet = e.range.getSheet();
  const fila = e.range.getRow();
  const encabezados = leerEncabezados_(sheet);

  try {
    const valores = sheet.getRange(fila, 1, 1, sheet.getLastColumn()).getValues()[0];
    const data = construirDatosSolicitud_(fila, encabezados, valores);
    procesarSolicitud_(data);
    marcarEstadoFila_(sheet, fila, encabezados, data.estatus + ' — enviado a Power Automate');
  } catch (error) {
    Logger.log('Error en onFormSubmit (fila ' + fila + '): ' + error.message);
    marcarEstadoFila_(sheet, fila, encabezados, 'ERROR: ' + error.message);
    throw error;
  }
}

/**
 * Bifurca según el estatus. Las solicitudes rechazadas no generan cotización
 * ni adjunto: solo el correo formal con el motivo.
 */
function procesarSolicitud_(data) {
  if (data.estatus !== CONFIG.ESTATUS.APROBADO) {
    data.cuerpoCorreoHtml = construirCorreoRechazo_(data);
    enviarWebhookPowerAutomate_(null, data, '');
    return;
  }

  const htmlCotizacion = generarHtmlCotizacion_(data);
  const archivoHtml = guardarHtmlEnDrive_(htmlCotizacion, data.nombreArchivo);
  data.cuerpoCorreoHtml = construirCorreoAprobado_(data);
  enviarWebhookPowerAutomate_(archivoHtml, data, htmlCotizacion);
}

// ============================================================================
// 3. LECTURA DE LA HOJA Y REGLAS DE NEGOCIO
// ============================================================================

function leerEncabezados_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map((h) => h.toString().trim());
}

/**
 * Diagnóstico: imprime todos los encabezados de la hoja con su letra de
 * columna. Úsalo para llenar CONFIG cuando un encabezado no coincida.
 */
function listarEncabezados() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const encabezados = leerEncabezados_(sheet);
  Logger.log('=== ENCABEZADOS DE "' + sheet.getName() + '" ===');
  encabezados.forEach((h, i) => Logger.log(letraColumna_(i + 1) + ' (' + (i + 1) + '): "' + h + '"'));
  Logger.log('=== TOTAL: ' + encabezados.length + ' columnas ===');
}

function letraColumna_(indice) {
  let letra = '';
  let n = indice;
  while (n > 0) {
    const resto = (n - 1) % 26;
    letra = String.fromCharCode(65 + resto) + letra;
    n = Math.floor((n - resto) / 26);
  }
  return letra;
}

function indiceDe_(encabezados, nombre) {
  return encabezados.indexOf(nombre.toString().trim());
}

/** Devuelve el valor de una columna obligatoria; falla si no existe. */
function valorObligatorio_(encabezados, valores, nombre) {
  const indice = indiceDe_(encabezados, nombre);
  if (indice === -1) {
    throw new Error('Encabezado no encontrado: "' + nombre + '". Ejecuta listarEncabezados() y ajusta CONFIG.');
  }
  return valores[indice];
}

/** Devuelve el valor de una columna opcional, o '' si la columna no existe. */
function valorOpcional_(encabezados, valores, nombre) {
  const indice = indiceDe_(encabezados, nombre);
  return indice === -1 ? '' : valores[indice];
}

/**
 * Busca el valor de una columna probando varios patrones con {i} sustituido,
 * más un override explícito por índice. Devuelve null si no encuentra ninguna.
 */
function valorPorPatron_(encabezados, valores, patrones, override, i) {
  if (override && override[i]) {
    const indiceFijo = indiceDe_(encabezados, override[i]);
    if (indiceFijo !== -1) return valores[indiceFijo];
  }
  for (let p = 0; p < patrones.length; p++) {
    const indice = indiceDe_(encabezados, patrones[p].replace('{i}', String(i)));
    if (indice !== -1) return valores[indice];
  }
  return null;
}

/**
 * Construye el objeto de datos completo de una solicitud: filtra asegurados,
 * evalúa las reglas y deja todo listo para renderizar documentos.
 */
function construirDatosSolicitud_(fila, encabezados, valores) {
  const hoy = new Date();
  const tz = Session.getScriptTimeZone();

  // --- Filtro de edad: solo 79-89 años inclusive ---
  const asegurados = [];
  const pasajerosExcluidos = [];
  for (let i = 1; i <= CONFIG.MAX_ASEGURADOS; i++) {
    const nombreCrudo = valorPorPatron_(
      encabezados, valores, CONFIG.ASEGURADOS.PATRONES_NOMBRE, CONFIG.ASEGURADOS.OVERRIDE_NOMBRE, i);
    if (nombreCrudo === null || nombreCrudo.toString().trim() === '') continue;

    const nombre = nombreCrudo.toString().trim();
    const edadCruda = valorPorPatron_(
      encabezados, valores, CONFIG.ASEGURADOS.PATRONES_EDAD, CONFIG.ASEGURADOS.OVERRIDE_EDAD, i);
    const edadNum = parseInt(edadCruda, 10); // la edad ya viene calculada en la hoja

    if (isNaN(edadNum) || edadNum < CONFIG.EDAD_MINIMA || edadNum > CONFIG.EDAD_MAXIMA) {
      pasajerosExcluidos.push({ nombre: nombre, edad: isNaN(edadNum) ? null : edadNum });
      continue;
    }
    asegurados.push({ nombre: nombre, edad: edadNum });
  }
  const numAsegurados = asegurados.length;

  // --- Fechas del viaje ---
  const inicioRaw = valorObligatorio_(encabezados, valores, CONFIG.COL_FECHA_INICIO);
  const finRaw = valorObligatorio_(encabezados, valores, CONFIG.COL_FECHA_FIN);
  const duracionDias = calcularDuracionViaje_(inicioRaw, finRaw);
  const diasAnticipacion = calcularDiasAnticipacion_(hoy, inicioRaw);

  const vigenciaDate = new Date(hoy.getTime());
  vigenciaDate.setDate(vigenciaDate.getDate() + CONFIG.VIGENCIA_DIAS);

  // --- Estatus ---
  // La anticipación se evalúa primero: si el viaje ya no cumple el plazo,
  // no tiene sentido informar además sobre elegibilidad de pasajeros.
  let estatus = CONFIG.ESTATUS.APROBADO;
  if (diasAnticipacion !== null && diasAnticipacion < CONFIG.DIAS_ANTICIPACION_MINIMA) {
    estatus = CONFIG.ESTATUS.RECHAZADO_TIEMPO;
  } else if (numAsegurados === 0) {
    estatus = CONFIG.ESTATUS.RECHAZADO_SIN_ELEGIBLES;
  }
  const aprobado = estatus === CONFIG.ESTATUS.APROBADO;

  // --- Primas: solo se calculan si la solicitud procede ---
  const primaMaster = aprobado ? leerPrima_(valorOpcional_(encabezados, valores, CONFIG.COL_PRIMA_MASTER)) : 0;
  const primaSmart = aprobado ? leerPrima_(valorOpcional_(encabezados, valores, CONFIG.COL_PRIMA_SMART)) : 0;
  const primaElite = aprobado ? leerPrima_(valorOpcional_(encabezados, valores, CONFIG.COL_PRIMA_ELITE)) : 0;
  const primaPremium = aprobado ? leerPrima_(valorOpcional_(encabezados, valores, CONFIG.COL_PRIMA_PREMIUM)) : 0;

  // --- Datos del agente ---
  const perfil = valorOpcional_(encabezados, valores, CONFIG.COL_PERFIL).toString().trim();
  const agenteInfo = valorOpcional_(encabezados, valores, CONFIG.COL_AGENTE_INFO).toString().trim();
  const mostrarAgente = perfil === 'Soy Agente' ||
    (agenteInfo !== '' && agenteInfo.toUpperCase() !== 'NA');

  const folio = 'COT-' + fila + '-' + Utilities.formatDate(hoy, tz, 'yyyyMMdd-HHmmss');

  return {
    folio: folio,
    estatus: estatus,
    fila: fila,

    perfil: perfil,
    agenteInfo: agenteInfo,
    mostrarAgente: mostrarAgente,
    nombreSolicitante: valorObligatorio_(encabezados, valores, CONFIG.COL_NOMBRE_SOLICITANTE),
    emailCliente: valorObligatorio_(encabezados, valores, CONFIG.COL_EMAIL_CLIENTE),
    correoCC: normalizarCC_(valorOpcional_(encabezados, valores, CONFIG.COL_CORREO_CC)),

    destino: valorObligatorio_(encabezados, valores, CONFIG.COL_DESTINO),
    fechaInicio: formatearFecha_(inicioRaw),
    fechaFin: formatearFecha_(finRaw),
    duracionDias: duracionDias,
    diasAnticipacion: diasAnticipacion,
    fechaEmision: Utilities.formatDate(hoy, tz, 'dd/MM/yyyy HH:mm:ss'),
    vigenciaCotizacion: Utilities.formatDate(vigenciaDate, tz, 'dd/MM/yyyy'),

    asegurados: asegurados,
    numAsegurados: numAsegurados,
    listaAsegurados: asegurados.map((a) => a.nombre + ' (' + a.edad + ' años)').join(', '),
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
    cuerpoCorreoHtml: ''
  };
}

/**
 * Días naturales entre hoy y la fecha de salida.
 * Ambas fechas se normalizan a medianoche para que la hora de envío del
 * formulario no altere la cuenta: un viaje que sale en 5 días cumple el
 * plazo tanto si el formulario se envía a las 08:00 como a las 23:00.
 * Devuelve null si no hay fecha de salida válida.
 */
function calcularDiasAnticipacion_(hoy, fechaSalida) {
  if (!fechaSalida) return null;
  const salida = fechaSalida instanceof Date ? fechaSalida : new Date(fechaSalida);
  if (isNaN(salida.getTime())) return null;

  const hoyMedianoche = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  const salidaMedianoche = new Date(salida.getFullYear(), salida.getMonth(), salida.getDate());
  return Math.round((salidaMedianoche - hoyMedianoche) / (24 * 60 * 60 * 1000));
}

/** Duración del viaje en días, contando inicio y fin (inclusive). */
function calcularDuracionViaje_(inicio, fin) {
  if (!inicio || !fin) return 0;
  const fechaInicio = inicio instanceof Date ? inicio : new Date(inicio);
  const fechaFin = fin instanceof Date ? fin : new Date(fin);
  if (isNaN(fechaInicio.getTime()) || isNaN(fechaFin.getTime())) return 0;

  const a = new Date(fechaInicio.getFullYear(), fechaInicio.getMonth(), fechaInicio.getDate());
  const b = new Date(fechaFin.getFullYear(), fechaFin.getMonth(), fechaFin.getDate());
  const dias = Math.round((b - a) / (24 * 60 * 60 * 1000)) + 1;
  return dias > 0 ? dias : 0;
}

function formatearFecha_(valor) {
  if (!valor) return '—';
  const fecha = valor instanceof Date ? valor : new Date(valor);
  if (isNaN(fecha.getTime())) return '—';
  return Utilities.formatDate(fecha, Session.getScriptTimeZone(), 'dd/MM/yyyy');
}

/** El formulario admite "NA"/"No" cuando no se quiere copia a otro correo. */
function normalizarCC_(valor) {
  const texto = valor.toString().trim();
  if (texto === '' || texto.toUpperCase() === 'NA' || texto.toLowerCase() === 'no') return '';
  return texto;
}

function leerPrima_(valor) {
  const numero = Number(String(valor).replace(/[$,\s]/g, ''));
  return redondear_(isNaN(numero) ? 0 : numero);
}

function redondear_(numero) {
  return Math.round(numero * 100) / 100;
}

function formatearMoneda_(numero) {
  return '$' + numero.toFixed(2);
}

function escaparHtml_(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// 4. HTML DE LA COTIZACIÓN (1 PÁGINA, TAMAÑO CARTA)
// ============================================================================

/**
 * Maquetación pensada para que Word Online la convierta a una sola página
 * carta: solo tablas (sin flex ni grid), anchos con <colgroup>, tipografía
 * compacta y CSS incrustado. Las imágenes van como data: URI porque el
 * convertidor no descarga recursos externos.
 */
function generarHtmlCotizacion_(data) {
  return '<!DOCTYPE html>\n' +
    '<html lang="es">\n<head>\n<meta charset="UTF-8">\n' +
    '<title>Cotización ' + escaparHtml_(data.folio) + '</title>\n' +
    '<style>\n' + estilosCotizacion_() + '</style>\n</head>\n<body>\n' +
    '<div class="hoja">\n' +
      bloqueEncabezado_(data) +
      bloqueInfoViaje_(data) +
      bloquePlanes_(data) +
      bloqueEspecificaciones_() +
      bloqueAccionOperativa_() +
      bloqueObservaciones_(data) +
      '<div class="paginacion">Página 1 de 1</div>\n' +
    '</div>\n</body>\n</html>';
}

function estilosCotizacion_() {
  return '' +
    '@page { size: letter; margin: 0.5cm; }\n' +
    '* { box-sizing: border-box; margin: 0; padding: 0; }\n' +
    'body { font-family: Arial, Helvetica, sans-serif; font-size: 8px; color: #111; line-height: 1.25;\n' +
    '       -webkit-print-color-adjust: exact; print-color-adjust: exact; }\n' +
    '.hoja { width: 100%; }\n' +
    'table { border-collapse: collapse; width: 100%; }\n' +

    // Encabezado
    '.enc { background-color: ' + COLORES.VERDE + '; color: #ffffff; }\n' +
    '.enc td { padding: 6px 10px; vertical-align: middle; }\n' +
    '.enc .titulo { font-size: 12.5px; font-weight: bold; letter-spacing: .3px; }\n' +
    '.enc .sub { font-size: 7px; color: #cfe6da; margin-top: 1px; }\n' +
    '.enc .dato { font-size: 7.5px; color: #ffffff; }\n' +
    '.enc .dato strong { color: #ffffff; }\n' +
    '.enc-der { text-align: right; width: 42%; }\n' +
    '.enc-logo { max-height: 26px; width: auto; margin-bottom: 3px; }\n' +

    // Bloques genéricos
    '.banner { background-color: ' + COLORES.VERDE + '; color: #ffffff; font-weight: bold;\n' +
    '          font-size: 8.5px; text-transform: uppercase; padding: 3px 8px; margin: 5px 0 3px; letter-spacing: .3px; }\n' +

    // Información del viaje
    '.viaje { background-color: ' + COLORES.VERDE_CLARO + '; border: 1px solid ' + COLORES.VERDE_BORDE + '; }\n' +
    '.viaje td { padding: 3px 8px; font-size: 8px; vertical-align: top; }\n' +
    '.viaje .et { font-weight: bold; color: ' + COLORES.AZUL + '; }\n' +
    '.viaje .aseg { border-top: 1px dashed ' + COLORES.VERDE_BORDE + '; }\n' +

    // Tabla de coberturas
    '.cob { font-size: 7px; background-color: ' + COLORES.GRIS_TABLA + '; }\n' +
    '.cob th, .cob td { border: 1px solid #b0b0b0; padding: 1.2px 4px; text-align: left; }\n' +
    '.cob th { background-color: ' + COLORES.VERDE + '; color: #ffffff; font-weight: bold;\n' +
    '          text-align: center; font-size: 7px; text-transform: uppercase; }\n' +
    '.cob td.num { text-align: center; }\n' +
    '.cob tr.par { background-color: ' + COLORES.GRIS_FILA + '; }\n' +
    '.cob .subnota { display: block; color: #444; font-size: 6.2px; }\n' +
    '.cob tr.unit td { font-size: 7px; color: ' + COLORES.AZUL + '; background-color: #f0f6f3; }\n' +
    '.cob tr.total td { background-color: ' + COLORES.TOTAL_FONDO + '; font-weight: bold;\n' +
    '                   border-top: 2px solid ' + COLORES.VERDE + '; font-size: 8px; color: ' + COLORES.VERDE + '; }\n' +

    // Especificaciones
    '.espec { border: 1px solid ' + COLORES.VERDE_BORDE + '; background-color: #ffffff; }\n' +
    '.espec td { padding: 4px 8px; font-size: 7.2px; line-height: 1.3; }\n' +
    '.espec strong { color: ' + COLORES.VERDE + '; }\n' +

    // Recuadros operativos
    '.ops td { vertical-align: top; padding: 0 4px 0 0; }\n' +
    '.ops td.ultima { padding-right: 0; }\n' +
    '.caja { border: 1px solid ' + COLORES.BORDE + '; padding: 5px 7px; height: 100%; }\n' +
    '.caja h3 { font-size: 7.8px; color: ' + COLORES.AZUL + '; margin-bottom: 2px; }\n' +
    '.caja p, .caja li { font-size: 6.9px; line-height: 1.3; }\n' +
    '.caja ul { list-style: none; margin-top: 2px; }\n' +
    '.qr-caja { text-align: center; }\n' +
    '.qr-caja img { width: 62px; height: 62px; display: block; margin: 0 auto 2px; }\n' +

    // Observaciones y pie
    '.obs { border-top: 1px solid ' + COLORES.BORDE + '; margin-top: 4px; padding-top: 3px; }\n' +
    '.obs h3 { font-size: 7.5px; color: ' + COLORES.VERDE + '; text-transform: uppercase; margin-bottom: 2px; }\n' +
    '.obs p { font-size: 6.3px; line-height: 1.3; color: #333; text-align: justify; margin-bottom: 1.5px; }\n' +
    '.pie-logo { text-align: right; margin-top: 2px; }\n' +
    '.pie-logo img { max-width: 105px; height: auto; }\n' +
    '.paginacion { text-align: right; font-size: 6.5px; color: #666; margin-top: 2px; }\n';
}

function bloqueEncabezado_(data) {
  const agente = data.mostrarAgente
    ? '<div class="dato"><strong>Agente:</strong> ' + escaparHtml_(data.agenteInfo) + '</div>'
    : '';

  return '<table class="enc" role="presentation">\n<tr>\n' +
    '<td>' +
      '<div class="titulo">COTIZACIÓN SENIOR +79 AÑOS</div>' +
      '<div class="sub">Seguro de Viaje · Dirección de Negocios Especiales (DINE)</div>' +
      '<div class="dato" style="margin-top:4px;"><strong>No. Cotización:</strong> ' + escaparHtml_(data.folio) + '</div>' +
      '<div class="dato"><strong>Solicitante:</strong> ' + escaparHtml_(data.nombreSolicitante) + '</div>' +
    '</td>\n' +
    '<td class="enc-der">' +
      '<img class="enc-logo" alt="Seguros Atlas" src="' + ASSETS.LOGO_HEADER + '">' +
      agente +
      '<div class="dato"><strong>Emitido:</strong> ' + escaparHtml_(data.fechaEmision) + '</div>' +
    '</td>\n' +
    '</tr>\n</table>\n';
}

function bloqueInfoViaje_(data) {
  const celda = (etiqueta, valor) =>
    '<td><span class="et">' + escaparHtml_(etiqueta) + ':</span> ' + escaparHtml_(valor) + '</td>';

  return '<div class="banner">Información del viaje</div>\n' +
    '<table class="viaje" role="presentation">\n' +
    '<colgroup><col style="width:34%"><col style="width:33%"><col style="width:33%"></colgroup>\n' +
    '<tr>' +
      celda('Destino', data.destino) +
      celda('Fecha de Inicio', data.fechaInicio) +
      celda('Fecha de Regreso', data.fechaFin) +
    '</tr>\n<tr>' +
      celda('Duración del viaje', data.duracionDias + ' días') +
      celda('Cantidad de Asegurados', String(data.numAsegurados)) +
      celda('Vigencia de la cotización', data.vigenciaCotizacion) +
    '</tr>\n<tr>' +
      '<td class="aseg" colspan="3"><span class="et">Asegurados:</span> ' +
        escaparHtml_(data.listaAsegurados || '—') + '</td>' +
    '</tr>\n</table>\n';
}

function bloquePlanes_(data) {
  const encabezadosPlanes = PLANES
    .map((plan) => '<th>' + escaparHtml_(plan) + '</th>')
    .join('');

  const filas = COBERTURAS.map((cobertura, indice) => {
    const celdas = cobertura.valores.map((valor, columna) => {
      const nota = cobertura.nota && cobertura.nota[columna]
        ? '<span class="subnota">' + escaparHtml_(cobertura.nota[columna]) + '</span>'
        : '';
      return '<td class="num">' + escaparHtml_(valor) + nota + '</td>';
    }).join('');
    const clase = indice % 2 === 1 ? ' class="par"' : '';
    return '<tr' + clase + '><td>' + escaparHtml_(cobertura.concepto) + '</td>' + celdas + '</tr>';
  }).join('\n');

  const primasUnitarias = [data.primaMaster, data.primaSmart, data.primaElite, data.primaPremium]
    .map((prima) => '<td class="num">' + formatearMoneda_(prima) + '</td>').join('');
  const primasTotales = [data.totalMaster, data.totalSmart, data.totalElite, data.totalPremium]
    .map((total) => '<td class="num">' + formatearMoneda_(total) + '</td>').join('');

  return '<div class="banner">Planes disponibles</div>\n' +
    '<table class="cob">\n' +
    '<colgroup><col style="width:40%"><col style="width:15%"><col style="width:15%"><col style="width:15%"><col style="width:15%"></colgroup>\n' +
    '<thead><tr><th style="text-align:left;">Cobertura (sumas aseguradas en USD)</th>' + encabezadosPlanes + '</tr></thead>\n' +
    '<tbody>\n' + filas + '\n' +
    '<tr class="unit"><td>Prima por asegurado (USD)</td>' + primasUnitarias + '</tr>\n' +
    '<tr class="total"><td>PRIMA TOTAL (USD) — ' + data.numAsegurados + ' asegurado(s)</td>' + primasTotales + '</tr>\n' +
    '</tbody>\n</table>\n';
}

function bloqueEspecificaciones_() {
  return '<div class="banner">Especificaciones</div>\n' +
    '<table class="espec" role="presentation">\n<tr><td>' +
      '<strong>Edad de aceptación:</strong> de ' + CONFIG.EDAD_MINIMA + ' hasta ' + CONFIG.EDAD_MAXIMA + ' años. &nbsp;·&nbsp; ' +
      '<strong>Asegurados:</strong> mexicanos o extranjeros residiendo en México. &nbsp;·&nbsp; ' +
      '<strong>Cobertura:</strong> desde las 00:00 hrs del inicio hasta las 23:59 hrs de la culminación del viaje.<br>' +
      '<strong>Territorialidad:</strong> México y el Extranjero. Excepto: Afganistán, Bielorrusia, Crimea, Zaporizhzhia, Kherson, ' +
      'Donetsk, Luhansk, Irán, Israel, Corea del Norte, Rusia, Siria y Venezuela.<br>' +
      '<strong>Viajes nacionales no incluyen cobertura COVID-19.</strong> &nbsp;·&nbsp; ' +
      '<strong>No hay deducibles ni coaseguros.</strong>' +
    '</td></tr>\n</table>\n';
}

function bloqueAccionOperativa_() {
  return '<table class="ops" role="presentation" style="margin-top:5px;">\n' +
    '<colgroup><col style="width:37%"><col style="width:37%"><col style="width:26%"></colgroup>\n<tr>\n' +

    '<td><div class="caja">' +
      '<h3>¿CÓMO SOLICITAR LA EMISIÓN DE TU PÓLIZA?</h3>' +
      '<p>En caso de aceptar la propuesta, envía la siguiente documentación al correo ' +
      '<strong>segurodeviaje@segurosatlas.com.mx</strong>:</p>' +
      '<ul>' +
        '<li>• Formato de emisión debidamente llenado.</li>' +
        '<li>• Cotización aceptada.</li>' +
        '<li>• TCC y TCI (solicítalos a tu Mesa de Control).</li>' +
        '<li>• Constancia de Situación Fiscal (CSF) actualizada.</li>' +
      '</ul>' +
    '</div></td>\n' +

    '<td><div class="caja">' +
      '<h3>REGISTRO DE CONSTANCIA DE SITUACIÓN FISCAL</h3>' +
      '<p>Si requieres factura, antes de solicitar la emisión es indispensable registrar la situación fiscal ' +
      'enviando un correo a <strong>constanciafiscal@segurosatlas.com.mx</strong> con este formato estricto:</p>' +
      '<ul>' +
        '<li>• <strong>Asunto (mayúsculas):</strong> RFC DEL CONTRATANTE.</li>' +
        '<li>• <strong>Contenido:</strong> completamente en blanco (sin firma, sin texto).</li>' +
        '<li>• <strong>Adjunto (PDF en mayúsculas):</strong> CONSTANCIA + RFC.</li>' +
        '<li>• <strong>Confirmación:</strong> recibirás un correo con el estatus "Registro Exitoso".</li>' +
      '</ul>' +
    '</div></td>\n' +

    '<td class="ultima"><div class="caja qr-caja">' +
      '<h3>¿DESEAS RECOTIZAR TU VIAJE?</h3>' +
      '<img alt="Código QR para cotizar" src="' + ASSETS.QR_COTIZAR + '">' +
      '<p>Escanea el código QR y solicita una nueva cotización de forma rápida y sencilla.</p>' +
    '</div></td>\n' +

    '</tr>\n</table>\n';
}

function bloqueObservaciones_(data) {
  return '<div class="obs">\n' +
    '<h3>Observaciones</h3>\n' +
    '<p>Las sumas aseguradas aplican por asegurado y están expresadas en dólares americanos (USD). Las primas ' +
    'señaladas son netas, no incluyen IVA ni derecho de póliza, y corresponden exclusivamente a los asegurados ' +
    'listados en esta cotización dentro del rango de edad de ' + CONFIG.EDAD_MINIMA + ' a ' + CONFIG.EDAD_MAXIMA + ' años.</p>\n' +
    '<p>La presente cotización tiene una vigencia al <strong>' + escaparHtml_(data.vigenciaCotizacion) + '</strong> y no constituye ' +
    'una póliza ni garantiza la aceptación del riesgo; queda sujeta a la autorización de Seguros Atlas, S.A. y al ' +
    'cumplimiento de los requisitos de emisión. Verifica que la información de los asegurados y del contratante sea ' +
    'correcta y legible antes de solicitar la emisión.</p>\n' +
    '<p>Por políticas de la Dirección de Negocios Especiales, la solicitud de emisión debe enviarse con un mínimo de ' +
    CONFIG.DIAS_ANTICIPACION_MINIMA + ' días naturales de anticipación al inicio del viaje. Las correcciones por errores u ' +
    'omisiones toman de 3 a 5 días hábiles. Cualquier cambio en las fechas o en los días de viaje requiere una ' +
    're-cotización previa a la emisión. La cobertura, exclusiones, deducibles y condiciones aplicables se rigen en su ' +
    'totalidad por las condiciones generales del producto contratado registradas ante la Comisión Nacional de Seguros ' +
    'y Fianzas.</p>\n' +
    '<div class="pie-logo"><img alt="Seguros Atlas" src="' + ASSETS.LOGO_FOOTER + '"></div>\n' +
    '</div>\n';
}

// ============================================================================
// 5. CUERPO HTML DEL CORREO
// ============================================================================
// Tablas y CSS inline: Outlook (escritorio y web) ignora <style> en <head>,
// flexbox y grid.

function construirAsunto_(data) {
  if (data.estatus === CONFIG.ESTATUS.APROBADO) {
    return 'Cotización Seguro de Viaje SENIOR +79 — ' + data.destino + ' — Folio ' + data.folio;
  }
  return 'Solicitud no procesada — Seguro de Viaje SENIOR +79 — Folio ' + data.folio;
}

function encabezadoCorreo_(titulo) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ' +
    'style="background-color:' + COLORES.VERDE + ';border-collapse:collapse;">' +
    '<tr><td style="padding:14px 18px;">' +
      '<div style="font-size:17px;font-weight:bold;color:#ffffff;">' + escaparHtml_(titulo) + '</div>' +
      '<div style="font-size:11px;color:#cfe6da;margin-top:3px;">Seguros Atlas · Dirección de Negocios Especiales (DINE)</div>' +
    '</td></tr></table>';
}

function pieCorreo_() {
  return '<p style="margin:0 0 6px 0;">Quedamos a sus órdenes para cualquier aclaración.</p>' +
    '<p style="margin:0;color:#666;font-size:12px;">Dirección de Negocios Especiales · Seguros Atlas</p>';
}

function construirCorreoAprobado_(data) {
  const filaResumen = (etiqueta, valor) =>
    '<tr>' +
    '<td style="padding:5px 10px;border-bottom:1px solid ' + COLORES.BORDE + ';font-weight:bold;color:' + COLORES.AZUL + ';width:42%;">' +
      escaparHtml_(etiqueta) + '</td>' +
    '<td style="padding:5px 10px;border-bottom:1px solid ' + COLORES.BORDE + ';color:#333;">' +
      escaparHtml_(valor) + '</td>' +
    '</tr>';

  const filaPlan = (plan, total) =>
    '<tr>' +
    '<td style="padding:7px 10px;border:1px solid ' + COLORES.BORDE + ';color:#333;">' + escaparHtml_(plan) + '</td>' +
    '<td style="padding:7px 10px;border:1px solid ' + COLORES.BORDE + ';text-align:right;font-weight:bold;color:' + COLORES.VERDE + ';">' +
      formatearMoneda_(total) + ' USD</td>' +
    '</tr>';

  return '' +
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:640px;">' +
      encabezadoCorreo_('Cotización Seguro de Viaje SENIOR +79') +
      '<div style="padding:18px;border:1px solid ' + COLORES.BORDE + ';border-top:none;">' +

        '<p style="margin:0 0 14px 0;">Estimado(a) ' + escaparHtml_(data.nombreSolicitante) + ':</p>' +
        '<p style="margin:0 0 16px 0;">Adjunto encontrará la cotización correspondiente a su solicitud. ' +
        'A continuación el resumen de los datos considerados:</p>' +

        '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ' +
        'style="border-collapse:collapse;background-color:' + COLORES.VERDE_CLARO + ';margin-bottom:18px;">' +
          filaResumen('Folio', data.folio) +
          filaResumen('Destino', data.destino) +
          filaResumen('Fechas del viaje', data.fechaInicio + ' al ' + data.fechaFin) +
          filaResumen('Duración del viaje', data.duracionDias + ' días') +
          filaResumen('Asegurados', String(data.numAsegurados) + ' — ' + data.listaAsegurados) +
          filaResumen('Vigencia de esta cotización', data.vigenciaCotizacion) +
        '</table>' +

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
        '<p style="margin:0 0 18px 0;font-size:11px;color:#666;font-style:italic;">Importes en dólares americanos (USD) ' +
        'para ' + data.numAsegurados + ' asegurado(s). Primas netas, sin IVA ni derecho de póliza.</p>' +

        construirAvisoExcluidos_(data.pasajerosExcluidos) +

        '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ' +
        'style="border-collapse:collapse;background-color:' + COLORES.VERDE_CLARO + ';border-left:4px solid ' + COLORES.VERDE + ';margin-bottom:18px;">' +
          '<tr><td style="padding:12px 14px;">' +
            '<strong style="color:' + COLORES.VERDE + ';">Revisión obligatoria del documento adjunto</strong><br>' +
            'El detalle completo de <strong>coberturas, sumas aseguradas, especificaciones y requisitos de emisión</strong> ' +
            'se encuentra únicamente en la cotización en PDF adjunta a este correo. Le solicitamos revisarla en su ' +
            'totalidad antes de aceptar cualquier plan.' +
          '</td></tr>' +
        '</table>' +

        pieCorreo_() +
      '</div>' +
    '</div>';
}

function construirCorreoRechazo_(data) {
  const motivo = data.estatus === CONFIG.ESTATUS.RECHAZADO_TIEMPO
    ? motivoRechazoTiempo_(data)
    : motivoRechazoSinElegibles_(data);

  return '' +
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:640px;">' +
      encabezadoCorreo_('Solicitud de cotización no procesada') +
      '<div style="padding:18px;border:1px solid ' + COLORES.BORDE + ';border-top:none;">' +

        '<p style="margin:0 0 14px 0;">Estimado(a) ' + escaparHtml_(data.nombreSolicitante) + ':</p>' +

        '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ' +
        'style="border-collapse:collapse;background-color:' + COLORES.ROJO_FONDO + ';border-left:4px solid ' + COLORES.ROJO_BORDE + ';margin-bottom:18px;">' +
          '<tr><td style="padding:12px 14px;">' + motivo + '</td></tr>' +
        '</table>' +

        '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ' +
        'style="border-collapse:collapse;background-color:' + COLORES.VERDE_CLARO + ';margin-bottom:18px;">' +
          '<tr>' +
            '<td style="padding:5px 10px;font-weight:bold;color:' + COLORES.AZUL + ';width:42%;">Folio de la solicitud</td>' +
            '<td style="padding:5px 10px;color:#333;">' + escaparHtml_(data.folio) + '</td>' +
          '</tr>' +
          '<tr>' +
            '<td style="padding:5px 10px;font-weight:bold;color:' + COLORES.AZUL + ';">Destino</td>' +
            '<td style="padding:5px 10px;color:#333;">' + escaparHtml_(data.destino) + '</td>' +
          '</tr>' +
        '</table>' +

        construirAvisoExcluidos_(data.pasajerosExcluidos) +
        pieCorreo_() +
      '</div>' +
    '</div>';
}

function motivoRechazoTiempo_(data) {
  return '<p style="margin:0 0 14px 0;">Su solicitud para el destino <strong>' + escaparHtml_(data.destino) + '</strong>, ' +
    'con fecha de salida el <strong>' + escaparHtml_(data.fechaInicio) + '</strong>, no pudo ser procesada porque fue ' +
    'recibida con <strong>' + data.diasAnticipacion + ' día(s) de anticipación</strong>.</p>' +
    '<p style="margin:0 0 14px 0;">Por políticas de la <strong>Dirección de Negocios Especiales (DINE)</strong>, las ' +
    'solicitudes de cotización deben realizarse con un mínimo de <strong>' + CONFIG.DIAS_ANTICIPACION_MINIMA + ' días ' +
    'naturales de anticipación</strong> al inicio del viaje. Este plazo permite validar la información, emitir la ' +
    'póliza y entregarla antes de la salida.</p>' +
    '<p style="margin:0;">Si las fechas de su viaje lo permiten, le invitamos a enviar nuevamente su solicitud ' +
    'respetando este plazo.</p>';
}

function motivoRechazoSinElegibles_(data) {
  return '<p style="margin:0 0 14px 0;">Su solicitud para el destino <strong>' + escaparHtml_(data.destino) + '</strong> ' +
    'no pudo ser procesada porque <strong>ninguno de los pasajeros indicados se encuentra dentro del rango de edad ' +
    'del Producto Senior</strong>, que aplica exclusivamente para personas de ' + CONFIG.EDAD_MINIMA + ' a ' +
    CONFIG.EDAD_MAXIMA + ' años.</p>' +
    '<p style="margin:0;">Para cotizar a estos pasajeros, favor de solicitar el <strong>producto de viaje ' +
    'estándar</strong> a través de su Mesa de Control.</p>';
}

/**
 * Aviso ámbar de pasajeros fuera del rango 79-89. Devuelve cadena vacía si no
 * hubo exclusiones, para no dejar un bloque huérfano en el correo.
 */
function construirAvisoExcluidos_(pasajerosExcluidos) {
  if (!pasajerosExcluidos || pasajerosExcluidos.length === 0) return '';

  const nombres = pasajerosExcluidos
    .map((p) => escaparHtml_(p.nombre) + (p.edad !== null ? ' (' + p.edad + ' años)' : ''))
    .join(', ');

  return '' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ' +
    'style="border-collapse:collapse;background-color:' + COLORES.AMBAR_FONDO + ';border-left:4px solid ' + COLORES.AMBAR_BORDE + ';margin-bottom:18px;">' +
      '<tr><td style="padding:12px 14px;">' +
        '<strong style="color:' + COLORES.AMBAR_TEXTO + ';">Aviso importante</strong><br>' +
        'El/los pasajero(s) <strong>' + nombres + '</strong> no fueron incluidos en esta cotización debido a que el ' +
        'Producto Senior aplica exclusivamente para personas de ' + CONFIG.EDAD_MINIMA + ' a ' + CONFIG.EDAD_MAXIMA + ' años. ' +
        'Para cotizar a pasajeros fuera de este rango, favor de solicitar el producto de viaje estándar.' +
      '</td></tr>' +
    '</table>';
}

// ============================================================================
// 6. DRIVE Y PUENTE HACIA POWER AUTOMATE
// ============================================================================

function guardarHtmlEnDrive_(htmlContenido, nombreArchivo) {
  const carpeta = DriveApp.getFolderById(getPropiedad_('CARPETA_SALIDA_ID'));
  const blob = Utilities.newBlob(htmlContenido, 'text/html; charset=UTF-8', nombreArchivo);
  return carpeta.createFile(blob);
}

/**
 * @param {File|null} archivoHtml    Archivo en Drive; null si fue rechazada.
 * @param {Object}    data           Solicitud completa (incluye cuerpoCorreoHtml).
 * @param {string}    htmlCotizacion HTML renderizado; se envía en base64. '' si fue rechazada.
 */
function enviarWebhookPowerAutomate_(archivoHtml, data, htmlCotizacion) {
  const aprobado = data.estatus === CONFIG.ESTATUS.APROBADO;

  const payload = {
    emailCliente: data.emailCliente,
    correoCC: data.correoCC,
    asunto: construirAsunto_(data),
    estatus: data.estatus,
    cuerpoCorreoHtml: data.cuerpoCorreoHtml,

    // Grupal si califica más de un asegurado dentro del rango 79-89.
    tipoProducto: (data.numAsegurados > 1) ? 'Grupal' : 'Individual',

    // Solo en solicitudes aprobadas. Power Automate lo decodifica con
    // base64ToBinary() y lo convierte a PDF con Word Online.
    htmlBase64: aprobado && htmlCotizacion
      ? Utilities.base64Encode(htmlCotizacion, Utilities.Charset.UTF_8)
      : '',
    nombreArchivo: aprobado ? data.nombreArchivo : '',

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

// ============================================================================
// 7. PRUEBAS DE UN SOLO CLIC
// ============================================================================

/**
 * Caso APROBADO: dos asegurados elegibles (82 y 85 años) más un pasajero
 * excluido por edad (65), para verificar el aviso ámbar. Salida a 15 días,
 * así que cumple la anticipación mínima.
 * Genera el HTML en Drive y dispara el webhook.
 */
function testearTodo() {
  Logger.log('=== INICIO testearTodo() — caso APROBADO ===');
  try {
    const data = construirDatosPrueba_(15);
    Logger.log('Estatus: ' + data.estatus + ' | anticipación: ' + data.diasAnticipacion + ' días');
    Logger.log('Elegibles: ' + data.numAsegurados + ' (' + data.listaAsegurados + ')');
    Logger.log('Excluidos: ' + JSON.stringify(data.pasajerosExcluidos));
    Logger.log('Totales USD — Master: ' + data.totalMaster + ' | Smart: ' + data.totalSmart +
      ' | Elite: ' + data.totalElite + ' | Premium: ' + data.totalPremium);

    const htmlCotizacion = generarHtmlCotizacion_(data);
    const archivoHtml = guardarHtmlEnDrive_(htmlCotizacion, data.nombreArchivo);
    Logger.log('✅ Cotización guardada en Drive (' + htmlCotizacion.length + ' caracteres).');
    Logger.log('URL: ' + archivoHtml.getUrl());
    Logger.log('fileId: ' + archivoHtml.getId());

    data.cuerpoCorreoHtml = construirCorreoAprobado_(data);
    Logger.log('Asunto: ' + construirAsunto_(data));

    enviarWebhookPowerAutomate_(archivoHtml, data, htmlCotizacion);
    Logger.log('✅ Webhook enviado a Power Automate sin errores.');
  } catch (error) {
    Logger.log('❌ Error en testearTodo(): ' + error.message);
  }
  Logger.log('=== FIN testearTodo() ===');
}

/**
 * Caso RECHAZADO_TIEMPO: salida en 2 días. No debe generar cotización ni
 * primas; manda el correo de rechazo sin adjunto.
 */
function testearRechazoPorTiempo() {
  Logger.log('=== INICIO testearRechazoPorTiempo() ===');
  try {
    const data = construirDatosPrueba_(2);
    Logger.log('Estatus: ' + data.estatus + ' | anticipación: ' + data.diasAnticipacion + ' días');
    Logger.log('Primas (deben ser 0): Master ' + data.totalMaster + ' | Premium ' + data.totalPremium);

    data.cuerpoCorreoHtml = construirCorreoRechazo_(data);
    Logger.log('Asunto: ' + construirAsunto_(data));

    enviarWebhookPowerAutomate_(null, data, '');
    Logger.log('✅ Webhook de rechazo enviado sin adjunto.');
  } catch (error) {
    Logger.log('❌ Error en testearRechazoPorTiempo(): ' + error.message);
  }
  Logger.log('=== FIN testearRechazoPorTiempo() ===');
}

/**
 * Caso RECHAZADO_SIN_ELEGIBLES: ningún pasajero dentro del rango 79-89.
 */
function testearRechazoSinElegibles() {
  Logger.log('=== INICIO testearRechazoSinElegibles() ===');
  try {
    const data = construirDatosPrueba_(20, [
      { nombre: 'Ana Ruiz', edad: 65 },
      { nombre: 'Luis Mora', edad: 71 }
    ]);
    Logger.log('Estatus: ' + data.estatus + ' | elegibles: ' + data.numAsegurados);

    data.cuerpoCorreoHtml = construirCorreoRechazo_(data);
    Logger.log('Asunto: ' + construirAsunto_(data));

    enviarWebhookPowerAutomate_(null, data, '');
    Logger.log('✅ Webhook de rechazo enviado sin adjunto.');
  } catch (error) {
    Logger.log('❌ Error en testearRechazoSinElegibles(): ' + error.message);
  }
  Logger.log('=== FIN testearRechazoSinElegibles() ===');
}

/**
 * Arma una fila sintética y la pasa por construirDatosSolicitud_, de modo que
 * las pruebas ejerciten la misma lógica de filtro, estatus y primas que el
 * trigger real, sin tocar la hoja de cálculo.
 *
 * @param {number} diasHastaSalida Días naturales entre hoy y la fecha de salida.
 * @param {Array=} pasajeros       Lista {nombre, edad}; por defecto 2 elegibles + 1 excluido.
 */
function construirDatosPrueba_(diasHastaSalida, pasajeros) {
  const msPorDia = 24 * 60 * 60 * 1000;
  const hoy = new Date();
  const salida = new Date(hoy.getTime() + diasHastaSalida * msPorDia);
  const regreso = new Date(salida.getTime() + 10 * msPorDia);

  const lista = pasajeros || [
    { nombre: 'Roberto García', edad: 82 },
    { nombre: 'María López', edad: 85 },
    { nombre: 'Ana Ruiz', edad: 65 } // excluida: dispara el aviso ámbar
  ];

  const encabezados = [
    CONFIG.COL_PERFIL,
    CONFIG.COL_AGENTE_INFO,
    CONFIG.COL_NOMBRE_SOLICITANTE,
    CONFIG.COL_EMAIL_CLIENTE,
    CONFIG.COL_CORREO_CC,
    CONFIG.COL_DESTINO,
    CONFIG.COL_FECHA_INICIO,
    CONFIG.COL_FECHA_FIN,
    CONFIG.COL_PRIMA_MASTER,
    CONFIG.COL_PRIMA_SMART,
    CONFIG.COL_PRIMA_ELITE,
    CONFIG.COL_PRIMA_PREMIUM
  ];
  const valores = [
    'Soy Agente',
    'A-1042 Miguel Cárdenas',
    'Miguel Cárdenas',
    'prueba@example.com',
    'contacto@example.com',
    'Brasil',
    salida,
    regreso,
    45.5, 65, 95, 125
  ];

  lista.forEach((pasajero, indice) => {
    encabezados.push('Nombre Asegurado ' + (indice + 1));
    valores.push(pasajero.nombre);
    encabezados.push('Edad Asegurado ' + (indice + 1));
    valores.push(pasajero.edad);
  });

  return construirDatosSolicitud_(99, encabezados, valores);
}

// ============================================================================
// 8. UTILIDADES
// ============================================================================

function getPropiedad_(nombre) {
  const valor = PropertiesService.getScriptProperties().getProperty(nombre);
  if (!valor) {
    throw new Error('Falta configurar la propiedad "' + nombre + '". Ejecuta configurarPropiedades().');
  }
  return valor;
}

function marcarEstadoFila_(sheet, fila, encabezados, mensaje) {
  const indiceEstado = indiceDe_(encabezados, CONFIG.COL_ESTADO);
  if (indiceEstado === -1) return; // columna opcional
  sheet.getRange(fila, indiceEstado + 1).setValue(mensaje + ' — ' + new Date());
}
