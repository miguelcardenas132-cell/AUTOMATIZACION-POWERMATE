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
 *   2) Se filtran los asegurados elegibles (de 79 años 11 meses a 89 años
 *      11 meses, calculado desde su fecha de nacimiento respecto a la fecha
 *      de salida del viaje) y se registran los excluidos.
 *   3) Se valida la anticipación mínima (5 días naturales).
 *   4) Si procede, se genera el HTML de la cotización (1 página, tamaño carta)
 *      y se guarda en Drive con codificación UTF-8 explícita.
 *   5) Se construye el cuerpo HTML del correo (aprobación o rechazo).
 *   6) Se dispara el webhook a Power Automate.
 *
 * ESTATUS POSIBLES
 *   APROBADO                 Hay al menos un elegible y se cumple la anticipación.
 *   RECHAZADO_TIEMPO         Menos de 5 días naturales antes de la salida.
 *   RECHAZADO_SIN_ELEGIBLES  Ningún pasajero cae en el rango de edad elegible.
 *
 * SOBRE LAS COLUMNAS "Validacion_*", "Estado_Final" y "Motivo_Rechazo" DEL
 * SHEET: se evaluaron como posible fuente de verdad y se descartaron. En
 * filas reales aparecen vacías, o —en el caso de Estado_Final— contienen un
 * residuo de una versión anterior de este mismo script. Cantidad_Asegurados
 * y Tipo_Solicitud tampoco sirven: cuentan a TODOS los pasajeros capturados,
 * sin aplicar el filtro de edad. Este script sigue siendo la única fuente
 * de verdad de la regla de negocio.
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
    CARPETA_SALIDA_ID: '18TeoYPc4hv3PJg7_We7ENFLPL8L1q4ba',
    WEBHOOK_POWER_AUTOMATE_URL: 'https://default32a81134015a4387b28dc065cc42c1.74.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/30/workflows/d2932e8514cc4650ae65a9ce97240394/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=R8glq89ev9F9bDJydk_CRjmqTJIiQ1i8l6Xr8_A_81w'
  });
}

const CONFIG = {
  // --- Reglas de negocio ---
  EDAD_MINIMA: 79,
  EDAD_MAXIMA: 89,
  // El corte real no es en años completos: aplica desde que el asegurado
  // cumple EDAD_MINIMA años y EDAD_MESES_ADICIONALES meses, hasta que
  // cumple EDAD_MAXIMA años y EDAD_MESES_ADICIONALES meses (inclusive).
  EDAD_MESES_ADICIONALES: 11,
  DIAS_ANTICIPACION_MINIMA: 5,
  VIGENCIA_DIAS: 7,
  MAX_ASEGURADOS: 10,

  // Formulario que el cliente llena para solicitar la emisión (Paso 1 del PDF).
  URL_FORMULARIO_EMISION: 'https://forms.gle/P2iiskLHtBALa9F36',

  // Enlaces del cuerpo del correo.
  URL_PORTAL_AGENTES: 'https://www.atlasconmigo.com.mx/login',
  URL_AVISO_PRIVACIDAD: 'https://www.segurosatlas.com.mx/aviso-de-privacidad',

  /**
   * Imágenes del correo.
   *
   * Tienen que ser URLs públicas, NO data: URI en base64 como las del PDF:
   * Gmail y Outlook bloquean o descartan las imágenes incrustadas en base64
   * dentro del cuerpo de un correo. Sube los archivos a un servidor o
   * biblioteca de SharePoint con acceso anónimo de lectura y pega aquí el
   * enlace directo.
   */
  URL_LOGO_CORREO: 'https://drive.google.com/uc?export=view&id=102HW04JcuRuelEvkoZYV34fJQz9s2FOV',
  URL_FIRMA_CORREO: 'https://drive.google.com/uc?export=view&id=1PVMOnr8P9YA5uFgv-0Hf4MZm-p0kaIA9',

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
  COL_FOLIO: 'Folio',

  // Columnas de primas por asegurado. No hay tabla tarifaria en el script:
  // las primas se leen de la hoja, que ya las calcula.
  COL_PRIMA_MASTER: 'PrimaMaster',
  COL_PRIMA_SMART: 'PrimaSmart',
  COL_PRIMA_ELITE: 'PrimaElite',
  COL_PRIMA_PREMIUM: 'PrimaPremium',

  // Columna opcional de trazabilidad. Si no existe en la hoja, se ignora.
  COL_ESTADO: 'Estado de envío',

  /**
   * Resolución de las columnas de cada asegurado.
   *
   * Los nombres siguen el patrón 'Nombre Asegurado N'; la edad se deriva de
   * 'Fecha de Nacimiento Asegurado N' (no de la columna Edad_N, que solo
   * trae años completos y no alcanza la precisión de meses que exige el
   * corte de negocio).
   *
   * Se prueban los patrones en orden hasta encontrar la columna, así que
   * basta con que el primero coincida. Si algún encabezado se sale del
   * patrón, fíjalo literalmente por índice en OVERRIDE_NOMBRE u
   * OVERRIDE_FECHA_NAC (ej. { 3: 'Fecha nac. tercer asegurado' }). Ejecuta
   * listarEncabezados() para ver los nombres reales de tu hoja.
   */
  ASEGURADOS: {
    PATRONES_NOMBRE: [
      'Nombre Asegurado {i}',
      'Nombre asegurado {i}',
      'Nombre_{i}',
      'Asegurado {i} Nombre',
      'Asegurado_{i}'
    ],
    PATRONES_FECHA_NAC: [
      'Fecha de Nacimiento Asegurado {i}',
      'Fecha de nacimiento asegurado {i}',
      'Fecha de Nacimiento_{i}',
      'Fecha Nacimiento Asegurado {i}'
    ],
    OVERRIDE_NOMBRE: {},
    OVERRIDE_FECHA_NAC: {}
  }
};

// Paleta corporativa, compartida por la cotización y el correo.
const COLORES = {
  VERDE: '#027370',
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
  const archivoHtml = guardarHtmlEnDrive_(htmlCotizacion, data.nombreArchivoDrive);
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

/**
 * Diagnóstico: imprime encabezado + valor de una fila real, para confirmar
 * el formato exacto que producen las fórmulas del Sheet (Estado_Final,
 * Motivo_Rechazo, Validacion_Edad, etc.) antes de mapearlas en CONFIG.
 */
function listarValoresFila_(fila) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const encabezados = leerEncabezados_(sheet);
  const valores = sheet.getRange(fila, 1, 1, sheet.getLastColumn()).getValues()[0];
  Logger.log('=== VALORES DE LA FILA ' + fila + ' ===');
  encabezados.forEach((h, i) => Logger.log(h + ': ' + JSON.stringify(valores[i])));
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

  // --- Fechas del viaje ---
  // Van primero porque el filtro de edad se calcula respecto a la fecha de
  // salida (estándar actuarial de seguros de viaje: el asegurado debe estar
  // dentro del rango de edad el día que inicia su cobertura), no respecto a
  // la fecha de la solicitud.
  const inicioRaw = valorObligatorio_(encabezados, valores, CONFIG.COL_FECHA_INICIO);
  const finRaw = valorObligatorio_(encabezados, valores, CONFIG.COL_FECHA_FIN);
  const duracionDias = calcularDuracionViaje_(inicioRaw, finRaw);
  const diasAnticipacion = calcularDiasAnticipacion_(hoy, inicioRaw);
  const fechaSalida = inicioRaw instanceof Date ? inicioRaw : new Date(inicioRaw);

  // --- Filtro de edad: de EDAD_MINIMA años y EDAD_MESES_ADICIONALES meses,
  // hasta EDAD_MAXIMA años y EDAD_MESES_ADICIONALES meses (inclusive) ---
  const mesesMinimo = CONFIG.EDAD_MINIMA * 12 + CONFIG.EDAD_MESES_ADICIONALES;
  const mesesMaximo = CONFIG.EDAD_MAXIMA * 12 + CONFIG.EDAD_MESES_ADICIONALES;

  const asegurados = [];
  const pasajerosExcluidos = [];
  for (let i = 1; i <= CONFIG.MAX_ASEGURADOS; i++) {
    const nombreCrudo = valorPorPatron_(
      encabezados, valores, CONFIG.ASEGURADOS.PATRONES_NOMBRE, CONFIG.ASEGURADOS.OVERRIDE_NOMBRE, i);
    if (nombreCrudo === null || nombreCrudo.toString().trim() === '') continue;

    const nombre = nombreCrudo.toString().trim();
    const fechaNacCruda = valorPorPatron_(
      encabezados, valores, CONFIG.ASEGURADOS.PATRONES_FECHA_NAC, CONFIG.ASEGURADOS.OVERRIDE_FECHA_NAC, i);
    const mesesEdad = calcularEdadEnMeses_(fechaNacCruda, fechaSalida);
    const edadNum = mesesEdad === null ? null : Math.floor(mesesEdad / 12);

    // El motivo de exclusión importa para el correo: los menores a la edad
    // mínima sí tienen alternativa (portal de agentes); los mayores a la
    // edad máxima no se pueden asegurar por políticas de suscripción.
    let motivoExclusion = null;
    if (mesesEdad === null) motivoExclusion = 'SIN_DATO';
    else if (mesesEdad < mesesMinimo) motivoExclusion = 'MENOR';
    else if (mesesEdad > mesesMaximo) motivoExclusion = 'MAYOR';

    if (motivoExclusion !== null) {
      pasajerosExcluidos.push({ nombre: nombre, edad: edadNum, motivo: motivoExclusion });
      continue;
    }
    asegurados.push({ nombre: nombre, edad: edadNum });
  }
  const numAsegurados = asegurados.length;

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

  const folio = valorObligatorio_(encabezados, valores, CONFIG.COL_FOLIO);

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

    // Nombre interno del respaldo en Drive (auditoría). Distinto del nombre
    // del PDF adjunto que recibe el cliente: ver construirNomenclatura_.
    nombreArchivoDrive: 'Cotizacion_' + folio + '.html',
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

/**
 * Edad exacta en meses completos de un asegurado respecto a una fecha de
 * referencia (la fecha de salida del viaje). Se usa en vez de años enteros
 * porque el corte de elegibilidad del producto es en años y meses
 * (79 años 11 meses a 89 años 11 meses), no en años completos.
 * Devuelve null si la fecha de nacimiento no es válida.
 */
function calcularEdadEnMeses_(fechaNacimiento, fechaReferencia) {
  if (!fechaNacimiento) return null;
  const nacimiento = fechaNacimiento instanceof Date ? fechaNacimiento : new Date(fechaNacimiento);
  if (isNaN(nacimiento.getTime())) return null;

  let meses = (fechaReferencia.getFullYear() - nacimiento.getFullYear()) * 12 +
    (fechaReferencia.getMonth() - nacimiento.getMonth());
  if (fechaReferencia.getDate() < nacimiento.getDate()) meses -= 1;
  return meses;
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

/** Texto del rango de edad de aceptación, ej. "79 años 11 meses a 89 años 11 meses". */
function textoRangoEdad_() {
  return textoEdadMinima_() + ' a ' + textoEdadMaxima_();
}

/** Ej. "79 años 11 meses". */
function textoEdadMinima_() {
  return CONFIG.EDAD_MINIMA + ' años ' + CONFIG.EDAD_MESES_ADICIONALES + ' meses';
}

/** Ej. "89 años 11 meses". */
function textoEdadMaxima_() {
  return CONFIG.EDAD_MAXIMA + ' años ' + CONFIG.EDAD_MESES_ADICIONALES + ' meses';
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
 * Maquetación para que Word Online la convierta a una sola página carta.
 *
 * Todo se arma con tablas y <colgroup>, nunca con flex ni grid: el motor de
 * conversión HTML->DOCX los ignora y colapsaría las cuadrículas en una sola
 * columna. Las imágenes van como data: URI porque el convertidor tampoco
 * descarga recursos externos.
 *
 * El pie va justo después del contenido (sin forzarlo al fondo de la hoja):
 * así no se acumula espacio en blanco entre ambos sin importar cuánto
 * contenido tenga la cotización.
 */
function generarHtmlCotizacion_(data) {
  return '<!DOCTYPE html>\n' +
    '<html lang="es">\n<head>\n<meta charset="UTF-8">\n' +
    '<title>Cotización ' + escaparHtml_(data.folio) + '</title>\n' +
    '<style>\n' + estilosCotizacion_() + '</style>\n</head>\n<body>\n' +
    '<table class="marco" role="presentation">\n' +
    '<tr><td class="marco-contenido">\n' +
      bloqueEncabezado_(data) +
      bloqueInfoViaje_(data) +
      bloqueCoberturas_(data) +
      bloqueEspecificaciones_() +
      bloqueAccionOperativa_() +
      bloqueObservacionesYQr_() +
    '</td></tr>\n' +
    '<tr><td class="marco-pie">\n' +
      bloquePie_() +
    '</td></tr>\n' +
    '</table>\n</body>\n</html>';
}

function estilosCotizacion_() {
  return '' +
    '@page { size: letter; margin: 0.3cm; }\n' +
    '* { box-sizing: border-box; margin: 0; padding: 0; }\n' +
    '.marco { width: 100%; border-collapse: collapse; }\n' +
    '.marco-contenido { vertical-align: top; }\n' +
    '.marco-pie { vertical-align: top; }\n' +
    'body { font-family: Arial, Helvetica, sans-serif; font-size: 9.5px; color: #111; line-height: 1.3;\n' +
    '       -webkit-print-color-adjust: exact; print-color-adjust: exact; }\n' +
    'table { border-collapse: collapse; width: 100%; }\n' +
    'a { color: ' + COLORES.VERDE + '; text-decoration: underline; }\n' +

    // --- 1. Encabezado: título aislado + contenedor de datos ---
    '.tit-tabla { background-color: ' + COLORES.VERDE + '; }\n' +
    '.tit-tabla td { padding: 5px 11px; vertical-align: middle; }\n' +
    '.tit-tabla .titulo { font-size: 15.5px; font-weight: bold; color: #ffffff; letter-spacing: .3px; }\n' +
    '.tit-tabla .sub { font-size: 9px; color: #cfe6da; margin-top: 2px; }\n' +
    '.tit-logo { text-align: right; width: 27%; }\n' +
    '.tit-logo img { max-height: 30px; width: auto; }\n' +
    '.meta { background-color: ' + COLORES.VERDE_CLARO + '; border: 1px solid ' + COLORES.VERDE_BORDE + ';\n' +
    '        border-top: none; margin-bottom: 6px; }\n' +
    '.meta td { padding: 3px 11px; font-size: 9.5px; color: #222; vertical-align: top; }\n' +
    '.meta .et { font-weight: bold; color: ' + COLORES.AZUL + '; }\n' +
    '.meta .der { text-align: right; }\n' +

    // --- 2. Información del viaje ---
    '.banner { background-color: ' + COLORES.VERDE + '; color: #ffffff; font-weight: bold;\n' +
    '          font-size: 9.5px; text-transform: uppercase; padding: 3px 9px;\n' +
    '          margin: 4px 0 0; letter-spacing: .4px; }\n' +
    '.viaje { background-color: ' + COLORES.VERDE_CLARO + '; border: 1px solid ' + COLORES.VERDE_BORDE + '; }\n' +
    '.viaje td { padding: 3px 9px; font-size: 9.5px; vertical-align: top; }\n' +
    '.viaje .et { font-weight: bold; color: ' + COLORES.AZUL + '; }\n' +

    // --- 3. Tabla de coberturas ---
    '.cob { font-size: 9.2px; line-height: 1.2; margin-top: 4px; border-top: 1px solid #d6d6d6;\n' +
    '       border-bottom: 1px solid #d6d6d6; }\n' +
    // Solo líneas verticales (columnas): sin borde superior/inferior por celda.
    '.cob th, .cob td { border: none; border-left: 1px solid #d6d6d6; border-right: 1px solid #d6d6d6;\n' +
    '                    padding: 2.3px 5px; text-align: left; }\n' +
    '.cob th.planes { background-color: ' + COLORES.VERDE + '; color: #ffffff; text-align: center;\n' +
    '                 font-size: 11.5px; font-weight: bold; letter-spacing: .5px; padding: 4px; text-transform: uppercase;\n' +
    '                 border: none; border-bottom: 2px solid #ffffff; }\n' +
    '.cob th.sub { background-color: ' + COLORES.VERDE + '; color: #ffffff; font-weight: bold;\n' +
    '              text-align: center; font-size: 9.1px; text-transform: uppercase; padding: 2.3px 4px; }\n' +
    '.cob th.sub-izq { text-align: left; }\n' +
    '.cob th .moneda { display: block; font-weight: normal; font-size: 7.6px; }\n' +
    '.cob td.num { text-align: center; }\n' +
    '.cob .subnota { display: block; color: #444; font-size: 7.9px; }\n' +
    // Coberturas principales (con número romano) resaltadas; sub-límites
    // (sin número romano) con sangría para mostrar que dependen de la de arriba.
    '.cob tr.principal td { font-weight: bold; }\n' +
    '.cob tr.sublimite td:first-child { padding-left: 18px; }\n' +
    '.cob tr.total td { background-color: ' + COLORES.TOTAL_FONDO + '; font-weight: bold;\n' +
    '                   border-top: 2px solid ' + COLORES.VERDE + ' !important; border-bottom: none;\n' +
    '                   font-size: 10.2px; color: ' + COLORES.VERDE + '; padding: 3.5px 5px; }\n' +
    '.nota-tabla { font-size: 8.2px; color: #555; margin: 2px 0 0; }\n' +

    // --- 4. Especificaciones ---
    '.espec { border: 1px solid ' + COLORES.VERDE_BORDE + '; background-color: #ffffff; }\n' +
    '.espec td { padding: 3px 10px; }\n' +
    '.espec ul { list-style: none; }\n' +
    '.espec li { font-size: 8.5px; line-height: 1.26; padding-left: 8px; text-indent: -8px; }\n' +
    '.espec strong { color: ' + COLORES.VERDE + '; }\n' +

    // --- 5. Recuadros operativos ---
    '.ops-caja { margin-top: 3px; border: 1px solid #b9b9b9; }\n' +
    '.ops-banner { background-color: ' + COLORES.VERDE + '; color: #ffffff; text-align: center;\n' +
    '              font-weight: bold; font-size: 9.5px; text-transform: uppercase;\n' +
    '              padding: 3px; letter-spacing: .4px; }\n' +
    // border-spacing separa las tarjetas; cellspacing en el HTML cubre el
    // caso de que el convertidor a DOCX ignore la propiedad CSS.
    '.ops { border-collapse: separate; border-spacing: 3px; }\n' +
    '.ops td.celda { border: 1px solid #d5d5d5; border-radius: 6px; background-color: #ffffff;\n' +
    '                padding: 3px 7px; vertical-align: top; }\n' +
    '.ops h3 { font-size: 8.5px; color: ' + COLORES.AZUL + '; margin-bottom: 2px; }\n' +
    '.ops p { font-size: 7.8px; line-height: 1.24; }\n' +
    '.ops ul { list-style: none; margin-top: 1px; margin-left: 7px; }\n' +
    '.ops li { font-size: 7.8px; line-height: 1.24; padding-left: 7px; text-indent: -7px; }\n' +
    // Cierre: observaciones a la izquierda, QR esquinado abajo a la derecha.
    '.cierre { border-collapse: collapse; margin-top: 3px; }\n' +
    '.cierre td { vertical-align: top; }\n' +
    '.cierre-obs { padding-right: 9px; }\n' +
    '.cierre-qr { vertical-align: bottom; }\n' +
    // Sin recuadro: el QR y su texto respiran sobre el blanco de la hoja,
    // junto al bloque de observaciones.
    '.qr-tarjeta { padding: 2px 4px 0; text-align: center; }\n' +
    '.qr-tarjeta img { width: 76px; height: 76px; display: block; margin: 3px auto 0; }\n' +
    '.qr-tarjeta h3 { font-size: 8px; color: ' + COLORES.AZUL + '; margin-bottom: 1px; }\n' +
    '.qr-tarjeta p { font-size: 7px; line-height: 1.22; color: #444; }\n' +
    '.qr-tarjeta p.qr-nota { font-style: italic; margin-top: 2px; }\n' +

    // --- 6. Observaciones ---
    '.obs { margin-top: 3px; }\n' +
    '.obs h3 { font-size: 10px; color: ' + COLORES.VERDE + '; text-transform: uppercase; margin-bottom: 1px; }\n' +
    '.obs ol { margin: 0 0 1.5px 13px; }\n' +
    // Mismo tamaño e interlineado que .espec li, para que ambos bloques de
    // texto corrido se lean homogéneos.
    '.obs li { font-size: 8.5px; line-height: 1.26; }\n' +
    '.obs p { font-size: 8.5px; line-height: 1.26; margin-bottom: 0.5px; }\n' +

    // --- 7. Pie ---
    '.pie { margin-top: 10px; padding-top: 6px; border-top: 1px solid #d6d6d6; }\n' +
    '.pie td { font-size: 8px; color: #555; vertical-align: middle; text-align: center;\n' +
    '          line-height: 1.35; padding: 0 8px; }\n' +
    '.pie td.sep { border-left: 1px solid #c8c8c8; }\n' +
    '.pie a { color: ' + COLORES.VERDE + '; text-decoration: underline; }\n';
}

/**
 * Título y subtítulo aislados arriba; debajo, el contenedor con folio,
 * solicitante, agente (solo si aplica) y fecha/hora de emisión.
 */
function bloqueEncabezado_(data) {
  const agente = data.mostrarAgente
    ? '<div><span class="et">Agente:</span> ' + escaparHtml_(data.agenteInfo) + '</div>'
    : '';

  return '<table class="tit-tabla" role="presentation">\n<tr>\n' +
    '<td>' +
      '<div class="titulo">COTIZACIÓN SENIOR +79 AÑOS</div>' +
      '<div class="sub">Seguro de Viaje · Dirección de Negocios Especiales (DINE)</div>' +
    '</td>\n' +
    '<td class="tit-logo"><img alt="Seguros Atlas" src="' + ASSETS.LOGO_HEADER + '"></td>\n' +
    '</tr>\n</table>\n' +

    '<table class="meta" role="presentation">\n' +
    '<colgroup><col style="width:58%"><col style="width:42%"></colgroup>\n<tr>\n' +
    '<td>' +
      '<div><span class="et">No. Cotización:</span> ' + escaparHtml_(data.folio) + '</div>' +
      '<div><span class="et">Solicitante:</span> ' + escaparHtml_(data.nombreSolicitante) + '</div>' +
    '</td>\n' +
    '<td class="der">' +
      agente +
      '<div><span class="et">Fecha y hora de emisión:</span> ' + escaparHtml_(data.fechaEmision) + '</div>' +
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
    '</tr>\n</table>\n';
}

/**
 * Tabla de coberturas: banner "PLANES DISPONIBLES" a todo lo ancho, sub-
 * encabezados por plan, y al pie la prima unitaria y la prima total.
 * No lleva la fila de casillas de selección.
 */
function bloqueCoberturas_(data) {
  const subEncabezados = PLANES
    .map((plan) => '<th class="sub">' + escaparHtml_(plan) + '<span class="moneda">(USD)</span></th>')
    .join('');

  const filas = COBERTURAS.map((cobertura) => {
    // Las coberturas principales llevan número romano al inicio (ej. "V. Gastos
    // Médicos..."); todo lo demás es un sub-límite que depende de la principal
    // más reciente arriba, y se marca con sangría en vez de negritas.
    const esPrincipal = /^[IVXLCDM]+\.\s/.test(cobertura.concepto);
    const celdas = cobertura.valores.map((valor, columna) => {
      const nota = cobertura.nota && cobertura.nota[columna]
        ? '<span class="subnota">' + escaparHtml_(cobertura.nota[columna]) + '</span>'
        : '';
      return '<td class="num">' + escaparHtml_(valor) + nota + '</td>';
    }).join('');
    return '<tr class="' + (esPrincipal ? 'principal' : 'sublimite') + '"><td>' +
      escaparHtml_(cobertura.concepto) + '</td>' + celdas + '</tr>';
  }).join('\n');

  const primasTotales = [data.totalMaster, data.totalSmart, data.totalElite, data.totalPremium]
    .map((total) => '<td class="num">' + formatearMoneda_(total) + '</td>').join('');

  return '<table class="cob">\n' +
    '<colgroup><col style="width:40%"><col style="width:15%"><col style="width:15%"><col style="width:15%"><col style="width:15%"></colgroup>\n' +
    '<thead>\n' +
    '<tr><th class="planes" colspan="5">Planes disponibles</th></tr>\n' +
    '<tr><th class="sub sub-izq">Coberturas</th>' + subEncabezados + '</tr>\n' +
    '</thead>\n<tbody>\n' + filas + '\n' +
    '<tr class="total"><td>Prima neta por (' + data.numAsegurados + ' ' +
      (data.numAsegurados === 1 ? 'asegurado' : 'asegurados') + ') + IVA en dólares (USD)</td>' +
      primasTotales + '</tr>\n' +
    '</tbody>\n</table>\n' +
    '<p class="nota-tabla" style="font-style: italic;">Nota: Las sumas aseguradas aplican por asegurado y ' +
    'están expresadas en dólares americanos (USD).</p>\n';
}

function bloqueEspecificaciones_() {
  return '<div class="banner">Especificaciones</div>\n' +
    '<table class="espec" role="presentation">\n<tr><td>\n<ul>\n' +
      '<li>• <strong>Edad de aceptación:</strong> de ' + textoRangoEdad_() + '.</li>\n' +
      '<li>• <strong>Asegurados:</strong> mexicanos o extranjeros residiendo en México.</li>\n' +
      '<li>• <strong>Cobertura:</strong> desde las 00:00 hrs del inicio hasta las 23:59 hrs de la culminación del viaje.</li>\n' +
      '<li>• <strong>Territorialidad:</strong> México y el Extranjero. Excepto: Afganistán, Bielorrusia, Crimea, ' +
      'Zaporizhzhia, Kherson, Donetsk, Luhansk, Irán, Israel, Corea del Norte, Rusia, Siria y Venezuela.</li>\n' +
      '<li>• <strong>No hay deducibles ni coaseguros.</strong></li>\n' +
    '</ul>\n</td></tr>\n</table>\n';
}

/**
 * Cuadrícula de recuadros bajo un banner común.
 *
 * Se construye con una tabla de 6 columnas y colspan (3+3 arriba, 2+2+2
 * abajo) en lugar de grid/flex: el resultado visual es la misma retícula
 * alineada, pero sobrevive la conversión a DOCX de Word Online.
 */
function bloqueAccionOperativa_() {
  return '<div class="ops-caja">\n' +
    '<div class="ops-banner">Solicita tu póliza</div>\n' +
    '<table class="ops" role="presentation" cellspacing="5">\n' +
    '<colgroup><col style="width:33.34%"><col style="width:33.33%"><col style="width:33.33%"></colgroup>\n' +

    '<tr>\n' +
    '<td class="celda">' +
      '<h3>Paso 1. Requisitos para iniciar tu proceso</h3>' +
      '<p>En caso de aceptar la propuesta, completa el siguiente formulario para el envío de tu póliza: ' +
      '<a href="' + escaparHtml_(CONFIG.URL_FORMULARIO_EMISION) + '">' +
      escaparHtml_(CONFIG.URL_FORMULARIO_EMISION) + '</a></p>' +
    '</td>\n' +
    '<td class="celda">' +
      '<h3>En caso de requerir factura</h3>' +
      '<p>Si requieres factura, antes de solicitar la emisión es indispensable registrar la situación fiscal ' +
      'enviando un correo a <strong>constanciafiscal@segurosatlas.com.mx</strong> con este formato estricto:</p>' +
      '<ul>' +
        '<li>• <strong>Asunto (mayúsculas):</strong> RFC DEL CONTRATANTE.</li>' +
        '<li>• <strong>Contenido:</strong> completamente en blanco (sin firma, sin texto).</li>' +
        '<li>• <strong>Archivo adjunto (PDF en mayúsculas):</strong> CONSTANCIA + RFC.</li>' +
        '<li>• <strong>Confirmación:</strong> recibirás un correo con el estatus "Registro Exitoso".</li>' +
      '</ul>' +
    '</td>\n' +
    '<td class="celda">' +
      '<h3>Paso 2. Requisitos/consideraciones para emisión</h3>' +
      '<ul>' +
        '<li>• <strong>Incluir fechas de viaje.</strong></li>' +
        '<li>• <strong>Revisión de datos:</strong> verifica que la información de los asegurados y del contratante ' +
        'sea correcta y legible.</li>' +
        '<li>• <strong>Tiempo de gestión:</strong> el formulario de emisión deberá ser enviado hasta un máximo ' +
        'de 4 días hábiles antes de iniciar tu viaje.</li>' +
        '<li>• <strong>Correcciones:</strong> los cambios por errores u omisiones toman de 3 a 5 días hábiles.</li>' +
        '<li>• <strong>Actualizaciones:</strong> cualquier cambio en los días de viaje requiere re-cotización ' +
        'previa a la emisión.</li>' +
      '</ul>' +
    '</td>\n' +
    '</tr>\n' +
    '</table>\n</div>\n';
}

/**
 * Observaciones a la izquierda y el código QR esquinado abajo a la derecha,
 * en una misma fila: el texto legal aprovecha el ancho que antes quedaba
 * muerto junto al QR, y el QR cierra la hoja como llamada a la acción.
 */
function bloqueObservacionesYQr_() {
  return '<table class="cierre" role="presentation">\n' +
    '<colgroup><col style="width:79%"><col style="width:21%"></colgroup>\n<tr>\n' +
    '<td class="cierre-obs">' + bloqueObservaciones_() + '</td>\n' +
    '<td class="cierre-qr">' +
      '<div class="qr-tarjeta">' +
        '<h3>¿Deseas recotizar tu viaje?</h3>' +
        '<p>Escanea el código QR y solicita una nueva cotización de forma rápida y sencilla.</p>' +
        '<p class="qr-nota">(Máximo 5 días hábiles antes del inicio del viaje)</p>' +
        '<img alt="Código QR para recotizar" src="' + ASSETS.QR_COTIZAR + '">' +
      '</div>' +
    '</td>\n' +
    '</tr>\n</table>\n';
}

function bloqueObservaciones_() {
  return '<div class="obs">\n' +
    '<h3>Observaciones</h3>\n' +
    '<ol>\n' +
    '<li>La presente es únicamente una COTIZACIÓN, POR LO QUE NO SURTE NINGÚN EFECTO LEGAL COMO PÓLIZA DE SEGURO</li>\n' +
    '<li>La presente propuesta tiene un máximo de 10 DÍAS NATURALES a partir de la fecha y hora de cotización, ' +
    'en caso de la aceptación de la misma, deberá sujetarse a las condiciones y políticas vigentes de Seguros Atlas.</li>\n' +
    '<li>En caso de existir una cotización anterior o póliza emitida vigente, esta cotización quedará sin efecto alguno.</li>\n' +
    '</ol>\n' +
    '<p>El alcance, términos, condiciones, exclusiones y limitantes de las coberturas cotizadas se encuentran en ' +
    'las condiciones generales que se le entregarán al momento de la contratación de la póliza, las cuales también ' +
    'podrá obtener de forma gratuita en nuestra página web ' +
    '<a href="https://www.segurosatlas.com.mx/Descargas.html">www.segurosatlas.com.mx/Descargas.html</a></p>\n' +
    '<p>En Seguros Atlas S.A. sus datos están protegidos. Consulte el aviso de privacidad en ' +
    '<a href="https://www.segurosatlas.com.mx">www.segurosatlas.com.mx</a></p>\n' +
    '<p>Nota : El Impuesto al Valor Agregado se calcula de conformidad con el artículo 1 de LIVA.</p>\n' +
    '</div>\n';
}

/**
 * Pie institucional repartido en cuatro segmentos separados por filetes
 * verticales, que es el mismo reparto que produciría justify-content:
 * space-between sin depender de flexbox.
 */
function bloquePie_() {
  return '<table class="pie" role="presentation">\n' +
    '<colgroup><col style="width:19%"><col style="width:29%"><col style="width:26%"><col style="width:26%"></colgroup>\n' +
    '<tr>\n' +
    '<td>Seguros Atlas S.A</td>\n' +
    '<td class="sep">Paseo de los Tamarindos 60 Planta Baja<br>T. 55 9177-5000</td>\n' +
    '<td class="sep">Col. Bosques de las Lomas<br>' +
    '<a href="https://www.segurosatlas.com.mx">www.segurosatlas.com.mx</a></td>\n' +
    '<td class="sep">Ciudad de México C.P.05120<br>segurodeviaje@segurosatlas.com.mx</td>\n' +
    '</tr>\n</table>\n';
}

// ============================================================================
// 5. CUERPO HTML DEL CORREO
// ============================================================================
// Tablas y CSS inline: Outlook (escritorio y web) ignora <style> en <head>,
// flexbox y grid.

/**
 * Etiqueta de nomenclatura para el asunto del correo y el nombre del PDF
 * adjunto (solo en solicitudes aprobadas):
 * "Cotización Seguro de Viaje Senior +79 - <fecha de salida> // <días del
 * viaje>D, <destino> <fecha de envío>"
 * Ej.: "Cotización Seguro de Viaje Senior +79 - 25082026 // 011D, BRA 13082026"
 */
function construirNomenclatura_(data) {
  const fechaInicioFormato = data.fechaInicio.replace(/\//g, ''); // dd/MM/yyyy -> ddMMyyyy
  const diasFormato = String(data.duracionDias).padStart(2, '0') + 'D';
  const destinoFormato = data.destino.toString().trim().substring(0, 3).toUpperCase();
  const fechaEnvioFormato = data.fechaEmision.split(' ')[0].replace(/\//g, ''); // dd/MM/yyyy HH:mm:ss -> ddMMyyyy

  return 'Cotización Seguro de Viaje Senior +79 - ' + fechaInicioFormato + ' // ' +
    diasFormato + ', ' + destinoFormato + ' ' + fechaEnvioFormato;
}

/**
 * Nombre del PDF adjunto: misma nomenclatura que el asunto, pero sin '/'
 * —OneDrive/SharePoint no lo permiten en nombres de archivo— reemplazado
 * por un guion.
 */
function construirNombreArchivoPdf_(data) {
  return construirNomenclatura_(data).replace(' // ', ' - ') + '.pdf';
}

function construirAsunto_(data) {
  if (data.estatus === CONFIG.ESTATUS.APROBADO) {
    return construirNomenclatura_(data);
  }
  return 'Solicitud de cotización no procesada';
}

/**
 * Franja verde superior: título y bajada a la izquierda, logotipo a la
 * derecha. Se reparte con una tabla de dos celdas porque Outlook ignora
 * flexbox; el logo lleva max-width para no desbordar en pantallas chicas.
 */
function encabezadoCorreo_(titulo) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ' +
    'style="background-color:' + COLORES.VERDE + ';border-collapse:collapse;">' +
    '<tr>' +
      '<td align="left" valign="middle" style="padding:14px 10px 14px 18px;">' +
        '<div style="font-size:17px;font-weight:bold;color:#ffffff;font-family:\'Aptos Display\',Arial,sans-serif;">' +
          escaparHtml_(titulo) + '</div>' +
        '<div style="font-size:11px;color:#cfe6da;margin-top:3px;font-family:\'Aptos Display\',Arial,sans-serif;">' +
          'Emitido por Seguro de Viaje - Dirección de Negocios Especiales (DINE)</div>' +
      '</td>' +
      '<td align="right" valign="middle" style="padding:14px 18px 14px 10px;width:130px;">' +
        '<img src="' + escaparHtml_(CONFIG.URL_LOGO_CORREO) + '" alt="Seguros Atlas" width="120" ' +
        'style="display:block;width:120px;max-width:100%;height:auto;border:0;margin-left:auto;">' +
      '</td>' +
    '</tr></table>';
}

/** Despedida más la firma corporativa. */
function pieCorreo_() {
  return '<p style="margin:12px 0 16px 0;">Saludos.</p>' +
    firmaCorreo_();
}

/**
 * Firma institucional del área. El bloque de datos va en texto (no como
 * imagen) para que siga siendo legible aunque el cliente de correo bloquee
 * la descarga de imágenes; solo el gráfico del aniversario es un <img>.
 */
function firmaCorreo_() {
  const linea = (contenido) =>
    '<div style="font-size:12px;line-height:1.45;color:#333333;' +
    'font-family:\'Aptos Display\',Arial,sans-serif;">' + contenido + '</div>';

  return '<table role="presentation" cellpadding="0" cellspacing="0" ' +
    'style="border-collapse:collapse;border-top:1px solid ' + COLORES.BORDE + ';padding-top:12px;">' +
    '<tr><td style="padding:12px 0 0 0;">' +
      '<div style="font-size:14px;font-weight:bold;color:' + COLORES.AZUL + ';' +
        'font-family:\'Aptos Display\',Arial,sans-serif;">Seguro de Viaje</div>' +
      '<div style="font-size:12px;color:#666666;margin-bottom:8px;' +
        'font-family:\'Aptos Display\',Arial,sans-serif;">DINE (Dirección de Negocios Especiales)</div>' +
      linea('<strong>Tel.</strong> (55) 9177 &ndash; 5000 Ext. 4931') +
      linea('<strong>Correo.</strong> <a href="mailto:segurodeviaje@segurosatlas.com.mx" ' +
        'style="color:' + COLORES.VERDE + ';">segurodeviaje@segurosatlas.com.mx</a>') +
      linea('AV. Paseo de los Tamarindos No. 60 INT. PB, C.P. 05120') +
      linea('Col. Bosques de las Lomas, Ciudad de México') +
      '<img src="' + escaparHtml_(CONFIG.URL_FIRMA_CORREO) + '" alt="85 Aniversario Seguros Atlas" ' +
      'width="260" style="display:block;width:260px;max-width:100%;height:auto;border:0;margin-top:12px;">' +
    '</td></tr></table>';
}

/** Línea discreta de cierre, fuera del marco del mensaje. */
function avisoPrivacidadCorreo_() {
  return '<div style="text-align:center;font-size:10px;color:#a3a3a3;' +
    'font-family:\'Aptos Display\',Arial,sans-serif;padding:12px 10px 0;line-height:1.5;">' +
    '<a href="' + escaparHtml_(CONFIG.URL_AVISO_PRIVACIDAD) + '" style="color:#a3a3a3;">Aviso de Privacidad</a>' +
    ' &nbsp;--&nbsp; Contacto: ' +
    '<a href="mailto:segurodeviaje@segurosatlas.com.mx" style="color:#a3a3a3;">segurodeviaje@segurosatlas.com.mx</a>' +
    '</div>';
}

/** Fila etiqueta/valor de las tablas resumen (verde claro) del correo. */
function filaResumen_(etiqueta, valor) {
  return '<tr>' +
    '<td style="padding:5px 10px;border-bottom:1px solid ' + COLORES.BORDE + ';font-weight:bold;color:' + COLORES.AZUL + ';width:42%;">' +
      escaparHtml_(etiqueta) + '</td>' +
    '<td style="padding:5px 10px;border-bottom:1px solid ' + COLORES.BORDE + ';color:#333;">' +
      escaparHtml_(valor) + '</td>' +
    '</tr>';
}

function construirCorreoAprobado_(data) {
  const filaPlan = (plan, total) =>
    '<tr>' +
    '<td style="padding:7px 10px;border:1px solid ' + COLORES.BORDE + ';color:#333;">' + escaparHtml_(plan) + '</td>' +
    '<td style="padding:7px 10px;border:1px solid ' + COLORES.BORDE + ';text-align:right;font-weight:bold;color:#333;">' +
      formatearMoneda_(total) + ' USD</td>' +
    '</tr>';

  return '' +
    '<div style="max-width:600px;margin:0 auto;font-family:\'Aptos Display\',Arial,sans-serif;font-size:11pt;color:#222;">' +
      encabezadoCorreo_('Cotización Seguro de Viaje SENIOR +79') +
      '<div style="padding:18px;border:1px solid ' + COLORES.BORDE + ';border-top:none;">' +

        '<p style="margin:8px 0 18px 0;">Estimado(a) ' + escaparHtml_(data.nombreSolicitante) + ':</p>' +
        '<p style="margin:0 0 16px 0;">Adjunto encontraras la cotización correspondiente en tu solicitud. ' +
        'A continuación el resumen</p>' +

        '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ' +
        'style="border-collapse:collapse;background-color:' + COLORES.VERDE_CLARO + ';margin-bottom:18px;">' +
          filaResumen_('Folio', data.folio) +
          filaResumen_('Destino', data.destino) +
          filaResumen_('Fechas del viaje', data.fechaInicio + ' al ' + data.fechaFin) +
          filaResumen_('Duración del viaje', data.duracionDias + ' días') +
          filaResumen_('Asegurados', String(data.numAsegurados) + ' — ' + data.listaAsegurados) +
          filaResumen_('Vigencia de esta cotización', data.vigenciaCotizacion) +
        '</table>' +

        '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin-bottom:8px;">' +
          '<tr>' +
            '<th style="padding:7px 10px;border:1px solid ' + COLORES.BORDE + ';background-color:' + COLORES.VERDE + ';color:#ffffff;text-align:left;font-size:11pt;">Plan</th>' +
            '<th style="padding:7px 10px;border:1px solid ' + COLORES.BORDE + ';background-color:' + COLORES.VERDE + ';color:#ffffff;text-align:right;font-size:11pt;">' +
              '<span style="display:block;font-weight:normal;font-size:9pt;color:#e3f1ef;margin-bottom:2px;">Prima Neta por (' +
              data.numAsegurados + ' ' + (data.numAsegurados === 1 ? 'asegurado' : 'asegurados') + ') + IVA en USD</span>' +
              'Prima total' +
            '</th>' +
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
      avisoPrivacidadCorreo_() +
    '</div>';
}

/**
 * Correo de rechazo. Siempre lleva la información completa del viaje en el
 * resumen (folio, destino, fechas, duración), sin importar el motivo.
 *
 * El aviso ámbar de pasajeros excluidos (construirAvisoExcluidos_) solo se
 * agrega cuando SÍ hubo al menos un asegurado elegible en otras filas de la
 * solicitud —o sea, nunca en RECHAZADO_SIN_ELEGIBLES—: si ningún pasajero
 * calificó, el motivo de rechazo ya lo explica con nombres y edades, y
 * repetirlo en un segundo bloque es redundante.
 */
function construirCorreoRechazo_(data) {
  const motivo = data.estatus === CONFIG.ESTATUS.RECHAZADO_TIEMPO
    ? motivoRechazoTiempo_(data)
    : motivoRechazoSinElegibles_(data);

  const avisoExcluidos = data.estatus === CONFIG.ESTATUS.RECHAZADO_SIN_ELEGIBLES
    ? ''
    : construirAvisoExcluidos_(data.pasajerosExcluidos);

  return '' +
    '<div style="max-width:600px;margin:0 auto;font-family:\'Aptos Display\',Arial,sans-serif;font-size:11pt;color:#222;">' +
      encabezadoCorreo_('Solicitud de cotización no procesada') +
      '<div style="padding:18px;border:1px solid ' + COLORES.BORDE + ';border-top:none;">' +

        '<p style="margin:8px 0 18px 0;">Estimado(a) ' + escaparHtml_(data.nombreSolicitante) + ':</p>' +

        '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ' +
        'style="border-collapse:collapse;background-color:' + COLORES.ROJO_FONDO + ';border-left:4px solid ' + COLORES.ROJO_BORDE + ';margin-bottom:18px;">' +
          '<tr><td style="padding:12px 14px;">' + motivo + '</td></tr>' +
        '</table>' +

        avisoExcluidos +
        pieCorreo_() +
      '</div>' +
      avisoPrivacidadCorreo_() +
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

/**
 * Motivo de rechazo por edad. Se apoya en textoExcluidosPorEdad_ para el
 * detalle de cada pasajero: como este es el único bloque del correo que
 * explica el rechazo (ver construirCorreoRechazo_, que omite el aviso
 * ámbar redundante en este caso), tiene que bastarse solo.
 */
function motivoRechazoSinElegibles_(data) {
  return '<p style="margin:0 0 10px 0;">Su solicitud para el destino <strong>' + escaparHtml_(data.destino) + '</strong> ' +
    'no pudo ser procesada porque ningún pasajero indicado se encuentra dentro del rango de edad del ' +
    '<strong>Producto Senior</strong> (' + textoRangoEdad_() + ').</p>' +
    textoExcluidosPorEdad_(data.pasajerosExcluidos);
}

/**
 * Separa a los pasajeros excluidos según por qué quedaron fuera: los
 * menores a la edad mínima sí tienen alternativa (portal de agentes); los
 * mayores a la edad máxima no se pueden asegurar por políticas de
 * suscripción, así que no llevan ninguna llamada a la acción.
 */
function agruparExcluidosPorMotivo_(pasajerosExcluidos) {
  const lista = pasajerosExcluidos || [];
  return {
    menores: lista.filter((p) => p.motivo === 'MENOR'),
    mayores: lista.filter((p) => p.motivo === 'MAYOR'),
    sinDato: lista.filter((p) => p.motivo === 'SIN_DATO')
  };
}

function listaPasajerosTexto_(lista) {
  return lista.map((p) => escaparHtml_(p.nombre) + (p.edad !== null ? ' (' + p.edad + ' años)' : '')).join(', ');
}

/**
 * Texto explicativo de pasajeros excluidos por edad, agrupado por motivo.
 * Devuelve cadena vacía si no hubo exclusiones.
 */
function textoExcluidosPorEdad_(pasajerosExcluidos) {
  if (!pasajerosExcluidos || pasajerosExcluidos.length === 0) return '';
  const grupos = agruparExcluidosPorMotivo_(pasajerosExcluidos);
  let texto = '';

  if (grupos.menores.length > 0) {
    texto += '<p style="margin:0 0 8px 0;">Para el/los pasajero(s) <strong>' + listaPasajerosTexto_(grupos.menores) +
      '</strong>, menores a ' + textoEdadMinima_() + ': favor de ingresar al portal de agentes donde podrán ' +
      'cotizar y emitir directamente en la siguiente liga: ' +
      '<a href="' + escaparHtml_(CONFIG.URL_PORTAL_AGENTES) + '" style="color:' + COLORES.VERDE + ';">' +
      escaparHtml_(CONFIG.URL_PORTAL_AGENTES) + '</a> o contacte a su ejecutivo.</p>';
  }

  if (grupos.mayores.length > 0) {
    texto += '<p style="margin:0 0 8px 0;">Para el/los pasajero(s) <strong>' + listaPasajerosTexto_(grupos.mayores) +
      '</strong>, mayores a ' + textoEdadMaxima_() + ': por políticas de suscripción ya no es posible brindar ' +
      'una propuesta.</p>';
  }

  if (grupos.sinDato.length > 0) {
    texto += '<p style="margin:0;">No fue posible validar la edad de <strong>' + listaPasajerosTexto_(grupos.sinDato) +
      '</strong>: verifique la fecha de nacimiento capturada.</p>';
  }

  return texto;
}

/**
 * Aviso ámbar de pasajeros fuera del rango de edad elegible. Devuelve
 * cadena vacía si no hubo exclusiones, para no dejar un bloque huérfano en
 * el correo.
 */
function construirAvisoExcluidos_(pasajerosExcluidos) {
  if (!pasajerosExcluidos || pasajerosExcluidos.length === 0) return '';

  return '' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ' +
    'style="border-collapse:collapse;background-color:' + COLORES.AMBAR_FONDO + ';border-left:4px solid ' + COLORES.AMBAR_BORDE + ';margin-bottom:18px;">' +
      '<tr><td style="padding:12px 14px;">' +
        '<strong style="color:' + COLORES.AMBAR_TEXTO + ';">Aviso importante</strong><br>' +
        textoExcluidosPorEdad_(pasajerosExcluidos) +
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
    // Nombre del PDF que recibe el cliente (misma nomenclatura que el
    // asunto, sin '/'); no confundir con nombreArchivoDrive, el respaldo interno.
    nombreArchivo: aprobado ? construirNombreArchivoPdf_(data) : '',

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
    const archivoHtml = guardarHtmlEnDrive_(htmlCotizacion, data.nombreArchivoDrive);
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
 * @param {Array=} pasajeros       Lista {nombre, edad}; edad en años completos exactos
 *                                 a la fecha de salida (se genera la fecha de nacimiento
 *                                 correspondiente). Por defecto 2 elegibles + 1 excluido.
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

  // Folio sintético con el mismo formato que ya produce la fórmula real de
  // la hoja: SEGURO_VIAJE_+79-<días de viaje>D-<destino 3 letras>-<salida DDMMYYYY>.
  const diasViajePrueba = Math.round((regreso - salida) / msPorDia) + 1;
  const p2 = (n) => String(n).padStart(2, '0');
  const folioPrueba = 'SEGURO_VIAJE_+79-' + diasViajePrueba + 'D-BRA-' +
    p2(salida.getDate()) + p2(salida.getMonth() + 1) + salida.getFullYear();

  const encabezados = [
    CONFIG.COL_PERFIL,
    CONFIG.COL_AGENTE_INFO,
    CONFIG.COL_NOMBRE_SOLICITANTE,
    CONFIG.COL_EMAIL_CLIENTE,
    CONFIG.COL_CORREO_CC,
    CONFIG.COL_DESTINO,
    CONFIG.COL_FECHA_INICIO,
    CONFIG.COL_FECHA_FIN,
    CONFIG.COL_FOLIO,
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
    folioPrueba,
    45.5, 65, 95, 125
  ];

  lista.forEach((pasajero, indice) => {
    const fechaNacimiento = new Date(salida.getFullYear() - pasajero.edad, salida.getMonth(), salida.getDate());
    encabezados.push('Nombre Asegurado ' + (indice + 1));
    valores.push(pasajero.nombre);
    encabezados.push('Fecha de Nacimiento Asegurado ' + (indice + 1));
    valores.push(fechaNacimiento);
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

/**
 * Procesa en lote filas pegadas directo en la hoja (no pasan por el
 * formulario, así que nunca disparan onFormSubmit). Reutiliza el mismo
 * trigger fila por fila.
 *
 * Se salta las filas ya marcadas en COL_ESTADO, para poder correrla varias
 * veces sobre la misma hoja sin reenviar folios ya procesados; y aísla el
 * error de cada fila para que una sola solicitud mal capturada no detenga
 * el resto del lote.
 */
function procesarPegadoMasivo() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const encabezados = leerEncabezados_(sheet);
  const indiceEstado = indiceDe_(encabezados, CONFIG.COL_ESTADO);
  const ultimaFila = sheet.getLastRow();

  for (let fila = 2; fila <= ultimaFila; fila++) {
    const valores = sheet.getRange(fila, 1, 1, sheet.getLastColumn()).getValues()[0];
    if (valores.every((valor) => valor === '' || valor === null)) continue; // fila vacía

    if (indiceEstado !== -1 && valores[indiceEstado]) continue; // ya procesada

    try {
      const data = construirDatosSolicitud_(fila, encabezados, valores);
      procesarSolicitud_(data);
      marcarEstadoFila_(sheet, fila, encabezados, data.estatus + ' — enviado a Power Automate');
    } catch (error) {
      Logger.log('❌ Fila ' + fila + ': ' + error.message);
      marcarEstadoFila_(sheet, fila, encabezados, 'ERROR: ' + error.message);
    }
  }
}
