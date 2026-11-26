/**
 * ============================================================================
 * PROPUESTA DE SEGURO DE VIAJE SENIOR +79 — Seguros Atlas · Seguro de Viaje
 * ============================================================================
 * Apps Script concentra TODA la regla de negocio y el armado de documentos.
 * Power Automate queda como emisor: recibe el cuerpo del correo ya renderizado
 * y el HTML de la propuesta listo para convertir a PDF, y lo envía desde el
 * buzón compartido segurodeviaje@segurosatlas.com.mx.
 *
 * FLUJO
 *   1) Trigger "Al enviar el formulario" -> se lee la fila exacta.
 *   2) Se filtran los asegurados elegibles (de 79 años 11 meses a 89 años
 *      11 meses, calculado desde su fecha de nacimiento respecto a la fecha
 *      de salida del viaje) y se registran los excluidos.
 *   3) Se validan las fechas (regreso posterior a la salida), la anticipación
 *      mínima (5 días hábiles) y el máximo de 5 asegurados.
 *   4) Si procede, se genera el HTML de la propuesta (1 página, tamaño carta)
 *      y se guarda en Drive con codificación UTF-8 explícita. La vigencia es
 *      la fecha de envío + 3 días hábiles (72 horas hábiles).
 *   5) Se construye el cuerpo HTML del correo (aprobación o rechazo).
 *   6) Se dispara el webhook a Power Automate, que adjunta el PDF de la
 *      propuesta y envía el correo.
 *
 * SOLICITUD DE EMISIÓN: la propuesta aprobada lleva un QR (PDF) y un botón
 * (correo) al formulario de solicitud de emisión, prellenado con folio,
 * destino y fechas (ver CONFIG.PREFILL_EMISION y proceso-emision/).
 *
 * ESTATUS POSIBLES
 *   APROBADO                     Pasa todas las validaciones; lleva adjuntos.
 *   RECHAZADO_FECHAS             La fecha de regreso no es posterior a la salida.
 *   RECHAZADO_TIEMPO             Menos de 5 días hábiles antes de la salida.
 *   RECHAZADO_SIN_ELEGIBLES      Ningún pasajero cae en el rango de edad elegible.
 *   RECHAZADO_EXCESO_ASEGURADOS  Más de 5 asegurados elegibles en una solicitud.
 *   (Se evalúan en ese orden; el primero que aplica define el estatus.)
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
 * DEPENDENCIAS: ASSETS_BASE64.gs (logos y QR de nueva propuesta en base64) y
 * QR_GENERADOR.gs (genera el QR de emisión de cada propuesta).
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
  // Vigencia de la propuesta: la fecha de envío + VIGENCIA_DIAS_HABILES (72
  // horas hábiles). El script del formulario de emisión usa el mismo valor
  // para rechazar solicitudes fuera de vigencia: si se cambia aquí,
  // cambiarlo también en CONFIG_EMISION.VIGENCIA.DIAS_HABILES_DESDE_ENVIO.
  VIGENCIA_DIAS_HABILES: 3,
  // Posiciones de asegurado que se leen del formulario, y máximo de
  // asegurados elegibles por propuesta (el formato de emisión grupal solo
  // tiene lugar para 5). Se leen todas las posiciones para poder rechazar
  // una solicitud con más de 5 en vez de cortarla en silencio.
  COLUMNAS_ASEGURADOS: 10,
  MAX_ASEGURADOS: 5,

  // Formulario de propuestas. El QR de "nueva propuesta" del PDF se genera
  // aquí mismo (QR_GENERADOR.gs) con esta URL, sin depender de me-qr.com.
  URL_NUEVA_PROPUESTA: 'https://docs.google.com/forms/d/e/1FAIpQLSfPedluEXJ32DFHxBjCRddBUzMgjsgK5OnwfZPluPuR6XHycw/viewform',

  // Formulario "Solicitud de Emisión de Póliza de Seguro de Viaje". Cada
  // propuesta aprobada lleva un QR (en el PDF) y un botón (en el correo) que
  // abren este formulario con los datos de la propuesta ya escritos.
  URL_FORMULARIO_EMISION: 'https://docs.google.com/forms/d/e/1FAIpQLSdOqmheMAPxTjV9Hc41Xras9M-C3UjGi2z2jl3tZ_fEg_YQ7Q/viewform',
  /**
   * Identificadores "entry.NNNN" de las preguntas que se prellenan. Salen del
   * enlace prellenado del formulario (Editar formulario > ⋮ > Obtener enlace
   * prellenado). Si uno queda vacío, esa pregunta simplemente no se prellena.
   */
  PREFILL_EMISION: {
    FOLIO: 'entry.1124603788',        // "Folio de la propuesta"
    DESTINO: 'entry.697166036',       // "Destino"
    FECHA_SALIDA: 'entry.831370938',  // "Fecha de Salida"
    FECHA_REGRESO: 'entry.11076833'   // "Fecha de Regreso"
  },

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
    RECHAZADO_SIN_ELEGIBLES: 'RECHAZADO_SIN_ELEGIBLES',
    RECHAZADO_FECHAS: 'RECHAZADO_FECHAS',
    RECHAZADO_EXCESO_ASEGURADOS: 'RECHAZADO_EXCESO_ASEGURADOS'
  },

  // --- Mapeo de columnas (fila 1 de la hoja de respuestas) ---
  COL_PERFIL: 'Perfil',
  COL_AGENTE_INFO: 'Escribe tu Clave y Nombre de Agente Completo',
  // Otros títulos que ha tenido o puede tener esa pregunta.
  COL_AGENTE_ALTERNOS: [
    'Escribe tu Clave y Nombre de Agente',
    'Clave y Nombre de Agente Completo',
    'Clave y Nombre de Agente',
    'Clave y nombre del agente',
    'Agente'
  ],
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
  // Columna opcional donde se escribe el folio definitivo (el de la hoja +
  // consecutivo). Si no existe, el folio igual queda en "Estado de envío".
  COL_FOLIO_PROPUESTA: 'Folio de propuesta',

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
  ROJO_BORDE: '#d9534f',
  FONDO_CORREO: '#f3f4f3'
};

// Fuente de los correos. Entre comillas simples porque va dentro de
// atributos style="..." (comillas dobles).
const FUENTE_CORREO = "'Aptos Display',Arial,sans-serif";

// Ancho máximo de la tarjeta del correo en computadora, en px. En pantallas
// más angostas (teléfono) la tarjeta se ajusta al ancho disponible.
const ANCHO_CORREO = 850;

// Letra del texto corrido del correo después del resumen (avisos,
// indicaciones, recuadros, "Saludos."). El saludo, la introducción y las
// tablas de resumen y primas se quedan en 11pt.
const TEXTO_CUERPO_CORREO = 'font-size:10.5pt;line-height:1.4;font-family:' + FUENTE_CORREO + ';';

// Distancia del borde exterior de cualquier recuadro o tabla del correo al
// inicio del texto, en px. Una sola medida para que todo quede alineado.
const SANGRIA_RECUADRO = 14;

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
    registrarFolioFila_(sheet, fila, encabezados, data.folio);
    marcarEstadoFila_(sheet, fila, encabezados, data.estatus + ' — folio ' + data.folio + ' — enviado a Power Automate');
  } catch (error) {
    Logger.log('Error en onFormSubmit (fila ' + fila + '): ' + error.message);
    marcarEstadoFila_(sheet, fila, encabezados, 'ERROR: ' + error.message);
    throw error;
  }
}

/**
 * Bifurca según el estatus. Las solicitudes rechazadas no generan propuesta
 * ni adjunto: solo el correo formal con el motivo.
 */
function procesarSolicitud_(data) {
  asignarFolioUnico_(data);

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
  const buscado = normalizarEncabezado_(nombre);
  return encabezados.findIndex((e) => normalizarEncabezado_(e) === buscado);
}

/**
 * Encabezado comparable: sin mayúsculas, acentos, signos de interrogación,
 * dos puntos ni espacios de más. Así "¿Escribe tu clave y nombre de agente?"
 * y "Escribe tu Clave y Nombre de Agente Completo " se comparan bien.
 */
function normalizarEncabezado_(texto) {
  return String(texto === null || texto === undefined ? '' : texto)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[¿?¡!:]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Clave y nombre del agente. Se busca, en orden:
 *  1. la columna CONFIG.COL_AGENTE_INFO o uno de sus títulos alternos;
 *  2. columnas separadas de clave y nombre de agente, que se unen;
 *  3. cualquier otra columna cuyo título hable del agente (no "Perfil").
 * Si nada aparece, deja un aviso en el registro de ejecución.
 */
function leerAgente_(encabezados, valores) {
  const texto = (indice) => (indice === -1 ? '' : String(valores[indice] === null ? '' : valores[indice]).trim());
  for (const titulo of [CONFIG.COL_AGENTE_INFO].concat(CONFIG.COL_AGENTE_ALTERNOS)) {
    const valor = texto(indiceDe_(encabezados, titulo));
    if (valor) return valor;
  }
  const clave = texto(indiceDe_(encabezados, 'Clave de Agente'));
  const nombre = texto(indiceDe_(encabezados, 'Nombre de Agente'));
  if (clave || nombre) return [clave, nombre].filter((v) => v).join(' ');

  const indicePerfil = indiceDe_(encabezados, CONFIG.COL_PERFIL);
  for (let i = 0; i < encabezados.length; i++) {
    if (i === indicePerfil || !/agente/.test(normalizarEncabezado_(encabezados[i]))) continue;
    const valor = texto(i);
    if (valor) return valor;
  }
  Logger.log('⚠️ No encontré la columna del agente. Corre listarEncabezados() y ajusta CONFIG.COL_AGENTE_INFO.');
  return '';
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
  for (let i = 1; i <= CONFIG.COLUMNAS_ASEGURADOS; i++) {
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

  const vigenciaDate = calcularVigencia_(hoy);

  // --- Estatus ---
  // Las fechas invertidas se evalúan primero: si la fecha de regreso es
  // anterior a la de salida, los demás cálculos no tienen sentido.
  // Luego la anticipación, la elegibilidad de pasajeros y, al final, el
  // máximo de asegurados por propuesta.
  let estatus = CONFIG.ESTATUS.APROBADO;
  if (duracionDias <= 0) {
    estatus = CONFIG.ESTATUS.RECHAZADO_FECHAS;
  } else if (diasAnticipacion !== null && diasAnticipacion < CONFIG.DIAS_ANTICIPACION_MINIMA) {
    estatus = CONFIG.ESTATUS.RECHAZADO_TIEMPO;
  } else if (numAsegurados === 0) {
    estatus = CONFIG.ESTATUS.RECHAZADO_SIN_ELEGIBLES;
  } else if (numAsegurados > CONFIG.MAX_ASEGURADOS) {
    estatus = CONFIG.ESTATUS.RECHAZADO_EXCESO_ASEGURADOS;
  }
  const aprobado = estatus === CONFIG.ESTATUS.APROBADO;

  // --- Primas: solo se calculan si la solicitud procede ---
  const primaMaster = aprobado ? leerPrima_(valorOpcional_(encabezados, valores, CONFIG.COL_PRIMA_MASTER)) : 0;
  const primaSmart = aprobado ? leerPrima_(valorOpcional_(encabezados, valores, CONFIG.COL_PRIMA_SMART)) : 0;
  const primaElite = aprobado ? leerPrima_(valorOpcional_(encabezados, valores, CONFIG.COL_PRIMA_ELITE)) : 0;
  const primaPremium = aprobado ? leerPrima_(valorOpcional_(encabezados, valores, CONFIG.COL_PRIMA_PREMIUM)) : 0;

  // --- Datos del agente ---
  const perfil = valorOpcional_(encabezados, valores, CONFIG.COL_PERFIL).toString().trim();
  const agenteInfo = leerAgente_(encabezados, valores);
  // Se muestra siempre que haya un dato real (no vacío ni "NA"), sea agente o no.
  const mostrarAgente = agenteInfo !== '' && !/^(na|n\/a|no aplica)$/i.test(agenteInfo);

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
    // aaaa-MM-dd: el formato que acepta Google Forms para prellenar fechas.
    fechaInicioIso: formatearFechaIso_(inicioRaw),
    fechaFinIso: formatearFechaIso_(finRaw),
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
    nombreArchivoDrive: 'Propuesta_' + folio + '.html',
    cuerpoCorreoHtml: ''
  };
}

/**
 * Días hábiles (lunes a viernes, sin contemplar festivos) entre hoy y la
 * fecha de salida: cuenta los días hábiles posteriores a hoy hasta el día
 * de salida inclusive. Ej.: solicitud el lunes con salida el lunes
 * siguiente = 5 días hábiles.
 * Ambas fechas se normalizan a medianoche para que la hora de envío del
 * formulario no altere la cuenta. Negativo si la salida ya pasó; null si
 * no hay fecha de salida válida.
 */
function calcularDiasAnticipacion_(hoy, fechaSalida) {
  if (!fechaSalida) return null;
  const salida = fechaSalida instanceof Date ? fechaSalida : new Date(fechaSalida);
  if (isNaN(salida.getTime())) return null;

  const hoyMedianoche = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  const salidaMedianoche = new Date(salida.getFullYear(), salida.getMonth(), salida.getDate());
  const signo = salidaMedianoche >= hoyMedianoche ? 1 : -1;
  const desde = signo === 1 ? hoyMedianoche : salidaMedianoche;
  const hasta = signo === 1 ? salidaMedianoche : hoyMedianoche;

  let habiles = 0;
  const dia = new Date(desde.getTime());
  while (dia < hasta) {
    dia.setDate(dia.getDate() + 1);
    const diaSemana = dia.getDay();
    if (diaSemana !== 0 && diaSemana !== 6) habiles++;
  }
  return signo * habiles;
}

/**
 * Mueve una fecha n días hábiles (lunes a viernes, sin contemplar
 * festivos) hacia adelante (n > 0) o hacia atrás (n < 0). Devuelve la
 * fecha resultante a medianoche.
 */
function sumarDiasHabiles_(fecha, n) {
  const resultado = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
  const paso = n >= 0 ? 1 : -1;
  let restantes = Math.abs(n);
  while (restantes > 0) {
    resultado.setDate(resultado.getDate() + paso);
    const diaSemana = resultado.getDay();
    if (diaSemana !== 0 && diaSemana !== 6) restantes--;
  }
  return resultado;
}

/** Vigencia de la propuesta: fecha de envío + VIGENCIA_DIAS_HABILES. */
function calcularVigencia_(hoy) {
  return sumarDiasHabiles_(hoy, CONFIG.VIGENCIA_DIAS_HABILES);
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

function formatearFechaIso_(valor) {
  const fecha = valor instanceof Date ? valor : new Date(valor);
  if (!valor || isNaN(fecha.getTime())) return '';
  return Utilities.formatDate(fecha, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * Liga al formulario de solicitud de emisión con folio, destino y fechas de
 * esta propuesta ya escritos (prellenado de Google Forms).
 */
function construirUrlEmision_(data) {
  const ids = CONFIG.PREFILL_EMISION;
  const valores = [
    [ids.FOLIO, data.folio],
    [ids.DESTINO, data.destino],
    [ids.FECHA_SALIDA, data.fechaInicioIso],
    [ids.FECHA_REGRESO, data.fechaFinIso]
  ].filter((par) => par[0] && par[1]);
  if (!valores.length) return CONFIG.URL_FORMULARIO_EMISION;
  return CONFIG.URL_FORMULARIO_EMISION + '?usp=pp_url&' + valores
    .map((par) => par[0] + '=' + encodeURIComponent(String(par[1]).trim()))
    .join('&');
}

/**
 * Código QR (data: URI) de la liga de emisión, generado localmente con
 * QR_GENERADOR.gs. Nivel de corrección L: la liga prellenada es larga y así
 * el código queda con módulos más grandes, más fácil de escanear impreso.
 * Lleva margen blanco de 4 módulos (lo que pide el estándar) y se imprime a
 * 88 px (~23 mm): con la liga prellenada completa se lee bien en papel.
 * Se entrega como PNG (Word Online, que convierte a PDF, lo maneja mejor que
 * GIF); si la conversión no está disponible, se queda en GIF.
 */
function qrDataUri_(texto) {
  const qr = qrcode(0, 'L');
  qr.addData(texto);
  qr.make();
  const gif = qr.createDataURL(4, 16);
  try {
    const blob = Utilities.newBlob(Utilities.base64Decode(gif.split(',')[1]), 'image/gif', 'qr.gif');
    return 'data:image/png;base64,' + Utilities.base64Encode(blob.getAs('image/png').getBytes());
  } catch (error) {
    return gif;
  }
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
  return '$' + numero.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
// 4. HTML DE LA PROPUESTA (1 PÁGINA, TAMAÑO CARTA) · DISEÑO 2026-11
// ============================================================================

/**
 * Réplica del diseño "Propuesta Seguro Senior +79 años (rediseño)" (HTML de
 * 816 x 1056 px). Mismos colores, tamaños, burbujas y textos; la única
 * diferencia es que la columna de coberturas es más ancha, para que los
 * conceptos no se partan en dos renglones y todo quepa en una hoja carta.
 *
 * Todo se arma con tablas y <colgroup>, nunca con flex ni grid: el motor de
 * conversión HTML->PDF de OneDrive/Word los ignora. Las imágenes y la fuente
 * van como data: URI porque el convertidor no descarga recursos externos.
 * Títulos, planes y precios en Montserrat (ASSETS.FUENTE_MONTSERRAT); el
 * resto en Arial (el diseño usa Arimo, que mide igual).
 *
 * La hoja es una tabla de alto completo con dos celdas: arriba todo el
 * contenido hasta la nota legal ("Importante"); abajo, pegado al fondo, el
 * pie. El espacio que sobra queda en blanco entre la nota legal y el pie.
 */
const PDF = {
  VERDE: '#027370',
  VERDE_OSCURO: '#024F4D',
  VERDE_TENUE: '#EEF4F1',
  VERDE_TITULO: '#0B3D3B',
  BORDE: '#C9DCD6',
  LINEA: '#DCE7E3',
  LINEA_PASO: '#BFD8D2',
  LINEA_PIE: '#9CC7C0',
  TEXTO: '#1E2B29',
  TEXTO_CLARO: '#CFE7E3',
  TEXTO_USD: '#D8EEEA'
};
const FUENTE_TITULOS_PDF = "Montserrat, Arial, Helvetica, sans-serif";

function generarHtmlCotizacion_(data) {
  return '<!DOCTYPE html>\n' +
    '<html lang="es">\n<head>\n<meta charset="UTF-8">\n' +
    '<title>Propuesta de Seguro ' + escaparHtml_(data.folio) + '</title>\n' +
    '<style>\n' + estilosCotizacion_() + '</style>\n</head>\n<body>\n' +
    '<table class="marco" role="presentation">\n' +
    '<tr><td class="marco-arriba">\n' +
      bloqueEncabezado_(data) +
      bloqueFicha_(data) +
      bloqueViaje_(data) +
      bloqueCoberturas_(data) +
      bloqueCierre_(data) +
      bloqueLegal_() +
    '</td></tr>\n' +
    '<tr><td class="marco-abajo">\n' +
      bloquePie_() +
    '</td></tr>\n' +
    '</table>\n</body>\n</html>';
}

function estilosCotizacion_() {
  const T = FUENTE_TITULOS_PDF;
  return '' +
    "@font-face { font-family: 'Montserrat'; font-style: normal; font-weight: 100 900;\n" +
    "             src: url(" + ASSETS.FUENTE_MONTSERRAT + ") format('woff2'); }\n" +
    '@page { size: letter; margin: 0; }\n' +
    '* { box-sizing: border-box; margin: 0; padding: 0; }\n' +
    'html, body { height: 100%; }\n' +
    'body { font-family: Arimo, Arial, Helvetica, sans-serif; font-size: 10px; color: ' + PDF.TEXTO + '; line-height: 1.35;\n' +
    '       background-color: #ffffff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }\n' +
    'table { border-collapse: collapse; width: 100%; }\n' +
    'a { color: ' + PDF.VERDE + '; font-weight: bold; text-decoration: underline; }\n' +
    '.marco { width: 100%; height: 100%; }\n' +
    '.marco-arriba { vertical-align: top; }\n' +
    '.marco-abajo { vertical-align: bottom; }\n' +
    '.lado { padding-left: 40px; padding-right: 40px; }\n' +

    // --- Encabezado ---
    '.enc { background-color: ' + PDF.VERDE + '; }\n' +
    '.enc td { padding: 12px 40px 10px; vertical-align: middle; color: #ffffff; }\n' +
    '.enc .kicker { font-family: ' + T + '; font-size: 11px; font-weight: 600; letter-spacing: .14em; color: ' + PDF.TEXTO_CLARO + '; }\n' +
    '.enc h1 { font-family: ' + T + '; font-size: 25px; font-weight: 800; letter-spacing: -.01em; color: #ffffff;\n' +
    '          line-height: 1.15; margin: 6px 0 6px; }\n' +
    '.enc .vig { background-color: #ffffff; color: ' + PDF.VERDE + '; font-size: 11px; font-weight: bold;\n' +
    '            border-radius: 999px; padding: 3px 10px; }\n' +
    '.enc td.logo { text-align: right; }\n' +
    '.enc td.logo img { height: 54px; width: auto; }\n' +

    // --- Ficha (folio, emisión, solicitante, agente) ---
    '.ficha-fondo { background-color: ' + PDF.VERDE_TENUE + '; padding: 6px 40px; }\n' +
    '.ficha { border-collapse: separate; border-spacing: 0 5px; margin: -5px 0; }\n' +
    '.ficha td { font-size: 10.5px; vertical-align: middle; line-height: 1.35; }\n' +
    '.ficha td.et { font-weight: bold; }\n' +
    '.ficha td.val { background-color: #ffffff; border-radius: 999px; padding: 2px 12px; white-space: nowrap; }\n' +

    // --- Datos del viaje ---
    '.viaje { margin-top: 10px; border-collapse: separate; border-spacing: 0; border: 1px solid ' + PDF.BORDE + '; border-radius: 12px; }\n' +
    '.viaje td { padding: 4px 14px; vertical-align: top; border-right: 1px solid ' + PDF.LINEA + '; }\n' +
    '.viaje td.ult { border-right: none; }\n' +
    '.viaje .et { font-size: 10px; font-weight: bold; letter-spacing: .08em; color: ' + PDF.VERDE + '; }\n' +
    '.viaje .val { font-family: ' + T + '; font-size: 14px; font-weight: 700; white-space: nowrap; }\n' +
    '.viaje .val.destino { font-size: 15px; font-weight: 800; color: ' + PDF.VERDE + '; }\n' +

    // --- Planes y coberturas ---
    '.cob { margin-top: 10px; border-collapse: collapse; table-layout: fixed; font-size: 10px; line-height: 1.15; }\n' +
    '.cob td { padding: 1.2px 8px; border-bottom: 1px solid ' + PDF.LINEA + '; vertical-align: middle; }\n' +
    '.cob td.n { text-align: right; white-space: nowrap; }\n' +
    '.cob tr.s td { background-color: ' + PDF.VERDE_TENUE + '; font-weight: bold; color: ' + PDF.VERDE_TITULO + '; border-bottom: 1px solid ' + PDF.BORDE + '; }\n' +
    '.cob td.l { padding-left: 22px; color: ' + PDF.TEXTO + '; }\n' +
    '.cob .i { color: ' + PDF.VERDE + '; font-weight: bold; }\n' +
    '.cob small { display: block; font-size: 9px; color: ' + PDF.VERDE + '; font-weight: normal; }\n' +
    '.cob td.cab { padding: 0 8px 5px 0; border-bottom: 2px solid ' + PDF.VERDE + '; vertical-align: bottom; }\n' +
    '.cob td.cab-plan { padding: 0 0 5px 4px; border-bottom: 2px solid ' + PDF.VERDE + '; vertical-align: bottom; }\n' +
    '.cob .pd { font-family: ' + T + '; font-size: 12px; font-weight: 800; color: ' + PDF.VERDE + '; letter-spacing: .04em; line-height: 1.15; }\n' +
    '.cob .pd-sub { font-size: 9.5px; color: ' + PDF.VERDE + '; margin-top: 2px; }\n' +
    '.plan { color: #ffffff; border-radius: 10px 10px 0 0; padding: 5px 4px; text-align: center; }\n' +
    '.plan.p1 { background-color: ' + PDF.VERDE + '; }\n' +
    '.plan.p2 { background-color: ' + PDF.VERDE_OSCURO + '; }\n' +
    '.plan .nom { font-family: ' + T + '; font-size: 10.5px; font-weight: 700; white-space: nowrap; }\n' +
    '.plan .precio { font-family: ' + T + '; font-size: 16px; font-weight: 800; margin-top: 1px; }\n' +
    '.plan .usd { font-size: 9px; color: ' + PDF.TEXTO_USD + '; }\n' +
    '.nota-prima { margin: 5px 0 0; background-color: ' + PDF.VERDE + '; color: #ffffff; border-radius: 8px; padding: 4px 12px;\n' +
    '              font-size: 10.5px; font-weight: bold; text-align: center; }\n' +

    // --- Cierre: especificaciones y pasos ---
    '.cierre { border-collapse: separate; border-spacing: 0; font-size: 10px; line-height: 1.35; }\n' +
    '.cierre td.c-esp { border: 1px solid ' + PDF.BORDE + '; border-radius: 12px; padding: 10px 12px; vertical-align: middle; }\n' +
    '.cierre td.c-pasos { vertical-align: top; }\n' +
    '.h2 { font-family: ' + T + '; font-size: 12px; font-weight: 800; color: ' + PDF.VERDE + '; letter-spacing: .04em; margin: 0 0 7px; }\n' +
    '.ul td { vertical-align: top; padding: 0 0 4px; }\n' +
    '.ul td.vin { width: 14px; color: ' + PDF.VERDE + '; font-size: 7px; padding-top: 2px; }\n' +
    '.num-fila td { vertical-align: middle; padding: 0; }\n' +
    '.num { width: 22px; height: 22px; border-radius: 11px; background-color: ' + PDF.VERDE + '; color: #ffffff; text-align: center;\n' +
    '       font-family: ' + T + '; font-size: 11px; font-weight: 800; line-height: 22px; }\n' +
    '.num-linea { padding: 0 0 0 6px !important; }\n' +
    '.num-linea div { height: 2px; background-color: ' + PDF.LINEA_PASO + '; font-size: 1px; line-height: 2px; }\n' +
    '.pasos td.paso { vertical-align: top; }\n' +
    '.paso-tit { font-family: ' + T + '; font-size: 11.5px; font-weight: 800; color: ' + PDF.VERDE_TITULO + '; margin: 6px 0 3px; }\n' +
    '.paso-qr { width: 66px; text-align: right; vertical-align: top; padding: 0; }\n' +
    '.paso-qr img { width: 62px; height: 62px; display: block; margin-left: auto; }\n' +
    '.nota-72 { background-color: ' + PDF.VERDE_TENUE + '; border-radius: 999px; padding: 4px 12px; font-weight: bold; color: ' + PDF.VERDE + '; margin-top: 6px; }\n' +
    '.tarjetas { margin-top: 6px; border-collapse: separate; border-spacing: 0; }\n' +
    '.tarjeta { border: 1px solid ' + PDF.BORDE + '; border-radius: 12px; padding: 7px 11px; vertical-align: top; }\n' +
    '.tarjeta.nueva { border: 1.5px solid ' + PDF.VERDE + '; background-color: ' + PDF.VERDE_TENUE + '; vertical-align: middle; }\n' +
    '.tarjeta .tt { font-family: ' + T + '; font-size: 11px; font-weight: 800; color: ' + PDF.VERDE + '; margin-bottom: 4px; }\n' +
    '.tarjeta .txt { font-size: 9.5px; margin-bottom: 4px; }\n' +
    '.tarjeta .correo { color: ' + PDF.VERDE + '; font-weight: bold; }\n' +
    '.pares td { padding: 0.5px 6px 0.5px 0; vertical-align: middle; }\n' +
    '.lab { width: 54px; font-size: 9px; font-weight: bold; letter-spacing: .08em; color: ' + PDF.VERDE + '; }\n' +
    '.qr-blanco { background-color: #ffffff; padding: 4px; border-radius: 6px; }\n' +
    '.qr-blanco img { width: 58px; height: 58px; display: block; }\n' +

    // --- Nota legal y pie ---
    '.legal { margin: 6px 0 0; font-size: 9px; line-height: 1.35; color: ' + PDF.TEXTO + '; }\n' +
    '.pie { margin-top: 8px; margin-bottom: 10px; font-size: 10px; line-height: 1.35; color: ' + PDF.TEXTO + '; }\n' +
    '.pie td { vertical-align: top; padding: 0 10px; border-right: 1px solid ' + PDF.LINEA_PIE + '; }\n' +
    '.pie td.ult { border-right: none; padding-right: 0; }\n';
}

/** Franja verde: "Seguro de Viaje · Propuesta", título, vigencia y logo. */
function bloqueEncabezado_(data) {
  return '<table class="enc" role="presentation">\n<tr>\n' +
    '<td>' +
      '<div class="kicker">SEGURO DE VIAJE · PROPUESTA</div>' +
      '<h1>Seguro Senior +79 años</h1>' +
      '<div><span class="vig">Vigente hasta el ' + escaparHtml_(data.vigenciaCotizacion) + '</span></div>' +
    '</td>\n' +
    '<td class="logo"><img alt="Seguros Atlas · La empresa a mi medida" src="' + ASSETS.LOGO_PROPUESTA + '"></td>\n' +
    '</tr>\n</table>\n';
}

/** Franja gris: folio, emisión, solicitante y agente, cada dato en su burbuja blanca. */
function bloqueFicha_(data) {
  const par = (etiqueta, valor) => valor
    ? '<td class="et">' + escaparHtml_(etiqueta) + '</td><td class="val">' + escaparHtml_(valor) + '</td>'
    : '<td class="et"></td><td></td>';
  const emision = String(data.fechaEmision || '').replace(' ', ' · ');
  const agente = data.mostrarAgente ? data.agenteInfo : '';

  return '<div class="ficha-fondo">\n' +
    '<table class="ficha" role="presentation">\n' +
    '<colgroup><col style="width:76px"><col><col style="width:24px"><col style="width:66px"><col></colgroup>\n' +
    '<tr>' + par('Folio', data.folio) + '<td></td>' + par('Emisión', emision) + '</tr>\n' +
    '<tr>' + par('Solicitante', data.nombreSolicitante) + '<td></td>' + par('Agente', agente) + '</tr>\n' +
    '</table>\n</div>\n';
}

/** Recuadro redondeado con destino, fechas, duración y asegurados. */
function bloqueViaje_(data) {
  const celda = (etiqueta, valor, clase, ultima) =>
    '<td' + (ultima ? ' class="ult"' : '') + '><div class="et">' + etiqueta + '</div>' +
    '<div class="val' + (clase ? ' ' + clase : '') + '">' + escaparHtml_(valor) + '</div></td>';
  return '<div class="lado">\n<table class="viaje" role="presentation">\n' +
    '<colgroup><col style="width:23.8%"><col style="width:38.1%"><col style="width:19.05%"><col style="width:19.05%"></colgroup>\n<tr>' +
      celda('DESTINO(S)', data.destino, 'destino') +
      celda('VIAJE', data.fechaInicio + ' → ' + data.fechaFin) +
      celda('DURACIÓN', data.duracionDias + ' días') +
      celda('ASEGURADOS', data.numAsegurados + (data.numAsegurados === 1 ? ' persona' : ' personas'), '', true) +
    '</tr>\n</table>\n</div>\n';
}

/**
 * Planes disponibles: burbujas con la prima total de cada plan y, debajo, las
 * coberturas (principales resaltadas, sub-límites con sangría) y la barra
 * verde con el número de asegurados cotizados.
 */
function bloqueCoberturas_(data) {
  const totales = [data.totalMaster, data.totalSmart, data.totalElite, data.totalPremium];
  const encabezados = PLANES.map((plan, i) =>
    '<td class="cab-plan"><div class="plan ' + (i % 2 === 0 ? 'p1' : 'p2') + '">' +
      '<div class="nom">' + escaparHtml_(plan) + '</div>' +
      '<div class="precio">' + formatearMoneda_(totales[i]) + '</div>' +
      '<div class="usd">USD · prima + IVA</div>' +
    '</div></td>').join('');

  const filas = COBERTURAS.map((cobertura) => {
    const esPrincipal = /^[IVXLCDM]+\.\s/.test(cobertura.concepto);
    const celdas = cobertura.valores.map((valor, columna) => {
      const nota = cobertura.nota && cobertura.nota[columna]
        ? '<small>' + escaparHtml_(cobertura.nota[columna]) + '</small>'
        : '';
      return '<td class="n' + (valor === 'Incluido' ? ' i' : '') + '">' + escaparHtml_(valor) + nota + '</td>';
    }).join('');
    return '<tr' + (esPrincipal ? ' class="s"' : '') + '><td' + (esPrincipal ? '' : ' class="l"') + '>' +
      escaparHtml_(cobertura.concepto) + '</td>' + celdas + '</tr>';
  }).join('\n');

  return '<div class="lado">\n<table class="cob">\n' +
    '<colgroup><col style="width:34%"><col style="width:16.5%"><col style="width:16.5%"><col style="width:16.5%"><col style="width:16.5%"></colgroup>\n' +
    '<tr><td class="cab"><div class="pd">PLANES DISPONIBLES</div>' +
      '<div class="pd-sub">Coberturas y sumas aseguradas en USD</div></td>' + encabezados + '</tr>\n' +
    filas + '\n</table>\n' +
    '<p class="nota-prima">Prima neta + IVA por ' + data.numAsegurados + ' ' +
      (data.numAsegurados === 1 ? 'asegurado cotizado' : 'asegurados cotizados') + '</p>\n</div>\n';
}

/** Especificaciones a la izquierda; "Emite tu póliza en 3 pasos" a la derecha. */
function bloqueCierre_(data) {
  return '<div class="lado" style="padding-top:10px;">\n<table class="cierre" role="presentation">\n' +
    '<colgroup><col style="width:250px"><col style="width:18px"><col></colgroup>\n<tr>\n' +
    '<td class="c-esp">' + bloqueEspecificaciones_() + '</td>\n<td></td>\n' +
    '<td class="c-pasos">' + bloquePasos_(data) + '</td>\n' +
    '</tr>\n</table>\n</div>\n';
}

function bloqueEspecificaciones_() {
  const punto = (html) => '<tr><td class="vin">&#9670;</td><td>' + html + '</td></tr>';
  return '<div class="h2">ESPECIFICACIONES</div>\n' +
    '<table class="ul" role="presentation">\n' +
      punto('<b>Edad de aceptación:</b> de ' + textoRangoEdad_() + '.') +
      punto('<b>Asegurados:</b> mexicanos o extranjeros residentes en México.') +
      punto('<b>Cobertura:</b> desde las 00:00 hrs del inicio hasta las 23:59 hrs de la culminación del viaje.') +
      punto('<b>Sin deducibles ni coaseguros.</b>') +
      punto('<b>Territorialidad:</b> México y el extranjero, excepto Afganistán, Bielorrusia, Crimea, Zaporizhzhia, ' +
        'Kherson, Donetsk, Luhansk, Irán, Israel, Corea del Norte, Rusia, Siria, Venezuela o cualquier país en conflicto ' +
        'al momento de solicitar la propuesta.') +
    '</table>\n';
}

/**
 * Los 3 pasos (círculo y línea, título y texto; el tercero con el QR de
 * emisión prellenada), la nota de 72 hrs y las tarjetas de factura y de
 * nueva propuesta.
 */
function bloquePasos_(data) {
  const urlEmision = escaparHtml_(construirUrlEmision_(data));
  const urlNueva = escaparHtml_(CONFIG.URL_NUEVA_PROPUESTA);
  const cabeza = (n, conLinea) => '<table class="num-fila" role="presentation"><tr>' +
    '<td class="num" width="22" align="center">' + n + '</td>' +
    (conLinea ? '<td class="num-linea"><div>&nbsp;</div></td>' : '<td></td>') + '</tr></table>';
  const paso = (n, titulo, cuerpo, conLinea) =>
    '<td class="paso">' + cabeza(n, conLinea) + '<div class="paso-tit">' + titulo + '</div>' + cuerpo + '</td>';

  return '<div class="h2" style="margin:0 0 6px;">EMITE TU PÓLIZA EN 3 PASOS</div>\n' +
    '<table class="pasos" role="presentation">\n' +
    '<colgroup><col><col style="width:14px"><col><col style="width:14px"><col></colgroup>\n<tr>\n' +
      paso(1, 'Revisa tu propuesta', '<div>Confirma que tus datos sean correctos y legibles.</div>', true) + '<td></td>\n' +
      paso(2, 'Ten a la mano', '<div>&#10003; Esta propuesta aceptada<br>&#10003; CSF actualizada<br>&#10003; INE o pasaporte</div>', true) + '<td></td>\n' +
      paso(3, 'Solicita tu emisión',
        '<table role="presentation"><tr>' +
          '<td style="vertical-align:top;padding-right:8px;">Escanea el QR o <a href="' + urlEmision + '">da clic aquí</a>.</td>' +
          '<td class="paso-qr"><a href="' + urlEmision + '"><img alt="QR para solicitar la emisión de tu póliza" src="' +
            qrDataUri_(construirUrlEmision_(data)) + '"></a></td>' +
        '</tr></table>', false) + '\n' +
    '</tr>\n</table>\n' +
    '<div class="nota-72">Tienes ' + (CONFIG.VIGENCIA_DIAS_HABILES * 24) + ' hrs hábiles para solicitar tu emisión ' +
      'a partir de que recibes esta propuesta.</div>\n' +
    '<table class="tarjetas" role="presentation">\n' +
    '<colgroup><col><col style="width:10px"><col></colgroup>\n<tr>\n' +
    '<td class="tarjeta">' +
      '<div class="tt">¿Requieres factura?</div>' +
      '<div class="txt">Envía tu CSF antes de emitir a <span class="correo">constanciafiscal@segurosatlas.com.mx</span></div>' +
      '<table class="pares" role="presentation">' +
        '<tr><td class="lab">ASUNTO</td><td><b>RFC DEL CONTRATANTE</b></td></tr>' +
        '<tr><td class="lab">MENSAJE</td><td>En blanco, sin firma</td></tr>' +
        '<tr><td class="lab">ADJUNTO</td><td><b>CONSTANCIA + RFC (PDF)</b></td></tr>' +
      '</table>' +
    '</td>\n<td></td>\n' +
    '<td class="tarjeta nueva">' +
      '<table role="presentation"><tr>' +
        '<td style="vertical-align:middle;padding-right:10px;">' +
          '<div class="tt" style="margin-bottom:3px;">¿Quieres una nueva propuesta?</div>' +
          '<div>Escanea el QR o <a href="' + urlNueva + '">da clic aquí</a>.</div>' +
          '<div style="font-weight:bold;margin-top:3px;">Mínimo ' + CONFIG.DIAS_ANTICIPACION_MINIMA + ' días hábiles antes del viaje.</div>' +
        '</td>' +
        '<td style="width:66px;vertical-align:middle;"><div class="qr-blanco"><a href="' + urlNueva + '">' +
          '<img alt="QR para solicitar una nueva propuesta" src="' + qrDataUri_(CONFIG.URL_NUEVA_PROPUESTA) + '"></a></div></td>' +
      '</tr></table>' +
    '</td>\n' +
    '</tr>\n</table>\n';
}

/** Nota legal: propuesta sin efecto de póliza, condiciones generales, privacidad e IVA. */
function bloqueLegal_() {
  return '<div class="lado"><p class="legal"><b>Importante:</b> este documento es solo una propuesta y no surte efecto como póliza. ' +
    'Queda sin efecto si existe una propuesta anterior o póliza vigente. Coberturas, exclusiones y límites en las condiciones ' +
    'generales: <a href="https://www.segurosatlas.com.mx/descargas.html">segurosatlas.com.mx/descargas.html</a>. ' +
    'Aviso de privacidad en <a href="https://www.segurosatlas.com.mx">segurosatlas.com.mx</a>. ' +
    'IVA conforme al art. 1 de la LIVA.</p></div>\n';
}

/** Pie institucional en cuatro columnas separadas por filetes. */
function bloquePie_() {
  return '<div class="lado">\n<table class="pie" role="presentation">\n' +
    '<colgroup><col style="width:17%"><col style="width:29%"><col style="width:24%"><col style="width:30%"></colgroup>\n<tr>\n' +
    '<td style="text-align:right;">Seguros Atlas S.A.</td>\n' +
    '<td style="text-align:right;">Paseo de los Tamarindos 60 Planta Baja<br>T. (55) 9177 - 5000</td>\n' +
    '<td style="text-align:center;">Col. Bosques de las Lomas<br>www.segurosatlas.com.mx</td>\n' +
    '<td class="ult" style="text-align:left;">Ciudad de México CP. 05120<br>segurodeviaje@segurosatlas.com.mx</td>\n' +
    '</tr>\n</table>\n</div>\n';
}

// ============================================================================
// 5. CUERPO HTML DEL CORREO
// ============================================================================
// Tablas y CSS inline: Outlook (escritorio y web) ignora <style> en <head>,
// flexbox y grid.

/**
 * Etiqueta de nomenclatura para el asunto del correo y el nombre del PDF
 * adjunto (solo en solicitudes aprobadas):
 * "Propuesta Seguro de Viaje Senior +79 - <fecha de salida> // <días del
 * viaje>D, <destino> <fecha de envío>"
 * Ej.: "Propuesta Seguro de Viaje Senior +79 - 25082026 // 11D, BRA 13082026"
 */
function construirNomenclatura_(data) {
  const fechaInicioFormato = data.fechaInicio.replace(/\//g, ''); // dd/MM/yyyy -> ddMMyyyy
  const diasFormato = String(Math.max(0, data.duracionDias)).padStart(2, '0') + 'D';
  const destinoFormato = data.destino.toString().trim().substring(0, 3).toUpperCase();
  const fechaEnvioFormato = data.fechaEmision.split(' ')[0].replace(/\//g, ''); // dd/MM/yyyy HH:mm:ss -> ddMMyyyy

  return 'Propuesta Seguro de Viaje Senior +79 - ' + fechaInicioFormato + ' // ' +
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
  return 'Solicitud de Propuesta de Seguro no procesada';
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
      '<td align="left" valign="middle" style="padding:14px 10px 14px 19px;">' +
        '<div style="font-size:21px;font-weight:bold;color:#ffffff;font-family:\'Aptos Display\',Arial,sans-serif;">' +
          escaparHtml_(titulo) + '</div>' +
        '<div style="font-size:11px;color:#cfe6da;margin-top:3px;font-family:\'Aptos Display\',Arial,sans-serif;">' +
          'Seguro de Viaje</div>' +
      '</td>' +
      '<td align="right" valign="middle" style="padding:14px 18px 14px 10px;width:130px;">' +
        '<img src="' + escaparHtml_(CONFIG.URL_LOGO_CORREO) + '" alt="Seguros Atlas" width="120" ' +
        'style="display:block;width:120px;max-width:100%;height:auto;border:0;margin-left:auto;">' +
      '</td>' +
    '</tr></table>';
}

/** Despedida más la firma corporativa. */
function pieCorreo_() {
  return '<p style="margin:20px 0 0 0;' + TEXTO_CUERPO_CORREO + '">Saludos.</p>' +
    espaciador_(32) +
    firmaCorreo_();
}

/**
 * Fecha y hora de la solicitud, en gris, debajo de la firma (igual que en
 * los correos de la solicitud de emisión). fechaEmision = 'dd/MM/yyyy HH:mm:ss'.
 */
function pieFechaCorreo_(data) {
  return '<div style="margin-top:14px;font-size:9pt;color:#888888;font-family:' + FUENTE_CORREO + ';">' +
    'Fecha de solicitud: ' + escaparHtml_(String(data.fechaEmision || '').slice(0, 16)) + ' hrs</div>';
}

/**
 * Firma institucional del área. El bloque de datos va en texto (no como
 * imagen) para que siga siendo legible aunque el cliente de correo bloquee
 * la descarga de imágenes; solo el gráfico del aniversario es un <img>.
 */
function firmaCorreo_() {
  const linea = (contenido) =>
    '<div style="font-size:10pt;line-height:1.5;color:#222222;font-family:' + FUENTE_CORREO + ';">' +
    contenido + '</div>';

  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">' +
    '<tr><td bgcolor="' + COLORES.GRIS_TABLA + '" style="padding:14px 16px 14px 14px;background-color:' + COLORES.GRIS_TABLA + ';">' +
      '<div style="font-size:12pt;font-weight:bold;color:' + COLORES.VERDE + ';font-family:' + FUENTE_CORREO + ';">' +
        'Seguro de Viaje</div>' +
      '<div style="font-size:10pt;color:#222222;margin-bottom:14px;font-family:' + FUENTE_CORREO + ';">' +
        'DINE (Dirección de Negocios Especiales)</div>' +
      linea('<strong>Tel.</strong> (55) 9177 &ndash; 5000 Ext. 5114') +
      linea('<strong>Correo:</strong> <a href="mailto:segurodeviaje@segurosatlas.com.mx" ' +
        'style="color:' + COLORES.VERDE + ';">segurodeviaje@segurosatlas.com.mx</a>') +
    '</td></tr></table>' +
    '<div style="padding:10px 0 0 0;font-size:9pt;line-height:1.4;color:#8a8a8a;font-family:' + FUENTE_CORREO + ';">' +
      'Av. Paseo de los Tamarindos No. 60 INT. PB, C.P. 05120<br>Col. Bosques de las Lomas, Ciudad de México</div>' +
    '<img src="' + escaparHtml_(CONFIG.URL_FIRMA_CORREO) + '" alt="85 Aniversario Seguros Atlas" ' +
    'width="260" style="display:block;width:260px;max-width:100%;height:auto;border:0;margin-top:6px;">';
}

/** Barra verde de cierre dentro de la tarjeta, debajo del contenido. */
function barraPieCorreo_() {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">' +
    '<tr><td bgcolor="' + COLORES.VERDE + '" align="center" style="padding:14px 18px;background-color:' + COLORES.VERDE + ';' +
      'color:#ffffff;font-size:9pt;line-height:1.5;text-align:center;font-family:' + FUENTE_CORREO + ';">' +
      'Este correo es enviado por Seguro de Viaje de Seguros Atlas.<br>' +
      'Si tienes alguna duda contacta con tu ejecutivo asignado.' +
    '</td></tr></table>';
}

/**
 * Lista con viñetas o numerada armada con tabla (una fila por elemento):
 * Outlook desktop aplica sangrías impredecibles a <ul>/<ol>, y así la
 * sangría francesa queda igual en todos los clientes.
 *
 * La tabla y sus celdas llevan el mismo fondo que el recuadro que la
 * contiene, y el interlineado va en px exactos: con pantallas escaladas
 * (125%, 150%) Outlook deja ver líneas blancas entre filas si no.
 */
function listaCorreo_(elementos, fondo, numerada) {
  const celda = 'padding:2px 0;font-size:10.5pt;mso-line-height-rule:exactly;line-height:20px;color:#222222;' +
    'background-color:' + fondo + ';font-family:' + FUENTE_CORREO + ';';
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="' + fondo + '" ' +
    'style="border-collapse:collapse;background-color:' + fondo + ';">' +
    elementos.map((elemento, i) =>
      '<tr>' +
        '<td valign="top" bgcolor="' + fondo + '" style="width:18px;' + celda + '">' +
          (numerada ? (i + 1) + '.' : '&bull;') + '</td>' +
        '<td valign="top" bgcolor="' + fondo + '" style="' + celda + '">' + elemento + '</td>' +
      '</tr>'
    ).join('') +
    '</table>';
}

/**
 * Recuadro de instrucciones: título con ícono, texto y lista. Con borde
 * izquierdo de color si se indica; si no, borde fino alrededor.
 */
function recuadroCorreo_(icono, titulo, contenidoHtml, fondo, bordeIzquierdo) {
  // El texto queda siempre a SANGRIA_RECUADRO del borde exterior, tenga
  // franja de color de 4px o borde fino de 1px.
  const borde = bordeIzquierdo
    ? 'border-left:4px solid ' + bordeIzquierdo + ';padding-left:' + (SANGRIA_RECUADRO - 4) + 'px;'
    : 'border:1px solid ' + COLORES.BORDE + ';padding-left:' + (SANGRIA_RECUADRO - 1) + 'px;';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">' +
    '<tr><td bgcolor="' + fondo + '" style="padding:14px 16px;background-color:' + fondo + ';' + borde +
      'font-size:10.5pt;line-height:1.4;color:#222222;font-family:' + FUENTE_CORREO + ';">' +
      '<div style="font-size:11pt;font-weight:bold;margin-bottom:4px;font-family:' + FUENTE_CORREO + ';">' +
        icono + '&nbsp; ' + titulo + '</div>' +
      contenidoHtml +
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

/**
 * Fila vacía de altura fija para separar dos tablas consecutivas del correo.
 * El margin-bottom de un <table> no es confiable en Outlook de escritorio
 * (motor Word): la separación real solo se respeta como celda con altura
 * explícita y contenido (&nbsp;), nunca como espacio en blanco vacío.
 */
/**
 * Botón a prueba de Outlook: celda con fondo y enlace con padding (Outlook
 * ignora el padding y el fondo de un <a> suelto).
 */
function botonCorreo_(texto, url) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">' +
    '<tr><td bgcolor="' + COLORES.VERDE + '" style="background-color:' + COLORES.VERDE + ';border-radius:4px;' +
      'padding:9px 22px;mso-padding-alt:9px 22px;">' +
      '<a href="' + escaparHtml_(url) + '" style="color:#ffffff;text-decoration:none;font-weight:bold;' +
        'font-size:11pt;font-family:' + FUENTE_CORREO + ';display:inline-block;">' + escaparHtml_(texto) + '</a>' +
    '</td></tr></table>';
}

function espaciador_(altura) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
    '<tr><td style="height:' + altura + 'px;line-height:' + altura + 'px;font-size:1px;">&nbsp;</td></tr>' +
    '</table>';
}

/**
 * Envoltura del correo: fondo gris a todo lo ancho con la tarjeta centrada
 * encima. La tarjeta es fluida (width 100% con max-width ANCHO_CORREO):
 * en computadora mide ANCHO_CORREO y en el teléfono se ajusta al ancho de
 * la pantalla.
 *
 * Outlook de escritorio (motor de Word) ignora max-width y estiraría la
 * tarjeta a toda la ventana, así que para él va una tabla "fantasma" de
 * ancho fijo dentro de comentarios condicionales [if mso], que solo
 * Outlook interpreta.
 *
 * El centrado lo hace la celda de la tabla externa al 100%, no align en la
 * tabla del correo: en el motor de Word, align en una tabla actúa como
 * float y empuja al costado lo que Outlook/Exchange agregue después (p. ej.
 * el disclaimer legal). bgcolor como atributo porque Outlook ignora a veces
 * el background-color en CSS.
 */
function envolverCorreo_(contenidoHtml) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    'bgcolor="' + COLORES.FONDO_CORREO + '" style="width:100%;background-color:' + COLORES.FONDO_CORREO + ';">' +
    '<tr><td align="center" style="padding:24px 10px;">' +
      '<!--[if mso]><table role="presentation" width="' + ANCHO_CORREO + '" cellpadding="0" cellspacing="0" border="0">' +
      '<tr><td><![endif]-->' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
      'style="width:100%;max-width:' + ANCHO_CORREO + 'px;margin:0 auto;">' +
      '<tr><td align="left" style="font-family:' + FUENTE_CORREO + ';font-size:11pt;color:#222;">' +
        contenidoHtml +
      '</td></tr></table>' +
      '<!--[if mso]></td></tr></table><![endif]-->' +
    '</td></tr></table>';
}

/** Fila etiqueta/valor de las tablas resumen (verde claro) del correo. */
function filaResumen_(etiqueta, valor) {
  return '<tr>' +
    '<td style="padding:5px 14px;border-bottom:1px solid ' + COLORES.BORDE + ';font-weight:bold;color:' + COLORES.AZUL + ';' +
      'width:42%;font-size:11pt;font-family:\'Aptos Display\',Arial,sans-serif;">' +
      escaparHtml_(etiqueta) + '</td>' +
    '<td style="padding:5px 14px;border-bottom:1px solid ' + COLORES.BORDE + ';color:#333;' +
      'font-size:11pt;font-family:\'Aptos Display\',Arial,sans-serif;">' +
      escaparHtml_(valor) + '</td>' +
    '</tr>';
}

/**
 * Correo de la propuesta aprobada (diseño "mailing_propuesta_senior79",
 * 2026-11): encabezado verde con destino y días, resumen, planes, aviso de
 * pasajeros fuera de edad (solo si hay), los 3 recuadros para solicitar la
 * emisión y pie verde oscuro con la fecha de solicitud. Tablas y estilos en
 * línea para Outlook; las esquinas redondeadas son un extra.
 */
function construirCorreoAprobado_(data) {
  const C = { VERDE: '#0e6765', OSCURO: '#0a4f4d', TENUE: '#eef6f5', BORDE: '#cfe3e1', LINEA: '#e1eeed',
    FONDO: '#edf3f2', TEXTO: '#1f2d27', SUAVE: '#5b6e64', CUERPO: '#2f3f37' };
  const plural = data.numAsegurados === 1 ? 'asegurado' : 'asegurados';
  const fila = (etiqueta, valorHtml, ultima, extra) =>
    '<tr><td style="padding:11px 14px;background-color:' + C.TENUE + ';color:' + C.SUAVE + ';width:42%;vertical-align:top;' +
      (ultima ? '' : 'border-bottom:1px solid ' + C.LINEA + ';') + '">' + etiqueta + '</td>' +
    '<td style="padding:11px 14px;font-weight:bold;' + (ultima ? '' : 'border-bottom:1px solid ' + C.LINEA + ';') +
      (extra || '') + '">' + valorHtml + '</td></tr>';
  const plan = (nombre, total, sombreado) => {
    const fondo = sombreado ? 'background-color:' + C.TENUE + ';' : '';
    return '<tr><td style="padding:13px 14px;border-bottom:1px solid ' + C.LINEA + ';' + fondo + 'font-weight:bold;">' + nombre + '</td>' +
      '<td align="right" style="padding:13px 14px;border-bottom:1px solid ' + C.LINEA + ';' + fondo + 'font-weight:bold;color:' + C.VERDE + ';">' +
      formatearMoneda_(total) + ' USD</td></tr>';
  };
  const recuadro = (contenido, fondo) =>
    '<tr><td style="padding:16px 32px 0 32px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ' + C.BORDE + ';' +
        'border-radius:8px;' + (fondo ? 'background-color:' + fondo + ';' : '') + '"' + (fondo ? ' bgcolor="' + fondo + '"' : '') + '>' +
      '<tr><td style="padding:18px 20px;font-size:14px;line-height:22px;color:' + C.CUERPO + ';">' + contenido + '</td></tr></table>' +
    '</td></tr>';
  const tituloRecuadro = (icono, texto) =>
    '<p style="margin:0 0 8px 0;font-size:16px;font-weight:bold;color:' + C.TEXTO + ';">' + icono + '&nbsp; ' + texto + '</p>';
  const circulo = (n, texto) =>
    '<tr><td width="30" valign="top" style="padding:4px 0;"><span style="display:inline-block;width:22px;height:22px;line-height:22px;' +
      'text-align:center;border-radius:11px;background-color:' + C.OSCURO + ';color:#ffffff;font-size:12px;font-weight:bold;">' + n + '</span></td>' +
    '<td style="padding:4px 0;">' + texto + '</td></tr>';
  const asegurados = data.numAsegurados + '<br><span style="font-weight:normal;">' +
    data.asegurados.map((a) => escaparHtml_(a.nombre) + ' (' + a.edad + ' años)').join('<br>') + '</span>';
  const urlEmision = construirUrlEmision_(data);
  const avisoExcluidos = data.pasajerosExcluidos && data.pasajerosExcluidos.length
    ? '<tr><td style="padding:20px 32px 4px 32px;">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fff7e6" ' +
          'style="background-color:#fff7e6;border-left:4px solid #e0a100;border-radius:6px;">' +
        '<tr><td style="padding:16px 18px;font-size:14px;line-height:22px;color:#4a3b12;">' +
          '<strong style="display:block;margin-bottom:4px;color:#7a5600;">Aviso importante</strong>' +
          textoExcluidosPorEdad_(data.pasajerosExcluidos) +
        '</td></tr></table></td></tr>'
    : '';

  return '<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:' + C.FONDO + ';">' +
      'Tu propuesta de Seguro de Viaje SENIOR +79 a ' + escaparHtml_(data.destino) + ' está lista. Vigente hasta el ' +
      escaparHtml_(data.vigenciaCotizacion) + '.</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + C.FONDO + '" ' +
      'style="background-color:' + C.FONDO + ';font-family:Arial,Helvetica,sans-serif;color:' + C.TEXTO + ';">' +
    '<tr><td align="center" style="padding:24px 12px;">' +
    '<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" ' +
      'style="width:100%;max-width:600px;background-color:#ffffff;border-radius:10px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">' +

      // Encabezado
      '<tr><td bgcolor="' + C.VERDE + '" style="background-color:' + C.VERDE + ';padding:16px 28px;">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
          '<td valign="middle">' +
            '<p style="margin:0 0 2px 0;font-size:11px;color:#c4e2e0;text-transform:uppercase;letter-spacing:1.5px;">Propuesta</p>' +
            '<h1 style="margin:0;font-size:20px;line-height:26px;color:#ffffff;font-weight:bold;">Seguro de Viaje SENIOR +79</h1>' +
            '<p style="margin:2px 0 0 0;font-size:13px;color:#dff0ef;">Destino: <strong style="color:#ffffff;">' +
              escaparHtml_(data.destino) + '</strong> &nbsp;·&nbsp; ' + data.duracionDias + ' días</p>' +
          '</td>' +
          '<td align="right" valign="middle" width="120"><img src="' + escaparHtml_(CONFIG.URL_LOGO_CORREO) + '" width="110" ' +
            'alt="Seguros Atlas" style="display:block;margin-left:auto;width:110px;height:auto;border:0;"></td>' +
        '</tr></table>' +
      '</td></tr>' +

      // Saludo
      '<tr><td style="padding:28px 32px 8px 32px;">' +
        '<p style="margin:0 0 12px 0;font-size:16px;line-height:24px;">¡Hola <strong>' + escaparHtml_(data.nombreSolicitante) +
          '</strong>, buen día!</p>' +
        '<p style="margin:0;font-size:15px;line-height:23px;color:#43554c;">En adjunto encontrarás la propuesta solicitada ' +
          'y las <strong>condiciones generales</strong> del producto.</p>' +
      '</td></tr>' +

      // Resumen
      '<tr><td style="padding:16px 32px 8px 32px;">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ' + C.BORDE + ';' +
          'border-radius:8px;font-size:14px;border-collapse:separate;">' +
          fila('Folio', escaparHtml_(data.folio), false, 'word-break:break-all;') +
          fila('Destino', escaparHtml_(String(data.destino).toUpperCase())) +
          fila('Fechas del viaje', escaparHtml_(data.fechaInicio) + ' al ' + escaparHtml_(data.fechaFin)) +
          fila('Duración del viaje', data.duracionDias + ' días') +
          fila('Asegurados', asegurados, false, 'line-height:21px;') +
          fila('Vigencia de esta propuesta', escaparHtml_(data.vigenciaCotizacion), true, 'color:#b3261e;') +
        '</table>' +
      '</td></tr>' +

      // Planes
      '<tr><td style="padding:24px 32px 6px 32px;">' +
        '<h2 style="margin:0 0 4px 0;font-size:18px;color:' + C.OSCURO + ';">Planes disponibles</h2>' +
        '<p style="margin:0 0 12px 0;font-size:13px;color:' + C.SUAVE + ';">Prima Neta por ' + data.numAsegurados + ' ' + plural +
          ' + IVA en USD</p>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:15px;border-collapse:separate;">' +
          '<tr><td bgcolor="' + C.OSCURO + '" style="padding:10px 14px;background-color:' + C.OSCURO + ';color:#ffffff;font-size:12px;' +
            'text-transform:uppercase;letter-spacing:1px;border-radius:6px 0 0 0;">Plan</td>' +
          '<td bgcolor="' + C.OSCURO + '" align="right" style="padding:10px 14px;background-color:' + C.OSCURO + ';color:#ffffff;font-size:12px;' +
            'text-transform:uppercase;letter-spacing:1px;border-radius:0 6px 0 0;">Prima total</td></tr>' +
          plan('Master', data.totalMaster, false) +
          plan('Master Smart', data.totalSmart, true) +
          plan('Master Elite', data.totalElite, false) +
          plan('Master Premium', data.totalPremium, true) +
        '</table>' +
        '<p style="margin:10px 0 0 0;font-size:12px;line-height:18px;color:#6b7d73;">Importes en dólares americanos (USD) para ' +
          data.numAsegurados + ' asegurado(s). Primas netas, sin IVA.</p>' +
      '</td></tr>' +

      avisoExcluidos +

      // Pasos
      '<tr><td style="padding:30px 32px 0 32px;">' +
        '<h2 style="margin:0;font-size:18px;color:' + C.OSCURO + ';">Para solicitar tu emisión sigue los siguientes pasos</h2>' +
      '</td></tr>' +
      recuadro(
        tituloRecuadro('&#128196;', 'Solicitud de Emisión') +
        '<p style="margin:0 0 8px 0;">Llena la solicitud de emisión en línea (también puedes escanear el código QR de la propuesta). Ten a la mano:</p>' +
        '<ul style="margin:0 0 16px 0;padding-left:20px;">' +
          '<li style="margin-bottom:4px;">Propuesta aceptada (el PDF adjunto a este correo).</li>' +
          '<li><strong>Obligatorio del contratante:</strong> Constancia de Situación Fiscal (CSF) actualizada e INE o pasaporte.</li>' +
        '</ul>' +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
          '<td bgcolor="' + C.VERDE + '" style="background-color:' + C.VERDE + ';border-radius:6px;">' +
          '<a href="' + escaparHtml_(urlEmision) + '" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:bold;' +
            'color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;">Solicitar emisión</a>' +
          '</td></tr></table>') +
      recuadro(
        tituloRecuadro('&#9888;&#65039;', 'Consideraciones Importantes') +
        '<ul style="margin:0;padding-left:20px;">' +
          '<li style="margin-bottom:4px;">Verifica que la información de los asegurados y del contratante sea correcta.</li>' +
          '<li style="margin-bottom:4px;">Tendrás hasta un máximo de <strong>' + (CONFIG.VIGENCIA_DIAS_HABILES * 24) + ' horas hábiles</strong> ' +
            'para solicitar tu emisión después de recibir la cotización.</li>' +
          '<li style="margin-bottom:4px;">Errores u omisiones una vez emitida tu póliza toman de <strong>3 a 5 días hábiles</strong> en ser atendidos.</li>' +
          '<li>Cualquier cambio en los días de viaje requiere una re-cotización.</li>' +
        '</ul>') +
      recuadro(
        tituloRecuadro('&#128195;', 'Registro de Constancia Fiscal') +
        '<p style="margin:0 0 10px 0;">En caso de requerir factura, antes de solicitar la emisión es indispensable registrar la ' +
          'Constancia de Situación Fiscal (CSF) enviando un correo a <a href="mailto:constanciafiscal@segurosatlas.com.mx" ' +
          'style="color:' + C.OSCURO + ';font-weight:bold;">constanciafiscal@segurosatlas.com.mx</a> con este formato estricto:</p>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;">' +
          circulo(1, '<strong>Asunto (mayúsculas):</strong> RFC DEL CONTRATANTE.') +
          circulo(2, '<strong>Contenido:</strong> completamente en blanco (sin firma, sin texto).') +
          circulo(3, '<strong>Archivo adjunto (PDF en mayúsculas):</strong> CONSTANCIA + RFC.') +
          circulo(4, '<strong>Confirmación:</strong> deberás recibir un correo de vuelta con el estatus de "Registro Exitoso".') +
        '</table>', C.TENUE) +

      '<tr><td style="padding:0 0 28px 0;font-size:0;line-height:0;">&nbsp;</td></tr>' +

      // Pie
      '<tr><td bgcolor="' + C.OSCURO + '" style="background-color:' + C.OSCURO + ';padding:20px 32px;font-size:12px;line-height:19px;color:#c4e2e0;">' +
        '<p style="margin:0 0 6px 0;">Fecha de solicitud: ' + escaparHtml_(String(data.fechaEmision || '').slice(0, 16)) + ' hrs</p>' +
        '<p style="margin:0 0 6px 0;">Este correo es enviado por Seguro de Viaje de Seguros Atlas. Si tienes alguna duda contacta con tu ejecutivo asignado.</p>' +
        '<p style="margin:0;"><a href="' + escaparHtml_(CONFIG.URL_AVISO_PRIVACIDAD) + '" style="color:#ffffff;">Aviso de Privacidad</a>' +
          ' &nbsp;·&nbsp; Contacto: <a href="mailto:segurodeviaje@segurosatlas.com.mx" style="color:#ffffff;">segurodeviaje@segurosatlas.com.mx</a></p>' +
      '</td></tr>' +

    '</table>' +
    '<!--[if mso]></td></tr></table><![endif]-->' +
    '</td></tr></table>';
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
  let motivo;
  if (data.estatus === CONFIG.ESTATUS.RECHAZADO_FECHAS) {
    motivo = motivoRechazoFechas_(data);
  } else if (data.estatus === CONFIG.ESTATUS.RECHAZADO_TIEMPO) {
    motivo = motivoRechazoTiempo_(data);
  } else if (data.estatus === CONFIG.ESTATUS.RECHAZADO_EXCESO_ASEGURADOS) {
    motivo = motivoRechazoExcesoAsegurados_(data);
  } else {
    motivo = motivoRechazoSinElegibles_(data);
  }

  const avisoExcluidos = (data.estatus === CONFIG.ESTATUS.RECHAZADO_SIN_ELEGIBLES ||
    data.estatus === CONFIG.ESTATUS.RECHAZADO_FECHAS)
    ? ''
    : construirAvisoExcluidos_(data.pasajerosExcluidos);

  return envolverCorreo_(
    encabezadoCorreo_('Solicitud de Propuesta de Seguro no procesada') +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">' +
    '<tr><td bgcolor="#ffffff" style="padding:18px;background-color:#ffffff;border:1px solid ' + COLORES.BORDE + ';border-top:none;">' +

      '<p style="margin:8px 0 16px 0;font-weight:bold;">¡Hola ' + escaparHtml_(data.nombreSolicitante) + ', buen día!</p>' +

      '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ' +
      'style="border-collapse:collapse;background-color:' + COLORES.ROJO_FONDO + ';border-left:4px solid ' + COLORES.ROJO_BORDE + ';">' +
        '<tr><td style="padding:12px 16px 12px ' + (SANGRIA_RECUADRO - 4) + 'px;' + TEXTO_CUERPO_CORREO + '">' + motivo + '</td></tr>' +
      '</table>' +
      espaciador_(20) +

      avisoExcluidos +
      pieCorreo_() + pieFechaCorreo_(data) +
    '</td></tr></table>' +
    barraPieCorreo_() +
    avisoPrivacidadCorreo_()
  );
}

function motivoRechazoTiempo_(data) {
  return '<p style="margin:0 0 14px 0;">Tu solicitud para el destino <strong>' + escaparHtml_(data.destino) + '</strong>, ' +
    'con fecha de salida el <strong>' + escaparHtml_(data.fechaInicio) + '</strong>, no pudo ser procesada porque fue ' +
    'recibida con <strong>' + data.diasAnticipacion + ' día(s) hábil(es) de anticipación</strong>.</p>' +
    '<p style="margin:0 0 14px 0;">Por políticas de <strong>Seguro de Viaje</strong>, las ' +
    'solicitudes de propuesta deben realizarse con un mínimo de <strong>' + CONFIG.DIAS_ANTICIPACION_MINIMA + ' días ' +
    'hábiles de anticipación</strong> al inicio del viaje. Este plazo permite validar la información, emitir la ' +
    'póliza y entregarla antes de la salida.</p>' +
    '<p style="margin:0;">Si las fechas de tu viaje lo permiten, te invitamos a enviar nuevamente tu solicitud ' +
    'respetando este plazo.</p>';
}

/**
 * Motivo de rechazo por exceso de asegurados: el formato de emisión grupal
 * admite hasta MAX_ASEGURADOS, así que se pide dividir la solicitud.
 */
function motivoRechazoExcesoAsegurados_(data) {
  return '<p style="margin:0 0 14px 0;">Tu solicitud para el destino <strong>' + escaparHtml_(data.destino) + '</strong> ' +
    'no pudo ser procesada porque incluye <strong>' + data.numAsegurados + ' asegurados</strong> dentro del rango ' +
    'de edad del <strong>Producto Senior</strong>.</p>' +
    '<p style="margin:0 0 14px 0;">Por políticas de <strong>Seguro de Viaje</strong>, cada propuesta admite un máximo ' +
    'de <strong>' + CONFIG.MAX_ASEGURADOS + ' asegurados</strong>.</p>' +
    '<p style="margin:0;">Te invitamos a dividir tu solicitud en grupos de hasta ' + CONFIG.MAX_ASEGURADOS + ' asegurados ' +
    'y enviar una solicitud por cada grupo.</p>';
}

/**
 * Motivo de rechazo por fechas de viaje invertidas (la fecha de regreso
 * es anterior o igual a la fecha de salida). Por políticas de Seguro de
 * Viaje, las fechas deben ser coherentes para poder cotizar.
 */
function motivoRechazoFechas_(data) {
  return '<p style="margin:0 0 14px 0;">Tu solicitud para el destino <strong>' + escaparHtml_(data.destino) + '</strong> ' +
    'no pudo ser procesada porque la <strong>fecha de regreso (' + escaparHtml_(data.fechaFin) + ')</strong> ' +
    'es anterior a la <strong>fecha de salida (' + escaparHtml_(data.fechaInicio) + ')</strong>.</p>' +
    '<p style="margin:0 0 14px 0;">Por políticas de <strong>Seguro de Viaje</strong>, la fecha de regreso debe ' +
    'ser posterior a la fecha de salida para poder generar una propuesta.</p>' +
    '<p style="margin:0;">Te invitamos a verificar las fechas y enviar nuevamente tu solicitud.</p>';
}

/**
 * Motivo de rechazo por edad. Se apoya en textoExcluidosPorEdad_ para el
 * detalle de cada pasajero: como este es el único bloque del correo que
 * explica el rechazo (ver construirCorreoRechazo_, que omite el aviso
 * ámbar redundante en este caso), tiene que bastarse solo.
 */
function motivoRechazoSinElegibles_(data) {
  return '<p style="margin:0 0 10px 0;">Tu solicitud para el destino <strong>' + escaparHtml_(data.destino) + '</strong> ' +
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
      escaparHtml_(CONFIG.URL_PORTAL_AGENTES) + '</a> o contacta a tu ejecutivo.</p>';
  }

  if (grupos.mayores.length > 0) {
    texto += '<p style="margin:0 0 8px 0;">Para el/los pasajero(s) <strong>' + listaPasajerosTexto_(grupos.mayores) +
      '</strong>, mayores a ' + textoEdadMaxima_() + ': por políticas de suscripción ya no es posible brindar ' +
      'una propuesta.</p>';
  }

  if (grupos.sinDato.length > 0) {
    texto += '<p style="margin:0;">No fue posible validar la edad de <strong>' + listaPasajerosTexto_(grupos.sinDato) +
      '</strong>: verifica la fecha de nacimiento capturada.</p>';
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
    'style="border-collapse:collapse;background-color:' + COLORES.AMBAR_FONDO + ';border-left:4px solid ' + COLORES.AMBAR_BORDE + ';">' +
      '<tr><td style="padding:12px 16px 12px ' + (SANGRIA_RECUADRO - 4) + 'px;' + TEXTO_CUERPO_CORREO + '">' +
        '<div style="font-size:12pt;font-weight:bold;color:' + COLORES.AMBAR_TEXTO + ';margin-bottom:6px;' +
          'font-family:' + FUENTE_CORREO + ';">Aviso importante</div>' +
        textoExcluidosPorEdad_(pasajerosExcluidos) +
      '</td></tr>' +
    '</table>' +
    espaciador_(20);
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
    Logger.log('✅ Propuesta guardada en Drive (' + htmlCotizacion.length + ' caracteres).');
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
 * Caso RECHAZADO_TIEMPO: salida en 2 días. No debe generar propuesta ni
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
 * Caso RECHAZADO_FECHAS: la fecha de regreso es anterior a la de salida.
 */
function testearRechazoFechas() {
  Logger.log('=== INICIO testearRechazoFechas() ===');
  try {
    const data = construirDatosPrueba_(20, null, -3);
    Logger.log('Estatus: ' + data.estatus + ' | salida ' + data.fechaInicio + ' | regreso ' + data.fechaFin);

    data.cuerpoCorreoHtml = construirCorreoRechazo_(data);
    Logger.log('Asunto: ' + construirAsunto_(data));

    enviarWebhookPowerAutomate_(null, data, '');
    Logger.log('✅ Webhook de rechazo enviado sin adjunto.');
  } catch (error) {
    Logger.log('❌ Error en testearRechazoFechas(): ' + error.message);
  }
  Logger.log('=== FIN testearRechazoFechas() ===');
}

/**
 * Caso RECHAZADO_EXCESO_ASEGURADOS: 6 asegurados elegibles, uno más que
 * CONFIG.MAX_ASEGURADOS.
 */
function testearRechazoExcesoAsegurados() {
  Logger.log('=== INICIO testearRechazoExcesoAsegurados() ===');
  try {
    const data = construirDatosPrueba_(20, [
      { nombre: 'Roberto García', edad: 82 },
      { nombre: 'María López', edad: 85 },
      { nombre: 'Jorge Peña', edad: 80 },
      { nombre: 'Elena Soto', edad: 81 },
      { nombre: 'Carmen Díaz', edad: 84 },
      { nombre: 'Raúl Vega', edad: 87 }
    ]);
    Logger.log('Estatus: ' + data.estatus + ' | elegibles: ' + data.numAsegurados);

    data.cuerpoCorreoHtml = construirCorreoRechazo_(data);
    Logger.log('Asunto: ' + construirAsunto_(data));

    enviarWebhookPowerAutomate_(null, data, '');
    Logger.log('✅ Webhook de rechazo enviado sin adjunto.');
  } catch (error) {
    Logger.log('❌ Error en testearRechazoExcesoAsegurados(): ' + error.message);
  }
  Logger.log('=== FIN testearRechazoExcesoAsegurados() ===');
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
 * @param {number=} diasViaje      Días entre salida y regreso (10 por defecto);
 *                                 negativo para simular un regreso antes de la salida.
 */
function construirDatosPrueba_(diasHastaSalida, pasajeros, diasViaje) {
  const msPorDia = 24 * 60 * 60 * 1000;
  const hoy = new Date();
  const salida = new Date(hoy.getTime() + diasHastaSalida * msPorDia);
  const regreso = new Date(salida.getTime() + (diasViaje === undefined ? 10 : diasViaje) * msPorDia);

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

/**
 * Folio que nunca se repite: el folio de la hoja (días, destino y fecha de
 * salida, que dos solicitudes pueden compartir) + un consecutivo global de
 * 4 dígitos o más. Ej.: SEGURO_VIAJE_+79-15D-FRA-08102026-0042.
 *
 * El consecutivo vive en la propiedad CONSECUTIVO_FOLIO del script y se
 * incrementa bajo LockService, así que dos envíos simultáneos nunca toman el
 * mismo número. Cada solicitud procesada consume uno, aprobada o rechazada;
 * si una falla después de asignarlo, ese número queda sin usar (puede haber
 * saltos, nunca repetidos). NO borres ni reinicies CONSECUTIVO_FOLIO.
 */
function asignarFolioUnico_(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let consecutivo;
  try {
    const propiedades = PropertiesService.getScriptProperties();
    consecutivo = Number(propiedades.getProperty('CONSECUTIVO_FOLIO') || 0) + 1;
    propiedades.setProperty('CONSECUTIVO_FOLIO', String(consecutivo));
  } finally {
    lock.releaseLock();
  }
  data.folio = String(data.folio).trim() + '-' + String(consecutivo).padStart(4, '0');
  data.nombreArchivoDrive = 'Propuesta_' + data.folio + '.html';
  return data.folio;
}

function registrarFolioFila_(sheet, fila, encabezados, folio) {
  const indice = indiceDe_(encabezados, CONFIG.COL_FOLIO_PROPUESTA);
  if (indice === -1) return; // columna opcional
  sheet.getRange(fila, indice + 1).setValue(folio);
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
      registrarFolioFila_(sheet, fila, encabezados, data.folio);
      marcarEstadoFila_(sheet, fila, encabezados, data.estatus + ' — folio ' + data.folio + ' — enviado a Power Automate');
    } catch (error) {
      Logger.log('❌ Fila ' + fila + ': ' + error.message);
      marcarEstadoFila_(sheet, fila, encabezados, 'ERROR: ' + error.message);
    }
  }
}
