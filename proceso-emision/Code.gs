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

  /**
   * MODO PRUEBAS. Mientras esté en true, los tres correos de cada envío real
   * del formulario (TCI, TCC y solicitud general) llegan SOLO a
   * CORREOS_PRUEBAS, con [PRUEBA] en el asunto y un aviso arriba que dice a
   * quién iría en producción. Nunca llegan a Mesa Control ni a Cotizaciones.
   * Para pasar a producción: cambiar a false y guardar.
   */
  MODO_PRUEBAS: true,
  CORREOS_PRUEBAS: [
    'mhidalgo@segurosatlas.com.mx'
    // , 'equintanar@segurosatlas.com.mx'  // descomentar para que Eloisa también reciba las pruebas
  ],

  // Firma de los tres correos (misma que usa el equipo en Outlook).
  FIRMA: {
    TELEFONO: '(55) 9177 &ndash; 5000 Ext. 4931 Cel: 55 1322 6276',
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
  const payload = construirCorreos_(solicitud);
  if (CONFIG_EMISION.MODO_PRUEBAS) desviarAPruebas_(payload);
  enviarAPowerAutomate_(payload);
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

/** Firma del equipo: mismos colores y renglones que la firma de Outlook. */
function firmaTexto_() {
  const F = CONFIG_EMISION.FIRMA;
  // Arial: 12 pt el nombre, 9 pt "DINE" y 8 pt el resto (estilo de la firma de Outlook).
  const linea = function (html, estilo) {
    return '<div style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:8pt;line-height:1.35;' + estilo + '">' +
      html + '</div>';
  };
  const etiqueta = function (texto) { return '<strong style="color:#80340d;">' + texto + '</strong>'; };
  return linea('Seguro de Viaje', 'font-size:12pt;font-weight:bold;color:#0f4761;') +
    linea('DINE (Dirección de Negocios Especiales)', 'font-size:9pt;color:#7f7f7f;') +
    linea('&nbsp;', 'color:#595959;') +
    linea(etiqueta('Tel.') + ' ' + F.TELEFONO, 'color:#595959;') +
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
 * flujo sin llenar el formulario. Siempre van solo a CORREOS_PRUEBAS, aunque
 * MODO_PRUEBAS esté en false.
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
    ['Nombre Completo', 'Roberto García'], ['Fecha de Nacimiento', '1943-03-10'],
    ['Contacto de Emergencia', 'Ana García'], ['Teléfono Contacto de Emergencia', '3312345678'],
    ['Nombre Beneficiario', 'Ana García'], ['¿Deseas agregar un segundo asegurado?', 'No']
  ].map(function (r) { return { titulo: r[0], texto: r[1], archivos: [] }; });

  const payload = construirCorreos_({ respuestas: respuestas, archivos: [], folio: '', fecha: new Date() });
  const pruebas = desviarAPruebas_(payload);
  enviarAPowerAutomate_(payload);
  Logger.log('✅ Enviados ' + payload.correos.length + ' correos de prueba a ' + pruebas);
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
