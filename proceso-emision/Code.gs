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
 *      con la Constancia de Situación Fiscal adjunta.
 *   2) SOLICITUD DE TCC -> Cotizaciones Daños. Solo datos del contratante.
 *   3) SOLICITUD DE EMISIÓN -> Seguro de Viaje. Toda la información del
 *      formulario, con todos los archivos que subió el cliente.
 *
 * Los tres llevan siempre en copia a CONFIG_EMISION.COPIA_SIEMPRE.
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

  // Único destinatario de probarCorreosEmision(), para no molestar a nadie más.
  CORREO_PRUEBAS: 'mhidalgo@segurosatlas.com.mx',

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
    NOMBRE_AGENTE: ['Nombre de Agente'],
    CLAVE_AGENTE: ['Clave de Agente'],
    CLAVE_EJECUTIVO: ['Clave de tu Ejecutivo', 'Clave del Ejecutivo'],
    NOMBRE_EJECUTIVO: ['Nombre de tu Ejecutivo', 'Nombre del Ejecutivo'],
    SUCURSAL: ['Sucursal', 'Clave de Sucursal'],
    CONTRATANTE: ['Nombre Completo del Contratante'],
    DOMICILIO: ['Domicilio del Contratante (Calle, No. Ext y/o Int, Colonia, Municipio o Delegación, C.P.)',
      'Domicilio del Contratante'],
    RFC: ['RFC'],
    CURP: ['CURP (PERSONA FISICA)', 'CURP'],
    CORREO: ['Correo Electronico', 'Correo Electrónico'],
    TELEFONO: ['Teléfono', 'Telefono'],
    OCUPACION: ['Ocupación', 'Ocupacion'],
    // Archivos. Si el formulario pide la CSF en su propia pregunta, solo esa
    // va al TCI; si la CSF comparte pregunta con la INE, va todo lo de ahí.
    CSF: ['Adjunta tu CSF (Constancia de Situación Fiscal)', 'Constancia de Situación Fiscal (CSF)',
      'Adjunta tu CSF (Constancia de Situación Fiscal) o INE o Identificación Migratoria de residencia mexicana']
  },

  /**
   * Orden y agrupación del correo completo para Seguro de Viaje. Lo que no
   * esté en esta lista sale al final en "Otros", para no perder nada.
   */
  SECCIONES: [
    {
      titulo: 'Información para emisión',
      preguntas: ['Nombre de Agente', 'Clave de Agente', 'Clave de tu Ejecutivo', 'Nombre de tu Ejecutivo',
        'Sucursal', 'Producto Elegido', 'Costo en USD', 'Adjunta la cotización recibida',
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
      preguntas: ['Nombre Completo', 'Fecha de Nacimiento', 'Contacto de Emergencia',
        'Teléfono Contacto de Emergencia', 'Nombre Beneficiario',
        'Domicilio del Asegurado (Calle, No. Ext y/o Int, Colonia, Municipio o Delegación, C.P.)']
    }
  ].concat([2, 3, 4, 5].map(function (n) {
    return {
      titulo: 'Asegurado ' + n,
      preguntas: ['Nombre Completo ' + n, 'Fecha de Nacimiento ' + n, 'Contacto de Emergencia ' + n,
        'Teléfono Contacto de Emergencia ' + n, 'Nombre Beneficiario ' + n]
    };
  })),

  // Preguntas de control que no aportan nada al correo.
  OMITIR: [/^¿deseas agregar/i]
};

const COLORES_EMISION = { VERDE: '#027370', VERDE_CLARO: '#e6f4f3', GRIS: '#f4f5f7', TEXTO: '#222222' };
const FUENTE_EMISION = "Aptos,'Aptos Display',Calibri,Arial,sans-serif";

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
  enviarAPowerAutomate_(construirCorreos_(solicitud));
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
  return {
    respuestas: respuestas,
    archivos: todosLosArchivos,
    folio: buscarFolio_(todosLosArchivos),
    fecha: new Date()
  };
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

/** "G00 - Guadalajara" -> "G00". Si no trae clave, se deja como lo escribieron. */
function claveSucursal_(texto) {
  const clave = String(texto || '').toUpperCase().match(/\b[A-Z]\d{2}\b/);
  return clave ? clave[0] : String(texto || '').trim();
}

/**
 * Lee el folio del PDF de la propuesta adjunta (OCR de Drive API v2).
 * Acepta el folio actual de la hoja (SEGURO_VIAJE_+79-...) y el anterior
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
      const folio = texto.match(/SEGURO_VIAJE_\+?79-\d+D-[A-Z]{3}-\d{8}|COT-\d+-\d{8}-\d{6}/);
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
// 4. CORREOS
// ============================================================================

function construirCorreos_(solicitud) {
  const datos = datosContratante_(solicitud);
  const csf = buscarRespuesta_(solicitud, CONFIG_EMISION.PREGUNTAS.CSF);
  const copia = CONFIG_EMISION.COPIA_SIEMPRE.filter(function (c) { return c; }).join(';');

  return {
    folio: solicitud.folio,
    correos: [
      {
        tipo: 'TCI',
        para: CONFIG_EMISION.CORREO_TCI,
        cc: copia,
        asunto: 'SOLICITUD DE TCI || NUEVA POLIZA || ' + datos.sucursal,
        cuerpoHtml: correoTramite_('TCI', datos),
        adjuntos: adjuntosPayload_(csf ? csf.archivos : [])
      },
      {
        tipo: 'TCC',
        para: CONFIG_EMISION.CORREO_TCC,
        cc: copia,
        asunto: 'SOLICITUD DE TCC || NUEVA POLIZA || ' + datos.sucursal,
        cuerpoHtml: correoTramite_('TCC', datos),
        adjuntos: []
      },
      {
        tipo: 'SEGURO_VIAJE',
        para: CONFIG_EMISION.CORREO_SEGURO_VIAJE,
        cc: copia,
        asunto: 'SOLICITUD DE EMISIÓN || SENIOR +79 || ' + datos.contratante +
          (solicitud.folio ? ' || ' + solicitud.folio : ''),
        cuerpoHtml: correoSeguroViaje_(solicitud, datos),
        adjuntos: adjuntosPayload_(solicitud.archivos)
      }
    ]
  };
}

function datosContratante_(solicitud) {
  const rfc = valor_(solicitud, 'RFC').toUpperCase();
  const moral = esPersonaMoral_(rfc);
  const oNA = function (texto) { return String(texto || '').trim() || 'N/A'; };
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
    return '<p style="margin:0 0 ' + (extra || 0) + 'px 0;font-family:' + FUENTE_EMISION + ';font-size:11pt;color:#000000;">' +
      html + '</p>';
  };
  const renglon = function (etiqueta, valorHtml) {
    return '<li style="margin:0;font-family:' + FUENTE_EMISION + ';font-size:11pt;color:#000000;">' +
      etiqueta + ': <strong>' + valorHtml + '</strong></li>';
  };
  const correo = d.correo
    ? '<a href="mailto:' + escapar_(d.correo) + '" style="color:#467886;">' + escapar_(d.correo) + '</a>'
    : 'N/A';

  return '<div style="font-family:' + FUENTE_EMISION + ';font-size:11pt;color:#000000;">' +
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
      '<li style="margin:0;font-family:' + FUENTE_EMISION + ';font-size:11pt;color:#000000;">Correo Electrónico: ' +
        correo + '</li>' +
      renglon('Ejecutivo', '<span style="background-color:#ffff00;">' + escapar_(d.ejecutivo) + '</span>') +
    '</ol>' +
    p('Saludos.', 14) +
    firmaTexto_() +
  '</div>';
}

/** Correo completo para Seguro de Viaje: todo el formulario por secciones. */
function correoSeguroViaje_(solicitud, d) {
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
            'padding:8px 12px;margin-bottom:10px;">' + folio + '</div>' +
          'Se recibió una solicitud de emisión desde el formulario. Ya se enviaron en automático la ' +
          '<strong>solicitud de TCI</strong> a Mesa Control Daños y la <strong>solicitud de TCC</strong> a ' +
          'Cotizaciones Daños (contratante: <strong>' + escapar_(d.contratante) + '</strong>, persona ' +
          (d.personaMoral ? 'moral' : 'física') + '). Los archivos que subió el cliente van adjuntos.' +
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

function firmaTexto_() {
  const linea = function (html, estilo) {
    return '<div style="font-family:' + FUENTE_EMISION + ';font-size:10pt;line-height:1.5;color:#222222;' + (estilo || '') + '">' +
      html + '</div>';
  };
  return linea('Seguro de Viaje', 'font-size:11pt;font-weight:bold;color:' + COLORES_EMISION.VERDE + ';') +
    linea('DINE (Dirección de Negocios Especiales)') +
    linea('<strong>Tel.</strong> (55) 9177 &ndash; 5000 Ext. 5114') +
    linea('<strong>Correo:</strong> <a href="mailto:segurodeviaje@segurosatlas.com.mx" style="color:' +
      COLORES_EMISION.VERDE + ';">segurodeviaje@segurosatlas.com.mx</a>');
}

function escapar_(texto) {
  return String(texto === null || texto === undefined ? '' : texto)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
 * flujo sin llenar el formulario. Los asuntos llevan [PRUEBA] y TODOS los
 * correos van solo a CORREO_PRUEBAS, nunca a Mesa Control ni a Cotizaciones.
 */
function probarCorreosEmision() {
  const respuestas = [
    ['Nombre de Agente', 'OML, Agente de Seguros y de Fianzas SA de CV'], ['Clave de Agente', '13991'],
    ['Clave de tu Ejecutivo', '570'], ['Nombre de tu Ejecutivo', 'Lucero Guadalupe Borbón Nieblas'],
    ['Sucursal', 'G00'], ['Producto Elegido', 'Master Elite'], ['Costo en USD', '159.41'],
    ['Destino', 'Francia'], ['Fecha de Salida', '2026-12-01'], ['Fecha de Regreso', '2026-12-15'],
    ['Nombre Completo del Contratante', 'Omnilife de México S.A. de C.V.'],
    ['Domicilio del Contratante (Calle, No. Ext y/o Int, Colonia, Municipio o Delegación, C.P.)',
      'Av. Inglaterra 3089, Vallarta Poniente, Guadalajara, C.P. 44110'],
    ['RFC', 'OME910520I31'], ['CURP (PERSONA FISICA)', ''], ['Correo Electronico', 'lborbon.gdl@segurosatlas.com.mx'],
    ['Teléfono', ''], ['Ocupación', ''],
    ['Nombre Completo', 'Roberto García'], ['Fecha de Nacimiento', '1943-03-10'],
    ['Contacto de Emergencia', 'Ana García'], ['Teléfono Contacto de Emergencia', '3312345678'],
    ['Nombre Beneficiario', 'Ana García'], ['¿Deseas agregar un segundo asegurado?', 'No']
  ].map(function (r) { return { titulo: r[0], texto: r[1], archivos: [] }; });

  const payload = construirCorreos_({ respuestas: respuestas, archivos: [], folio: '', fecha: new Date() });
  payload.correos.forEach(function (correo) {
    correo.asunto = '[PRUEBA] ' + correo.asunto;
    correo.para = CONFIG_EMISION.CORREO_PRUEBAS;
    correo.cc = '';
  });
  enviarAPowerAutomate_(payload);
  Logger.log('✅ Enviados ' + payload.correos.length + ' correos de prueba a ' + CONFIG_EMISION.CORREO_PRUEBAS);
}
