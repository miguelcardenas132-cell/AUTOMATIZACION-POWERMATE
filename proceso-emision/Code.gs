/**
 * ============================================================================
 * SOLICITUD DE EMISIÓN — Seguro de Viaje SENIOR +79 · Seguros Atlas
 * ============================================================================
 * Vive en el proyecto de Apps Script ligado al FORMULARIO "Solicitud de
 * Emisión de Póliza de Seguro de Viaje" (no en la Hoja de respuestas, ni en
 * el proyecto Cotizaciones 2026). El cliente llega a ese formulario desde el
 * QR de la propuesta aceptada.
 *
 * Al enviarse el formulario arma TRES correos y los manda a Power Automate,
 * que los envía desde el buzón compartido segurodeviaje@segurosatlas.com.mx:
 *
 *   1) SOLICITUD DE TCI -> Mesa Control Daños. Solo datos del contratante,
 *      con la CSF y la INE o pasaporte adjuntas.
 *   2) SOLICITUD DE TCC -> Cotizaciones Daños. Igual que el TCI.
 *   3) SOLICITUD DE EMISIÓN -> Seguro de Viaje. Toda la información del
 *      formulario, con todos los archivos que subió el cliente.
 *
 * Los tres llevan siempre en copia a CONFIG_EMISION.COPIA_SIEMPRE.
 *
 * Antes revisa la VIGENCIA de la propuesta (CONFIG_EMISION.VIGENCIA): si la
 * solicitud llega fuera de vigencia no sale ninguno de los tres; sale un
 * solo correo de rechazo al cliente con copia a Seguro de Viaje.
 *
 * Trigger: función onFormSubmitSolicitudEmision, origen "Desde el
 * formulario", evento "Al enviarse el formulario".
 * Servicio avanzado: Drive API v2 (solo para leer el folio del PDF de la
 * propuesta adjunta; si falla, el correo sale igual sin folio).
 * ============================================================================
 */

// ============================================================================
// 1. CONFIGURACIÓN
// ============================================================================

/**
 * Ejecutar UNA SOLA VEZ desde el editor. La URL del webhook lleva su firma de
 * acceso, por eso vive en Script Properties y no en el código.
 */
function configurarPropiedades() {
  PropertiesService.getScriptProperties().setProperties({
    WEBHOOK_EMISION_URL: 'PEGA_AQUI_LA_URL_DEL_FLUJO_DE_POWER_AUTOMATE'
  });
}

const CONFIG_EMISION = {
  CORREO_SEGURO_VIAJE: 'segurodeviaje@segurosatlas.com.mx',
  CORREO_TCI: 'mesacontroldanos@segurosatlas.com.mx',   // Mesa Control Daños
  CORREO_TCC: 'cotizacionesdanos@segurosatlas.com.mx',  // Cotizaciones Daños

  // En copia de los tres correos. Se ignoran las entradas vacías.
  COPIA_SIEMPRE: [
    'mhidalgo@segurosatlas.com.mx', // Miguel Ángel Cárdenas Hidalgo
    'equintanar@segurosatlas.com.mx' // Eloisa Quintanar Curiel
  ],

  /**
   * ETAPA: a quién llegan los correos de cada envío real del formulario.
   *
   *   'PRUEBAS'    Los tres llegan SOLO a CORREOS_PRUEBAS, sin copias, con
   *                [PRUEBA] en el asunto y un aviso con los destinatarios reales.
   *   'PILOTO'     Los tres (TCI, TCC y expediente) llegan a Seguro de Viaje
   *                (CORREO_SEGURO_VIAJE), con COPIA_SIEMPRE, en formato final.
   *                Nada llega a Mesa Control ni a Cotizaciones Daños.
   *   'PRODUCCION' TCI -> Mesa Control, TCC -> Cotizaciones Daños, expediente
   *                -> Seguro de Viaje; los tres con COPIA_SIEMPRE.
   *
   * Cambiar el valor y guardar; no hay que tocar el trigger ni Power Automate.
   * Cualquier otro valor se trata como 'PRUEBAS'.
   */
  ETAPA: 'PILOTO',
  CORREOS_PRUEBAS: [
    'mhidalgo@segurosatlas.com.mx'
    // , 'equintanar@segurosatlas.com.mx'  // descomentar para que Eloisa también reciba las pruebas
  ],

  /**
   * VIGENCIA de la propuesta. La solicitud de emisión se rechaza sola si
   * llega después de la fecha más temprana entre:
   *   - el envío de la propuesta + DIAS_HABILES_DESDE_ENVIO (72 horas hábiles), y
   *   - la fecha de salida - DIAS_HABILES_ANTES_SALIDA (24 horas hábiles).
   * Días hábiles = lunes a viernes (sin festivos), igual que el PDF.
   *
   * La fecha de envío y la de salida se leen de la HOJA DE RESPUESTAS DE
   * PROPUESTAS (la del proyecto Cotizaciones 2026), buscando el folio; así no
   * dependen de lo que se capture en este formulario. ID_HOJA_PROPUESTAS es
   * lo que va entre /d/ y /edit en la URL de esa hoja. Si está vacío, o el
   * folio no aparece en la hoja, la solicitud NO se rechaza: sale normal con
   * un aviso naranja para revisar la vigencia a mano.
   */
  VIGENCIA: {
    ID_HOJA_PROPUESTAS: '',
    DIAS_HABILES_DESDE_ENVIO: 3,
    DIAS_HABILES_ANTES_SALIDA: 1,
    // Solo para el texto del correo de rechazo (la regla vive en Cotizaciones 2026).
    DIAS_ANTICIPACION_PROPUESTA: 5,
    COL_MARCA_TEMPORAL: ['Marca temporal', 'Timestamp'],
    COL_FECHA_SALIDA: ['Fecha de Salida']
  },
  // Botón "Solicitar nueva propuesta" del correo de rechazo.
  URL_NUEVA_PROPUESTA: 'https://docs.google.com/forms/d/e/1FAIpQLSfPedluEXJ32DFHxBjCRddBUzMgjsgK5OnwfZPluPuR6XHycw/viewform',

  // Firma de los tres correos (misma que usa el equipo en Outlook).
  FIRMA: {
    TELEFONO: '(55) 9177 &ndash; 5000 Ext. 4931 Cel: 55 1322 6276',
    // Correos que recibe el cliente (rechazo por vigencia): sin celular.
    TELEFONO_CLIENTE: '(55) 9177 &ndash; 5000 Ext. 5114',
    CORREO: 'segurodeviaje@segurosatlas.com.mx',
    DIRECCION: ['AV. Paseo de los Tamarindos No. 60 INT. PB, C.P. 05120', 'Col. Bosques de las Lomas, Ciudad de México'],
    // Imagen del 85 aniversario: debe ser una URL pública (Outlook bloquea base64).
    URL_IMAGEN: 'https://drive.google.com/uc?export=view&id=10hT2Y0GwMlCHhuBzE6Dv8dq-TTRaUqA2'
  },

  // Datos fijos de la solicitud de TCI/TCC.
  FIJOS: {
    TIPO_MOVIMIENTO: 'Nueva',
    RAMO: '131',
    MONEDA: 'USD',
    GIRO: 'Seguro de Viaje (Sector: 24, Subsector: 145, Giro: 1)',
    ASIGNACION: '(Área 4: Seguro de Viaje / Línea 2: Daños / Oficina: Negocios Especiales)'
  },

  /**
   * Títulos de las preguntas del formulario. Se comparan sin importar
   * mayúsculas, acentos ni espacios de más; cada dato acepta varios títulos
   * posibles, por si la pregunta se renombra.
   */
  PREGUNTAS: {
    FOLIO: ['Folio de la propuesta', 'Folio'],
    NOMBRE_AGENTE: ['Nombre de Agente'],
    CLAVE_AGENTE: ['Clave de Agente'],
    CLAVE_EJECUTIVO: ['Clave de tu Ejecutivo', 'Clave del Ejecutivo'],
    NOMBRE_EJECUTIVO: ['Nombre de tu Ejecutivo', 'Nombre del Ejecutivo'],
    SUCURSAL: ['Clave de Sucursal', 'Sucursal'],
    CONTRATANTE: ['Nombre Completo del Contratante'],
    DOMICILIO: ['Domicilio del Contratante (Calle, No. Ext y/o Int, Colonia, Municipio o Delegación, C.P.)',
      'Domicilio del Contratante'],
    RFC: ['RFC'],
    CURP: ['CURP (PERSONA FISICA)', 'CURP'],
    CORREO: ['Correo Electronico', 'Correo Electrónico'],
    TELEFONO: ['Teléfono', 'Telefono'],
    OCUPACION: ['Ocupación', 'Ocupacion'],
    // Archivos que van al TCI y al TCC (los dos siempre llevan CSF e INE).
    CSF: ['Adjunta tu CSF (Constancia de Situación Fiscal)', 'Constancia de Situación Fiscal (CSF)',
      'Adjunta tu CSF (Constancia de Situación Fiscal) o INE o Identificación Migratoria de residencia mexicana'],
    INE: ['Adjunta tu INE o pasaporte', 'INE o pasaporte']
  },

  /**
   * Orden y agrupación del correo completo para Seguro de Viaje. Lo que no
   * esté en esta lista sale al final en "Otros", para no perder nada.
   */
  SECCIONES: [
    {
      titulo: 'Información para emisión',
      preguntas: ['Folio de la propuesta', 'Nombre de Agente', 'Clave de Agente', 'Clave de tu Ejecutivo', 'Nombre de tu Ejecutivo',
        'Clave de Sucursal', 'Sucursal', 'Producto Elegido', 'Costo en USD', 'Adjunta la cotización recibida',
        'Adjunta la propuesta recibida', 'Adjunta tu CSF (Constancia de Situación Fiscal)',
        'Adjunta tu INE o pasaporte',
        'Adjunta tu CSF (Constancia de Situación Fiscal) o INE o Identificación Migratoria de residencia mexicana']
    },
    { titulo: 'Información del Viaje', preguntas: ['Destino', 'Fecha de Salida', 'Fecha de Regreso'] },
    {
      titulo: 'Contratante (Persona Física o Moral)',
      preguntas: ['Nombre Completo del Contratante',
        'Domicilio del Contratante (Calle, No. Ext y/o Int, Colonia, Municipio o Delegación, C.P.)',
        'RFC', 'CURP (PERSONA FISICA)', 'Correo Electronico', 'Teléfono', 'Ocupación']
    },
    {
      titulo: 'Asegurado 1',
      preguntas: ['Nombre Completo', 'Fecha de Nacimiento', 'Sexo', 'Contacto de Emergencia',
        'Teléfono Contacto de Emergencia', 'Nombre Beneficiario',
        'Domicilio del Asegurado (Calle, No. Ext y/o Int, Colonia, Municipio o Delegación, C.P.)']
    }
  ].concat([2, 3, 4, 5].map(function (n) {
    return {
      titulo: 'Asegurado ' + n,
      preguntas: ['Nombre Completo ' + n, 'Fecha de Nacimiento ' + n, 'Sexo ' + n, 'Contacto de Emergencia ' + n,
        'Teléfono Contacto de Emergencia ' + n, 'Nombre Beneficiario ' + n]
    };
  })),

  /**
   * SLIP: el documento que Seguro de Viaje sube al sistema interno. Hay una
   * plantilla RTF por plan (carpeta proceso-emision/plantillas-slip del
   * repositorio) que se sube tal cual a Google Drive; el script la busca por
   * nombre, llena el recuadro de asegurados (Arial 7) y Power Automate la
   * convierte a PDF con Word, así que el formato queda idéntico al original.
   * La llave es la respuesta de "Producto Elegido" (sin mayúsculas ni acentos).
   */
  SLIP: {
    'master': 'PLANTILLA_SLIP_MASTER.rtf',
    'master smart': 'PLANTILLA_SLIP_MASTER_SMART.rtf',
    'master elite': 'PLANTILLA_SLIP_MASTER_ELITE.rtf',
    'master premium': 'PLANTILLA_SLIP_MASTER_PREMIUM.rtf'
  },

  // Preguntas de control que no aportan nada al correo.
  OMITIR: [/^¿deseas agregar/i]
};

const COLORES_EMISION = { VERDE: '#027370', VERDE_CLARO: '#e6f4f3', GRIS: '#f4f5f7', TEXTO: '#222222' };
const FUENTE_EMISION = "'Aptos Display',Aptos,Calibri,Arial,sans-serif";
// Tamaño del texto de las solicitudes de TCI y TCC.
const TAMANO_TRAMITE = '10.5pt';

// ============================================================================
// 2. TRIGGER
// ============================================================================

function onFormSubmitSolicitudEmision(e) {
  if (!e || !e.response) {
    Logger.log('⚠️ Este evento no viene de un envío real del formulario (e.response no existe). ' +
      'Para probar sin el formulario usa probarCorreosEmision().');
    return;
  }
  const solicitud = leerRespuestas_(e.response.getItemResponses());
  solicitud.vigencia = validarVigencia_(solicitud);
  const payload = solicitud.vigencia.estado === 'VENCIDA'
    ? construirRechazoVigencia_(solicitud)
    : construirCorreos_(solicitud);
  aplicarEtapa_(payload);
  enviarAPowerAutomate_(payload);
}

/**
 * Ajusta los destinatarios según CONFIG_EMISION.ETAPA. En PILOTO solo el
 * TCI y el TCC cambian (a Seguro de Viaje); el expediente ya va ahí y el
 * rechazo por vigencia sí le llega al cliente.
 */
function aplicarEtapa_(payload) {
  const etapa = String(CONFIG_EMISION.ETAPA || '').toUpperCase().trim();
  if (etapa === 'PRODUCCION') return;
  if (etapa === 'PILOTO') {
    payload.correos.forEach(function (correo) {
      if (correo.tipo === 'TCI' || correo.tipo === 'TCC') correo.para = CONFIG_EMISION.CORREO_SEGURO_VIAJE;
    });
    return;
  }
  if (etapa !== 'PRUEBAS') Logger.log('⚠️ ETAPA "' + CONFIG_EMISION.ETAPA + '" no reconocida; se usa PRUEBAS.');
  desviarAPruebas_(payload);
}

/**
 * Manda los correos solo a CORREOS_PRUEBAS, sin copias. Cada correo lleva
 * [PRUEBA] en el asunto y una franja con los destinatarios reales, para
 * revisar que en producción irían a donde deben.
 */
function desviarAPruebas_(payload) {
  const pruebas = CONFIG_EMISION.CORREOS_PRUEBAS.filter(function (c) { return c; }).join(';');
  payload.correos.forEach(function (correo) {
    const aviso = '<div style="background-color:#fff4e5;border:1px solid #e0a800;padding:8px 12px;margin-bottom:14px;' +
      'font-family:' + FUENTE_EMISION + ';font-size:10pt;color:#7a5b00;">' +
      '<strong>CORREO DE PRUEBA</strong> (' + escapar_(correo.tipo) + '). En producción iría a: <strong>' +
      escapar_(correo.para) + '</strong>' + (correo.cc ? ' · CC: ' + escapar_(correo.cc) : '') +
      ' · Adjuntos: ' + (correo.adjuntos.length ? escapar_(correo.adjuntos.map(function (a) { return a.nombre; }).join(', ')) : 'ninguno') +
      (correo.tipo === 'SEGURO_VIAJE' && payload.slip ? ' + ' + escapar_(payload.slip.nombrePdf) : '') +
      '</div>';
    correo.asunto = '[PRUEBA] ' + correo.asunto;
    correo.cuerpoHtml = aviso + correo.cuerpoHtml;
    correo.para = pruebas;
    correo.cc = '';
  });
  return pruebas;
}

// ============================================================================
// 3. LECTURA DEL FORMULARIO
// ============================================================================

/**
 * Convierte las respuestas en { respuestas: [{titulo, texto, archivos}], ... }.
 * Los archivos se leen una sola vez de Drive y se reutilizan en los tres
 * correos.
 */
function leerRespuestas_(itemResponses) {
  const respuestas = itemResponses.map(function (item) {
    const titulo = item.getItem().getTitle().trim();
    if (item.getItem().getType() === FormApp.ItemType.FILE_UPLOAD) {
      const archivos = (item.getResponse() || []).map(function (id) {
        const archivo = DriveApp.getFileById(id);
        return { id: id, nombre: archivo.getName(), blob: archivo.getBlob() };
      });
      return { titulo: titulo, texto: archivos.map(function (a) { return a.nombre; }).join(', '), archivos: archivos };
    }
    const valor = item.getResponse();
    return { titulo: titulo, texto: Array.isArray(valor) ? valor.join(', ') : String(valor || '').trim(), archivos: [] };
  });

  const todosLosArchivos = [].concat.apply([], respuestas.map(function (r) { return r.archivos; }));
  const solicitud = { respuestas: respuestas, archivos: todosLosArchivos, fecha: new Date() };
  // El folio llega prellenado desde el QR / botón de la propuesta; solo si
  // viene vacío se intenta leer del PDF adjunto.
  solicitud.folio = valor_(solicitud, 'FOLIO') || buscarFolio_(todosLosArchivos);
  return solicitud;
}

function normalizar_(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Primera respuesta cuyo título coincide con alguno de los títulos dados. */
function buscarRespuesta_(solicitud, titulos) {
  const buscados = titulos.map(normalizar_);
  for (let i = 0; i < solicitud.respuestas.length; i++) {
    if (buscados.indexOf(normalizar_(solicitud.respuestas[i].titulo)) !== -1) return solicitud.respuestas[i];
  }
  return null;
}

function valor_(solicitud, clave) {
  const respuesta = buscarRespuesta_(solicitud, CONFIG_EMISION.PREGUNTAS[clave]);
  return respuesta ? respuesta.texto : '';
}

/**
 * Persona moral si el RFC tiene 12 caracteres (física: 13). Para moral, CURP
 * y Ocupación van como N/A aunque los hayan llenado.
 */
function esPersonaMoral_(rfc) {
  return String(rfc || '').replace(/[\s-]/g, '').length === 12;
}

/**
 * Clave de sucursal de 3 caracteres (G00, E82, M20, DF4, MSJ, ML0...), en
 * mayúsculas y sin espacios. Si escriben "g00 - Guadalajara" se toma "G00";
 * si no empieza con una clave, se deja como lo escribieron.
 */
function claveSucursal_(texto) {
  const limpio = String(texto || '').trim().toUpperCase();
  const clave = limpio.match(/^[A-Z][A-Z0-9]{2}(?![A-Z0-9])/);
  return clave ? clave[0] : limpio;
}

/**
 * Lee el folio del PDF de la propuesta adjunta (OCR de Drive API v2).
 * Acepta el folio actual (SEGURO_VIAJE_+79-...-NNNN, con o sin consecutivo) y el anterior
 * (COT-...). Nunca detiene el envío: si no lo encuentra, regresa ''.
 */
function buscarFolio_(archivos) {
  for (let i = 0; i < archivos.length; i++) {
    if (!/pdf/i.test(archivos[i].blob.getContentType())) continue;
    let temporalId = null;
    try {
      const doc = Drive.Files.insert({ title: 'TEMP_OCR_' + archivos[i].id, mimeType: MimeType.GOOGLE_DOCS },
        archivos[i].blob, { ocr: true, ocrLanguage: 'es' });
      temporalId = doc.id;
      const texto = DocumentApp.openById(temporalId).getBody().getText();
      const folio = texto.match(/SEGURO_VIAJE_\+?79-\d+D-[A-Z]{3}-\d{8}(?:-\d{4,})?|COT-\d+-\d{8}-\d{6}/);
      if (folio) return folio[0];
    } catch (error) {
      Logger.log('No se pudo leer el folio de ' + archivos[i].nombre + ': ' + error.message);
    } finally {
      if (temporalId) {
        try { DriveApp.getFileById(temporalId).setTrashed(true); } catch (ignorado) { /* sin efecto */ }
      }
    }
  }
  return '';
}

// ============================================================================
// 3b. VIGENCIA DE LA PROPUESTA
// ============================================================================

/**
 * Regresa { estado, motivo, envio, salida, vence }:
 *   VIGENTE      la solicitud llegó a tiempo.
 *   VENCIDA      llegó después de `vence`: se rechaza sola.
 *   SIN_VALIDAR  no se pudo revisar (sin folio, sin ID de la hoja, folio no
 *                encontrado, fechas ilegibles o error): sale normal con aviso.
 * Nunca lanza error: si algo falla, la solicitud no se pierde.
 */
function validarVigencia_(solicitud) {
  const V = CONFIG_EMISION.VIGENCIA;
  const sinValidar = function (motivo) {
    Logger.log('⚠️ Vigencia sin validar: ' + motivo);
    return { estado: 'SIN_VALIDAR', motivo: motivo };
  };
  if (!V.ID_HOJA_PROPUESTAS) return sinValidar('falta el ID de la hoja de propuestas en CONFIG_EMISION.VIGENCIA');
  if (!solicitud.folio) return sinValidar('la solicitud no trae folio');

  try {
    const fila = buscarFilaPropuesta_(SpreadsheetApp.openById(V.ID_HOJA_PROPUESTAS), solicitud.folio);
    if (!fila) return sinValidar('el folio ' + solicitud.folio + ' no aparece en la hoja de propuestas');

    const envio = fechaDeCelda_(columnaPorTitulo_(fila, V.COL_MARCA_TEMPORAL, 0));
    const salida = fechaDeCelda_(columnaPorTitulo_(fila, V.COL_FECHA_SALIDA, -1));
    if (!envio || !salida) return sinValidar('no se pudo leer la fecha de envío o de salida del folio ' + solicitud.folio);

    const porEnvio = sumarDiasHabiles_(envio, V.DIAS_HABILES_DESDE_ENVIO);
    const porSalida = sumarDiasHabiles_(salida, -V.DIAS_HABILES_ANTES_SALIDA);
    const vence = porSalida < porEnvio ? porSalida : porEnvio;
    const hoy = soloFecha_(solicitud.fecha || new Date());
    return { estado: hoy > vence ? 'VENCIDA' : 'VIGENTE', envio: envio, salida: salida, vence: vence };
  } catch (error) {
    return sinValidar('error al leer la hoja de propuestas: ' + error.message);
  }
}

/**
 * Busca el folio en todas las pestañas de la hoja de propuestas (columna
 * "Folio de propuesta" o "Estado de envío", donde lo deja Cotizaciones
 * 2026). Regresa { encabezados, valores } de la fila, o null.
 */
function buscarFilaPropuesta_(libro, folio) {
  const exacto = new RegExp(folio.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\d)');
  const celdas = libro.createTextFinder(folio).matchCase(true).findAll();
  for (let i = 0; i < celdas.length; i++) {
    if (!exacto.test(String(celdas[i].getValue()))) continue;
    const hoja = celdas[i].getSheet();
    const fila = celdas[i].getRow();
    if (fila === 1) continue;
    const ancho = hoja.getLastColumn();
    return {
      encabezados: hoja.getRange(1, 1, 1, ancho).getValues()[0].map(function (h) { return String(h).trim(); }),
      valores: hoja.getRange(fila, 1, 1, ancho).getValues()[0]
    };
  }
  return null;
}

/** Valor de la primera columna cuyo título coincide; si no hay, la columna `respaldo` (-1 = ninguna). */
function columnaPorTitulo_(fila, titulos, respaldo) {
  const buscados = titulos.map(normalizar_);
  for (let i = 0; i < fila.encabezados.length; i++) {
    if (buscados.indexOf(normalizar_(fila.encabezados[i])) !== -1) return fila.valores[i];
  }
  return respaldo >= 0 ? fila.valores[respaldo] : '';
}

/** Date, "dd/MM/yyyy" o "yyyy-MM-dd" -> Date a medianoche; null si no se entiende. */
function fechaDeCelda_(valor) {
  if (valor instanceof Date && !isNaN(valor.getTime())) return soloFecha_(valor);
  const texto = String(valor || '').trim();
  let m = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  m = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return null;
}

function soloFecha_(fecha) {
  return new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
}

/** Suma (o resta) n días hábiles, lunes a viernes. Igual que en Cotizaciones 2026. */
function sumarDiasHabiles_(fecha, n) {
  const resultado = soloFecha_(fecha);
  const paso = n >= 0 ? 1 : -1;
  let restantes = Math.abs(n);
  while (restantes > 0) {
    resultado.setDate(resultado.getDate() + paso);
    const diaSemana = resultado.getDay();
    if (diaSemana !== 0 && diaSemana !== 6) restantes--;
  }
  return resultado;
}

function fechaTexto_(fecha) {
  return fecha ? Utilities.formatDate(fecha, 'America/Mexico_City', 'dd/MM/yyyy') : '';
}

// ============================================================================
// 4. CORREOS
// ============================================================================

/**
 * Propuesta fuera de vigencia: un solo correo al correo capturado en el
 * formulario, con copia a Seguro de Viaje y COPIA_SIEMPRE. No sale TCI, TCC
 * ni expediente. El SLIP va igual en el payload porque el flujo siempre lo
 * convierte, pero no se adjunta a este correo.
 */
function construirRechazoVigencia_(solicitud) {
  const datos = datosContratante_(solicitud);
  const slip = construirSlip_(solicitud);
  const copia = [CONFIG_EMISION.CORREO_SEGURO_VIAJE].concat(CONFIG_EMISION.COPIA_SIEMPRE)
    .filter(function (c) { return c; }).join(';');
  Logger.log('⛔ Solicitud rechazada por vigencia. Folio ' + solicitud.folio + ', venció el ' + fechaTexto_(solicitud.vigencia.vence));
  return {
    folio: solicitud.folio,
    slip: { nombreRtf: slip.nombreRtf, nombrePdf: slip.nombrePdf, contenidoBase64: slip.contenidoBase64 },
    correos: [{
      tipo: 'RECHAZO_VIGENCIA',
      para: datos.correo || CONFIG_EMISION.CORREO_SEGURO_VIAJE,
      cc: copia,
      asunto: 'Solicitud de emisión no procesada || Propuesta fuera de vigencia || ' + solicitud.folio,
      cuerpoHtml: correoRechazoVigencia_(solicitud, datos),
      adjuntos: []
    }]
  };
}

function correoRechazoVigencia_(solicitud, d) {
  const v = solicitud.vigencia;
  const V = CONFIG_EMISION.VIGENCIA;
  const p = function (html, extra) {
    return '<p style="margin:0 0 ' + (extra === undefined ? 12 : extra) + 'px 0;font-family:' + FUENTE_EMISION +
      ';font-size:' + TAMANO_TRAMITE + ';color:#000000;">' + html + '</p>';
  };
  const boton = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 16px 0;"><tr>' +
    '<td bgcolor="' + COLORES_EMISION.VERDE + '" style="background-color:' + COLORES_EMISION.VERDE + ';border-radius:4px;">' +
    '<a href="' + escapar_(CONFIG_EMISION.URL_NUEVA_PROPUESTA) + '" style="display:inline-block;padding:10px 18px;' +
    'font-family:' + FUENTE_EMISION + ';font-size:10.5pt;font-weight:bold;color:#ffffff;text-decoration:none;">' +
    'Solicitar nueva propuesta</a></td></tr></table>';

  return '<div style="font-family:' + FUENTE_EMISION + ';font-size:' + TAMANO_TRAMITE + ';color:#000000;">' +
    p('Hola, buen día.') +
    p('Recibimos la solicitud de emisión de la propuesta <strong>' + escapar_(solicitud.folio) + '</strong>' +
      (d.contratante ? ' (contratante: <strong>' + escapar_(d.contratante) + '</strong>)' : '') +
      ', pero <strong>no fue posible procesarla porque la propuesta está fuera de vigencia</strong>.') +
    p('La propuesta era válida hasta el <strong>' + fechaTexto_(v.vence) + '</strong>. La solicitud de emisión debe ' +
      'enviarse dentro de las <strong>' + (V.DIAS_HABILES_DESDE_ENVIO * 24) + ' horas hábiles</strong> siguientes al envío ' +
      'de la propuesta (' + fechaTexto_(v.envio) + ') y, como máximo, <strong>' + (V.DIAS_HABILES_ANTES_SALIDA * 24) +
      ' horas hábiles antes de la fecha de salida</strong> (' + fechaTexto_(v.salida) + '), lo que ocurra primero.') +
    p('Para continuar, solicita una nueva propuesta. Recuerda que las propuestas se piden con al menos ' +
      V.DIAS_ANTICIPACION_PROPUESTA + ' días hábiles de anticipación a la salida.', 8) +
    boton +
    p('Saludos.', 0) + p('&nbsp;', 0) + p('&nbsp;', 0) +
    firmaTexto_(true) +
  '</div>';
}

function construirCorreos_(solicitud) {
  const datos = datosContratante_(solicitud);
  const slip = construirSlip_(solicitud);
  const documentosContratante = documentosContratante_(solicitud);
  const copia = CONFIG_EMISION.COPIA_SIEMPRE.filter(function (c) { return c; }).join(';');

  return {
    folio: solicitud.folio,
    // Va aparte de los correos: Power Automate lo convierte a PDF una vez y
    // lo agrega solo al correo de Seguro de Viaje.
    slip: { nombreRtf: slip.nombreRtf, nombrePdf: slip.nombrePdf, contenidoBase64: slip.contenidoBase64 },
    correos: [
      {
        tipo: 'TCI',
        para: CONFIG_EMISION.CORREO_TCI,
        cc: copia,
        asunto: 'SOLICITUD DE TCI || NUEVA POLIZA || ' + datos.sucursal,
        cuerpoHtml: correoTramite_('TCI', datos),
        adjuntos: documentosContratante
      },
      {
        tipo: 'TCC',
        para: CONFIG_EMISION.CORREO_TCC,
        cc: copia,
        asunto: 'SOLICITUD DE TCC || NUEVA POLIZA || ' + datos.sucursal,
        cuerpoHtml: correoTramite_('TCC', datos),
        adjuntos: documentosContratante
      },
      {
        tipo: 'SEGURO_VIAJE',
        para: CONFIG_EMISION.CORREO_SEGURO_VIAJE,
        cc: copia,
        asunto: 'SOLICITUD DE EMISIÓN || SENIOR +79 || ' + datos.contratante +
          (solicitud.folio ? ' || ' + solicitud.folio : ''),
        cuerpoHtml: correoSeguroViaje_(solicitud, datos, slip),
        adjuntos: adjuntosPayload_(solicitud.archivos)
      }
    ]
  };
}

/**
 * CSF + INE o pasaporte del contratante, que el TCI y el TCC siempre llevan.
 * Si las dos preguntas fueran la misma (formulario anterior), no se repiten.
 */
function documentosContratante_(solicitud) {
  const vistos = {};
  const archivos = [];
  [CONFIG_EMISION.PREGUNTAS.CSF, CONFIG_EMISION.PREGUNTAS.INE].forEach(function (titulos) {
    const respuesta = buscarRespuesta_(solicitud, titulos);
    (respuesta ? respuesta.archivos : []).forEach(function (archivo) {
      if (vistos[archivo.id]) return;
      vistos[archivo.id] = true;
      archivos.push(archivo);
    });
  });
  return adjuntosPayload_(archivos);
}

function datosContratante_(solicitud) {
  const rfc = valor_(solicitud, 'RFC').toUpperCase();
  const moral = esPersonaMoral_(rfc);
  // Vacío, "NA", "n/a" o "No aplica" (el formulario pide escribir NA) -> "N/A".
  const oNA = function (texto) {
    const limpio = String(texto || '').trim();
    return !limpio || /^(n\s*\/?\s*a|no aplica)\.?$/i.test(limpio) ? 'N/A' : limpio;
  };
  const ejecutivo = [valor_(solicitud, 'CLAVE_EJECUTIVO'), valor_(solicitud, 'NOMBRE_EJECUTIVO')]
    .filter(function (v) { return v; }).join(' ');

  return {
    contratante: valor_(solicitud, 'CONTRATANTE').toUpperCase(),
    agente: valor_(solicitud, 'NOMBRE_AGENTE').toUpperCase() + ' || ' + valor_(solicitud, 'CLAVE_AGENTE'),
    sucursal: claveSucursal_(valor_(solicitud, 'SUCURSAL')),
    rfc: oNA(rfc),
    curp: moral ? 'N/A' : oNA(valor_(solicitud, 'CURP').toUpperCase()),
    ocupacion: moral ? 'N/A' : oNA(valor_(solicitud, 'OCUPACION')),
    domicilio: oNA(valor_(solicitud, 'DOMICILIO').toUpperCase()),
    telefono: oNA(valor_(solicitud, 'TELEFONO')),
    correo: valor_(solicitud, 'CORREO'),
    ejecutivo: oNA(ejecutivo),
    personaMoral: moral
  };
}

/**
 * Correo de TCI o TCC: mismo texto y orden que la solicitud que se manda a
 * mano a Mesa Control / Cotizaciones Daños.
 */
function correoTramite_(tipo, d) {
  const F = CONFIG_EMISION.FIJOS;
  const p = function (html, extra) {
    return '<p style="margin:0 0 ' + (extra || 0) + 'px 0;font-family:' + FUENTE_EMISION + ';font-size:' + TAMANO_TRAMITE + ';color:#000000;">' +
      html + '</p>';
  };
  const renglon = function (etiqueta, valorHtml) {
    return '<li style="margin:0;font-family:' + FUENTE_EMISION + ';font-size:' + TAMANO_TRAMITE + ';color:#000000;">' +
      etiqueta + ': <strong>' + valorHtml + '</strong></li>';
  };
  const correo = d.correo
    ? '<a href="mailto:' + escapar_(d.correo) + '" style="color:#467886;">' + escapar_(d.correo) + '</a>'
    : 'N/A';

  return '<div style="font-family:' + FUENTE_EMISION + ';font-size:' + TAMANO_TRAMITE + ';color:#000000;">' +
    p('Hola, buen día.', 14) +
    p('Me pueden apoyar por favor con la emisión de <strong>1 (un) ' + tipo + '</strong> Nueva Póliza. ' +
      'Favor de asignarla al ' + escapar_(F.ASIGNACION), 14) +
    p('CONTRATANTE:') +
    '<ol style="margin:0 0 14px 0;padding-left:48px;">' +
      renglon('Nombre del Asegurado/Razón Social (completa)', escapar_(d.contratante)) +
      renglon('Tipo de movimiento', escapar_(F.TIPO_MOVIMIENTO)) +
      renglon('Producto o Ramo a cotizar', escapar_(F.RAMO)) +
      renglon('Nombre y clave del agente', escapar_(d.agente)) +
      renglon('Moneda', escapar_(F.MONEDA)) +
      renglon('Giro', escapar_(F.GIRO)) +
      renglon('Clave de Sucursal', escapar_(d.sucursal)) +
      renglon('RFC', escapar_(d.rfc)) +
      renglon('CURP', escapar_(d.curp)) +
      renglon('Ocupación', escapar_(d.ocupacion)) +
      renglon('Domicilio', escapar_(d.domicilio)) +
      renglon('Tel', escapar_(d.telefono)) +
      '<li style="margin:0;font-family:' + FUENTE_EMISION + ';font-size:' + TAMANO_TRAMITE + ';color:#000000;">Correo Electrónico: ' +
        correo + '</li>' +
      renglon('Ejecutivo', '<span style="background-color:#ffff00;">' + escapar_(d.ejecutivo) + '</span>') +
    '</ol>' +
    // Dos renglones en blanco (dos "enter") entre "Saludos." y la firma.
    p('Saludos.') + p('&nbsp;') + p('&nbsp;') +
    firmaTexto_() +
  '</div>';
}

/** Correo completo para Seguro de Viaje: todo el formulario por secciones. */
function correoSeguroViaje_(solicitud, d, slip) {
  const avisoSlip = slip && slip.ok
    ? ' También va adjunto el <strong>SLIP en PDF</strong> (' + escapar_(slip.nombrePdf) + ') con el recuadro de asegurados ya llenado.'
    : ' <strong style="color:#b3261e;">⚠️ No se generó el SLIP: ' + escapar_(slip ? slip.motivo : '') + '. Llenarlo a mano.</strong>';
  const usadas = {};
  const omitir = function (titulo) {
    return CONFIG_EMISION.OMITIR.some(function (re) { return re.test(titulo); });
  };

  let bloques = CONFIG_EMISION.SECCIONES.map(function (seccion) {
    const filas = seccion.preguntas.map(function (pregunta) {
      const r = buscarRespuesta_(solicitud, [pregunta]);
      if (!r || usadas[r.titulo]) return '';
      usadas[r.titulo] = true;
      return filaSeccion_(r);
    }).join('');
    return filas ? bloqueSeccion_(seccion.titulo, filas) : '';
  }).join('');

  const otros = solicitud.respuestas
    .filter(function (r) { return !usadas[r.titulo] && !omitir(r.titulo); })
    .map(filaSeccion_).join('');
  if (otros) bloques += bloqueSeccion_('Otros', otros);

  const folio = solicitud.folio
    ? '<strong style="color:' + COLORES_EMISION.VERDE + ';">Folio de la propuesta:</strong> ' + escapar_(solicitud.folio)
    : '⚠️ No se pudo leer el folio de la propuesta adjunta; revisar el PDF.';
  const v = solicitud.vigencia || { estado: 'SIN_VALIDAR', motivo: 'no se revisó' };
  const vigencia = v.estado === 'VIGENTE'
    ? '<div style="padding:0 12px 10px 12px;color:' + COLORES_EMISION.VERDE + ';">✔ Propuesta vigente hasta el <strong>' +
      fechaTexto_(v.vence) + '</strong> (enviada el ' + fechaTexto_(v.envio) + ', salida el ' + fechaTexto_(v.salida) + ').</div>'
    : '<div style="background-color:#fff4e5;border-left:4px solid #e0a800;padding:8px 12px;margin-bottom:10px;color:#7a5b00;">' +
      '⚠️ <strong>No se pudo validar la vigencia</strong> (' + escapar_(v.motivo) + '). Revisar a mano antes de emitir.</div>';

  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4f3" ' +
      'style="border-collapse:collapse;background-color:#f3f4f3;">' +
    '<tr><td align="center" style="padding:20px 8px;">' +
      '<table role="presentation" width="700" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" ' +
        'style="border-collapse:collapse;width:100%;max-width:700px;background-color:#ffffff;">' +
        '<tr><td bgcolor="' + COLORES_EMISION.VERDE + '" style="padding:16px 20px;background-color:' + COLORES_EMISION.VERDE + ';' +
          'font-family:' + FUENTE_EMISION + ';font-size:16pt;font-weight:bold;color:#ffffff;">' +
          'Nueva Solicitud de Emisión — Seguro de Viaje SENIOR +79</td></tr>' +
        '<tr><td style="padding:16px 20px 4px 20px;font-family:' + FUENTE_EMISION + ';font-size:10.5pt;color:#222222;">' +
          '<div style="background-color:' + COLORES_EMISION.VERDE_CLARO + ';border-left:4px solid ' + COLORES_EMISION.VERDE + ';' +
            'padding:8px 12px;margin-bottom:10px;">' + folio + '</div>' + vigencia +
          'Se recibió una solicitud de emisión desde el formulario. Ya se enviaron en automático la ' +
          '<strong>solicitud de TCI</strong> a Mesa Control Daños y la <strong>solicitud de TCC</strong> a ' +
          'Cotizaciones Daños (contratante: <strong>' + escapar_(d.contratante) + '</strong>, persona ' +
          (d.personaMoral ? 'moral' : 'física') + '). Los archivos que subió el cliente van adjuntos.' + avisoSlip +
        '</td></tr>' +
        '<tr><td style="padding:12px 20px 8px 20px;">' + bloques +
          '<div style="font-family:' + FUENTE_EMISION + ';font-size:9pt;color:#888888;">Fecha de solicitud: ' +
            Utilities.formatDate(solicitud.fecha, 'America/Mexico_City', 'dd/MM/yyyy HH:mm') + ' hrs</div>' +
        '</td></tr>' +
        '<tr><td style="padding:12px 20px 20px 20px;">' + firmaTexto_() + '</td></tr>' +
      '</table>' +
    '</td></tr></table>';
}

function filaSeccion_(respuesta) {
  const valor = respuesta.archivos.length
    ? '📎 ' + escapar_(respuesta.texto) + ' (adjunto)'
    : escapar_(respuesta.texto || '—');
  const celda = 'padding:6px 10px;border-bottom:1px solid #e6e6e6;font-family:' + FUENTE_EMISION + ';font-size:10pt;vertical-align:top;';
  return '<tr><td width="42%" style="' + celda + 'font-weight:bold;color:' + COLORES_EMISION.VERDE + ';">' +
    escapar_(respuesta.titulo) + '</td><td style="' + celda + 'color:#222222;">' + valor + '</td></tr>';
}

function bloqueSeccion_(titulo, filasHtml) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">' +
      '<tr><td bgcolor="' + COLORES_EMISION.VERDE_CLARO + '" style="padding:6px 10px;background-color:' + COLORES_EMISION.VERDE_CLARO + ';' +
        'border-left:4px solid ' + COLORES_EMISION.VERDE + ';font-family:' + FUENTE_EMISION + ';font-size:10.5pt;font-weight:bold;' +
        'color:' + COLORES_EMISION.VERDE + ';">' + escapar_(titulo) + '</td></tr></table>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">' +
      filasHtml + '</table>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
      '<td height="14" style="height:14px;font-size:1px;line-height:1px;">&nbsp;</td></tr></table>';
}

/**
 * Firma del equipo: mismos colores y renglones que la firma de Outlook.
 * cliente = true para correos que recibe el cliente (Ext. 5114, sin celular).
 */
function firmaTexto_(cliente) {
  const F = CONFIG_EMISION.FIRMA;
  const telefono = cliente ? F.TELEFONO_CLIENTE : F.TELEFONO;
  // Arial: 12 pt el nombre, 9 pt "DINE" y 8 pt el resto (estilo de la firma de Outlook).
  const linea = function (html, estilo) {
    return '<div style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:8pt;line-height:1.35;' + estilo + '">' +
      html + '</div>';
  };
  const etiqueta = function (texto) { return '<strong style="color:#80340d;">' + texto + '</strong>'; };
  return linea('Seguro de Viaje', 'font-size:12pt;font-weight:bold;color:#0f4761;') +
    linea('DINE (Dirección de Negocios Especiales)', 'font-size:9pt;color:#7f7f7f;') +
    linea('&nbsp;', 'color:#595959;') +
    linea(etiqueta('Tel.') + ' ' + telefono, 'color:#595959;') +
    linea(etiqueta('Correo.') + ' <a href="mailto:' + F.CORREO + '" style="color:#467886;">' + F.CORREO + '</a>', 'color:#595959;') +
    F.DIRECCION.map(function (renglon) { return linea(escapar_(renglon), 'color:#2f5496;'); }).join('') +
    '<img src="' + escapar_(F.URL_IMAGEN) + '" alt="85 Aniversario Seguros Atlas" width="360" ' +
      'style="display:block;width:360px;max-width:100%;height:auto;border:0;margin-top:6px;">';
}

function escapar_(texto) {
  return String(texto === null || texto === undefined ? '' : texto)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================================
// 4b. SLIP (recuadro de asegurados)
// ============================================================================

/**
 * Arma el SLIP del plan elegido con los asegurados del formulario.
 * Siempre regresa un RTF: si no se pudo llenar, uno de una línea con el
 * motivo, para que el flujo no se detenga y Seguro de Viaje lo vea.
 */
function construirSlip_(solicitud) {
  const base = 'SLIP_' + (solicitud.folio || ('SENIOR79_' + Utilities.formatDate(solicitud.fecha, 'America/Mexico_City', 'yyyyMMdd_HHmmss')));
  const nombre = base.replace(/[\\/:*?"<>|]/g, '-');
  // El RTF es un archivo de paso en OneDrive: lleva fecha y hora para que dos
  // envíos del mismo folio no choquen. El PDF adjunto conserva el nombre limpio.
  const sello = Utilities.formatDate(solicitud.fecha, 'America/Mexico_City', 'yyyyMMdd_HHmmss');
  const resultado = { ok: false, motivo: '', nombreRtf: nombre + '_' + sello + '.rtf', nombrePdf: nombre + '.pdf', contenidoBase64: '' };
  let rtf;
  try {
    const producto = normalizar_((buscarRespuesta_(solicitud, ['Producto Elegido']) || {}).texto);
    const archivo = CONFIG_EMISION.SLIP[producto];
    if (!archivo) throw new Error('el producto "' + producto + '" no tiene plantilla de SLIP');
    rtf = llenarSlip_(leerPlantillaSlip_(archivo), leerAsegurados_(solicitud));
    resultado.ok = true;
  } catch (error) {
    resultado.motivo = error.message;
    Logger.log('SLIP no generado: ' + error.message);
    rtf = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs20 SLIP no generado: ' +
      rtfTexto_(error.message) + '. Llenarlo manualmente.\\par}';
  }
  resultado.contenidoBase64 = Utilities.base64Encode(rtf);
  return resultado;
}

function leerPlantillaSlip_(nombreArchivo) {
  const archivos = DriveApp.getFilesByName(nombreArchivo);
  while (archivos.hasNext()) {
    const archivo = archivos.next();
    if (!archivo.isTrashed()) return archivo.getBlob().getDataAsString('ISO-8859-1');
  }
  throw new Error('no encontré "' + nombreArchivo + '" en Google Drive');
}

/** Asegurados 1 a 5 del formulario, en el orden y formato del SLIP. */
function leerAsegurados_(solicitud) {
  const texto = function (titulo) { return ((buscarRespuesta_(solicitud, [titulo]) || {}).texto || '').trim(); };
  const lista = [];
  for (let n = 1; n <= 5; n++) {
    const sufijo = n === 1 ? '' : ' ' + n;
    const nombre = texto('Nombre Completo' + sufijo);
    if (!nombre) continue;
    lista.push({
      nombre: nombre.toUpperCase(),
      nacimiento: fechaSlip_(texto('Fecha de Nacimiento' + sufijo)),
      sexo: sexoSlip_(texto('Sexo' + sufijo)),
      contacto: (texto('Contacto de Emergencia' + sufijo) || '-').toUpperCase(),
      telefono: texto('Teléfono Contacto de Emergencia' + sufijo) || '-',
      beneficiario: (texto('Nombre Beneficiario' + sufijo) || '-').toUpperCase()
    });
  }
  return lista;
}

/** "1937-11-26" (formato de Google Forms) -> "26/11/1937". */
function fechaSlip_(valor) {
  const partes = String(valor || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return partes ? partes[3] + '/' + partes[2] + '/' + partes[1] : (valor || '-');
}

function sexoSlip_(valor) {
  const v = normalizar_(valor);
  if (/^(m|masculino|hombre)$/.test(v)) return 'M';
  if (/^(f|femenino|mujer)$/.test(v)) return 'F';
  return v ? String(valor).toUpperCase() : '-';
}

/**
 * Repite la fila modelo de la plantilla (entre %%FILA_INICIO%% y
 * %%FILA_FIN%%) una vez por asegurado. Ajusta el número de fila y deja la
 * marca de última fila solo en la última, como lo escribe Word.
 */
function llenarSlip_(plantilla, asegurados) {
  const INICIO = '%%FILA_INICIO%%';
  const FIN = '%%FILA_FIN%%';
  const i = plantilla.indexOf(INICIO);
  const j = plantilla.indexOf(FIN);
  if (i === -1 || j === -1) throw new Error('la plantilla no tiene la fila modelo');
  const modelo = plantilla.substring(i + INICIO.length, j);
  const filas = asegurados.length ? asegurados : [{ nombre: '-', nacimiento: '-', sexo: '-', contacto: '-', telefono: '-', beneficiario: '-' }];

  const bloque = filas.map(function (a, k) {
    let fila = modelo.replace(/\\irow\d+\\irowband\d+/g, '\\irow' + (k + 1) + '\\irowband' + (k + 1));
    if (k < filas.length - 1) fila = fila.replace(/\\lastrow ?/g, '');
    [a.nombre, a.nacimiento, a.sexo, a.contacto, a.telefono, a.beneficiario].forEach(function (valor, c) {
      fila = fila.split('%%C' + (c + 1) + '%%').join(rtfTexto_(valor));
    });
    return fila;
  }).join('');
  return plantilla.substring(0, i) + bloque + plantilla.substring(j + FIN.length);
}

/** Texto plano -> RTF: escapa \\ { } y acentos (cp1252) para no romper el archivo. */
function rtfTexto_(texto) {
  let salida = '';
  const s = String(texto === null || texto === undefined ? '' : texto).replace(/\s+/g, ' ');
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    const code = s.charCodeAt(i);
    if (c === '\\' || c === '{' || c === '}') salida += '\\' + c;
    else if (code < 128) salida += c;
    else if (code < 256) salida += "\\'" + ('0' + code.toString(16)).slice(-2);
    else salida += '\\u' + (code > 32767 ? code - 65536 : code) + '?';
  }
  return salida;
}

// ============================================================================
// 5. PUENTE A POWER AUTOMATE
// ============================================================================

/** Archivos como { nombre, contenidoBase64 } para el campo Attachments de Outlook. */
function adjuntosPayload_(archivos) {
  return archivos.map(function (a) {
    return { nombre: a.nombre, contenidoBase64: Utilities.base64Encode(a.blob.getBytes()) };
  });
}

function enviarAPowerAutomate_(payload) {
  const url = PropertiesService.getScriptProperties().getProperty('WEBHOOK_EMISION_URL');
  if (!url || url.indexOf('http') !== 0) {
    throw new Error('Falta configurar WEBHOOK_EMISION_URL. Ejecuta configurarPropiedades().');
  }
  const respuesta = UrlFetchApp.fetch(url, {
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
// 6. PRUEBA DE UN SOLO CLIC
// ============================================================================

/**
 * Manda los tres correos con datos ficticios (sin adjuntos), para probar el
 * flujo sin llenar el formulario. Siempre van solo a CORREOS_PRUEBAS, sea
 * cual sea la ETAPA.
 */
function probarCorreosEmision() {
  const respuestas = [
    ['Nombre de Agente', 'OML, Agente de Seguros y de Fianzas SA de CV'], ['Clave de Agente', '13991'],
    ['Clave de tu Ejecutivo', '570'], ['Nombre de tu Ejecutivo', 'Lucero Guadalupe Borbón Nieblas'],
    ['Clave de Sucursal', 'G00'], ['Producto Elegido', 'Master Elite'], ['Costo en USD', '159.41'],
    ['Destino', 'Francia'], ['Fecha de Salida', '2026-12-01'], ['Fecha de Regreso', '2026-12-15'],
    ['Nombre Completo del Contratante', 'Omnilife de México S.A. de C.V.'],
    ['Domicilio del Contratante (Calle, No. Ext y/o Int, Colonia, Municipio o Delegación, C.P.)',
      'Av. Inglaterra 3089, Vallarta Poniente, Guadalajara, C.P. 44110'],
    ['RFC', 'OME910520I31'], ['CURP (PERSONA FISICA)', ''], ['Correo Electronico', 'lborbon.gdl@segurosatlas.com.mx'],
    ['Teléfono', ''], ['Ocupación', ''],
    ['Nombre Completo', 'Roberto García'], ['Fecha de Nacimiento', '1943-03-10'], ['Sexo', 'Masculino'],
    ['Contacto de Emergencia', 'Ana García'], ['Teléfono Contacto de Emergencia', '3312345678'],
    ['Nombre Beneficiario', 'Ana García'], ['¿Deseas agregar un segundo asegurado?', 'No']
  ].map(function (r) { return { titulo: r[0], texto: r[1], archivos: [] }; });

  const payload = construirCorreos_({ respuestas: respuestas, archivos: [], folio: '', fecha: new Date() });
  const pruebas = desviarAPruebas_(payload);
  enviarAPowerAutomate_(payload);
  Logger.log('✅ Enviados ' + payload.correos.length + ' correos de prueba a ' + pruebas);
}

/** Manda a CORREOS_PRUEBAS el correo de rechazo por vigencia, con datos ficticios. */
function probarRechazoVigencia() {
  const respuestas = [['Nombre Completo del Contratante', 'Contratante de Prueba'], ['Correo Electronico', 'prueba@example.com'],
    ['Producto Elegido', 'Master'], ['Nombre Completo', 'Asegurado de Prueba'], ['Fecha de Nacimiento', '1943-03-10']]
    .map(function (r) { return { titulo: r[0], texto: r[1], archivos: [] }; });
  const hoy = soloFecha_(new Date());
  const solicitud = {
    respuestas: respuestas, archivos: [], fecha: new Date(), folio: 'SEGURO_VIAJE_+79-15D-FRA-01122026-0001',
    vigencia: { estado: 'VENCIDA', envio: sumarDiasHabiles_(hoy, -6), salida: sumarDiasHabiles_(hoy, 4), vence: sumarDiasHabiles_(hoy, -3) }
  };
  const payload = construirRechazoVigencia_(solicitud);
  const pruebas = desviarAPruebas_(payload);
  enviarAPowerAutomate_(payload);
  Logger.log('✅ Enviado el rechazo por vigencia de prueba a ' + pruebas);
}

/**
 * Revisa la conexión con la hoja de propuestas SIN enviar nada: toma el
 * folio más reciente de la primera pestaña y calcula su vigencia.
 * Ejecútala una vez después de pegar ID_HOJA_PROPUESTAS: también autoriza
 * al script a leer Hojas de cálculo (sin esa autorización el activador falla).
 */
function probarVigencia() {
  const V = CONFIG_EMISION.VIGENCIA;
  if (!V.ID_HOJA_PROPUESTAS) {
    Logger.log('❌ Falta pegar ID_HOJA_PROPUESTAS en CONFIG_EMISION.VIGENCIA.');
    return;
  }
  const hoja = SpreadsheetApp.openById(V.ID_HOJA_PROPUESTAS).getSheets()[0];
  const valores = hoja.getDataRange().getValues();
  const patron = /SEGURO_VIAJE_\S+-\d{8}-\d{4,}/;
  for (let f = valores.length - 1; f >= 1; f--) {
    for (let c = 0; c < valores[f].length; c++) {
      const m = String(valores[f][c]).match(patron);
      if (!m) continue;
      const r = validarVigencia_({ folio: m[0], fecha: new Date() });
      Logger.log('Folio más reciente: ' + m[0] + ' (fila ' + (f + 1) + ')');
      Logger.log(r.estado === 'SIN_VALIDAR'
        ? '⚠️ ' + r.motivo
        : (r.estado === 'VIGENTE' ? '✅ VIGENTE' : '⛔ VENCIDA') + ' · enviada ' + fechaTexto_(r.envio) +
          ' · salida ' + fechaTexto_(r.salida) + ' · vence ' + fechaTexto_(r.vence));
      return;
    }
  }
  Logger.log('⚠️ No encontré folios con consecutivo en "' + hoja.getName() + '". ' +
    'Revisa que exista la columna "Folio de propuesta" o "Estado de envío" en la hoja de propuestas.');
}

// ============================================================================
// 7. DIAGNÓSTICO DEL FORMULARIO
// ============================================================================

/**
 * Revisa el formulario contra lo que espera este script, sin enviar nada.
 * Ejecútala desde el editor y copia el Registro de ejecución:
 *  - ✅/❌ por cada dato que necesitan el TCI y el TCC.
 *  - Lista de todas las preguntas (tipo y si es obligatoria), marcando con
 *    "→ Otros" las que no están en SECCIONES (igual salen en el correo a
 *    Seguro de Viaje, pero al final).
 */
function revisarFormulario() {
  const items = FormApp.getActiveForm().getItems().filter(function (item) {
    return [FormApp.ItemType.SECTION_HEADER, FormApp.ItemType.PAGE_BREAK, FormApp.ItemType.IMAGE,
      FormApp.ItemType.VIDEO].indexOf(item.getType()) === -1;
  });
  const titulos = items.map(function (item) { return normalizar_(item.getTitle()); });
  const existe = function (opciones) {
    return opciones.some(function (t) { return titulos.indexOf(normalizar_(t)) !== -1; });
  };

  Logger.log('=== DATOS QUE USA EL TCI / TCC ===');
  let faltantes = 0;
  Object.keys(CONFIG_EMISION.PREGUNTAS).forEach(function (clave) {
    const ok = existe(CONFIG_EMISION.PREGUNTAS[clave]);
    if (!ok) faltantes++;
    Logger.log((ok ? '✅ ' : '❌ ') + clave + ' — se busca como: "' + CONFIG_EMISION.PREGUNTAS[clave].join('" o "') + '"');
  });

  const enSecciones = [].concat.apply([], CONFIG_EMISION.SECCIONES.map(function (s) { return s.preguntas; }))
    .map(normalizar_);
  Logger.log('=== TODAS LAS PREGUNTAS DEL FORMULARIO (' + items.length + ') ===');
  items.forEach(function (item, i) {
    const omitida = CONFIG_EMISION.OMITIR.some(function (re) { return re.test(item.getTitle()); });
    const nota = omitida ? '' : (enSecciones.indexOf(normalizar_(item.getTitle())) === -1 ? '   → Otros' : '');
    // Apps Script no deja leer si una carga de archivos es obligatoria.
    const obligatoria = item.getType() === FormApp.ItemType.FILE_UPLOAD ? ', revisar a mano si es obligatoria'
      : (esObligatoria_(item) ? ', obligatoria' : '');
    Logger.log((i + 1) + '. "' + item.getTitle() + '" [' + item.getType() + obligatoria + ']' + nota);
  });
  Logger.log(faltantes ? '⚠️ Faltan ' + faltantes + ' datos para el TCI/TCC (ver ❌ arriba).' : '✅ El formulario tiene todo lo que necesita el TCI/TCC.');
}

function esObligatoria_(item) {
  const T = FormApp.ItemType;
  const conversion = {};
  conversion[T.TEXT] = 'asTextItem'; conversion[T.PARAGRAPH_TEXT] = 'asParagraphTextItem';
  conversion[T.LIST] = 'asListItem'; conversion[T.MULTIPLE_CHOICE] = 'asMultipleChoiceItem';
  conversion[T.CHECKBOX] = 'asCheckboxItem'; conversion[T.DATE] = 'asDateItem';
  conversion[T.SCALE] = 'asScaleItem'; conversion[T.TIME] = 'asTimeItem';
  conversion[T.DATETIME] = 'asDateTimeItem'; conversion[T.GRID] = 'asGridItem';
  const metodo = conversion[item.getType()];
  try {
    return metodo ? item[metodo]().isRequired() : false;
  } catch (e) {
    return false;
  }
}

/**
 * Imprime los identificadores "entry.NNNN" de las preguntas que se prellenan
 * desde el QR / botón de la propuesta, listos para copiar en
 * CONFIG.PREFILL_EMISION del script Cotizaciones 2026. No envía nada.
 */
function obtenerIdsPrellenado() {
  const form = FormApp.getActiveForm();
  const T = FormApp.ItemType;
  const buscadas = [
    ['FOLIO', 'Folio de la propuesta'],
    ['DESTINO', 'Destino'],
    ['FECHA_SALIDA', 'Fecha de Salida'],
    ['FECHA_REGRESO', 'Fecha de Regreso']
  ];
  const lineas = buscadas.map(function (par) {
    const item = form.getItems().filter(function (i) { return normalizar_(i.getTitle()) === normalizar_(par[1]); })[0];
    if (!item) return '    ' + par[0] + ": '',   // ❌ no encontré la pregunta \"" + par[1] + '"';
    let respuesta;
    if (item.getType() === T.TEXT) respuesta = item.asTextItem().createResponse('x');
    else if (item.getType() === T.PARAGRAPH_TEXT) respuesta = item.asParagraphTextItem().createResponse('x');
    else if (item.getType() === T.DATE) respuesta = item.asDateItem().createResponse(new Date());
    else return '    ' + par[0] + ": '',   // ❌ \"" + par[1] + '" es de tipo ' + item.getType() + '; debe ser respuesta corta o fecha';
    const url = form.createResponse().withItemResponse(respuesta).toPrefilledUrl();
    const id = (url.match(/entry\.\d+/) || [''])[0];
    return '    ' + par[0] + ": '" + id + "',   // " + par[1];
  });
  Logger.log('Copia esto y pégaselo a Claude (o en PREFILL_EMISION de Cotizaciones 2026):\n' +
    '  PREFILL_EMISION: {\n' + lineas.join('\n') + '\n  },');
}
