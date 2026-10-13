#!/usr/bin/env node
/**
 * Genera los ejemplos de /ejemplos con el código real de Apps Script, sin
 * tocar Google: carga APPS_SCRIPT_SIMPLIFICADO_FINAL.js, ASSETS_BASE64.gs y
 * QR_GENERADOR.gs
 * con sustitutos mínimos de los servicios de Apps Script y escribe:
 *
 *   ejemplos/propuesta_aprobada.html   HTML que Power Automate convierte a PDF
 *   ejemplos/correo_aprobado.html      Cuerpo del correo aprobado
 *   ejemplos/correo_rechazo_*.html     Un cuerpo por cada motivo de rechazo
 *
 * Uso (desde la raíz del repo):  node herramientas/generar_ejemplos.js
 *
 * Para obtener el PDF del ejemplo, imprime propuesta_aprobada.html con
 * Chrome/Chromium en tamaño carta (o ábrelo y usa Imprimir > Guardar PDF).
 * Los datos son ficticios.
 */
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const salida = path.join(raiz, 'ejemplos');

const sustitutos = `
var Logger = { log: function () {} };
var PropertiesService = { getScriptProperties: function () { return { getProperty: function () { return null; } }; } };
var SpreadsheetApp = {}; var DriveApp = {}; var UrlFetchApp = {};
var Session = { getScriptTimeZone: function () { return 'America/Mexico_City'; } };
var Utilities = { formatDate: function (fecha, tz, formato) {
  var p2 = function (n) { return String(n).padStart(2, '0'); };
  var f = p2(fecha.getDate()) + '/' + p2(fecha.getMonth() + 1) + '/' + fecha.getFullYear();
  if (formato === 'yyyy-MM-dd') return fecha.getFullYear() + '-' + p2(fecha.getMonth() + 1) + '-' + p2(fecha.getDate());
  return formato === 'dd/MM/yyyy HH:mm:ss' ? f + ' ' + p2(fecha.getHours()) + ':' + p2(fecha.getMinutes()) + ':00' : f;
} };
var __gas = {};`;

const codigo = fs.readFileSync(path.join(raiz, 'apps-script/APPS_SCRIPT_SIMPLIFICADO_FINAL.js'), 'utf8');
const assets = fs.readFileSync(path.join(raiz, 'apps-script/ASSETS_BASE64.gs'), 'utf8');
const qr = fs.readFileSync(path.join(raiz, 'apps-script/QR_GENERADOR.gs'), 'utf8');
// eslint-disable-next-line no-eval
eval(sustitutos + assets + qr + codigo +
  ';__gas.CONFIG = CONFIG; __gas.datos = construirDatosSolicitud_; __gas.pdf = generarHtmlCotizacion_;' +
  '__gas.aprobado = construirCorreoAprobado_; __gas.rechazo = construirCorreoRechazo_;');

const C = __gas.CONFIG;
const DIA = 24 * 60 * 60 * 1000;
const hoy = new Date();

function solicitud(diasHastaSalida, diasViaje, pasajeros) {
  const inicio = new Date(hoy.getTime() + diasHastaSalida * DIA);
  const fin = new Date(inicio.getTime() + diasViaje * DIA);
  const encabezados = [C.COL_PERFIL, C.COL_AGENTE_INFO, C.COL_NOMBRE_SOLICITANTE, C.COL_EMAIL_CLIENTE,
    C.COL_CORREO_CC, C.COL_DESTINO, C.COL_FECHA_INICIO, C.COL_FECHA_FIN, C.COL_FOLIO,
    C.COL_PRIMA_MASTER, C.COL_PRIMA_SMART, C.COL_PRIMA_ELITE, C.COL_PRIMA_PREMIUM];
  const valores = ['Soy Agente', 'A-0000 Agente de Ejemplo', 'Nombre de Ejemplo', 'prueba@example.com', '',
    'Francia', inicio, fin, 'SEGURO_VIAJE_+79-EJEMPLO', 127.32, 145.06, 159.41, 170.58];
  pasajeros.forEach(function (p, i) {
    encabezados.push('Nombre Asegurado ' + (i + 1), 'Fecha de Nacimiento Asegurado ' + (i + 1));
    valores.push(p[0], new Date(inicio.getFullYear() - p[1], inicio.getMonth(), inicio.getDate()));
  });
  return __gas.datos(2, encabezados, valores);
}

function envolver(cuerpo) {
  return '<!DOCTYPE html>\n<html lang="es"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
    '<body style="margin:0;">' + cuerpo + '</body></html>\n';
}

const tres = [['Asegurado Uno', 82], ['Asegurado Dos', 85], ['Asegurado Tres', 80]];
const seis = tres.concat([['Asegurado Cuatro', 81], ['Asegurado Cinco', 84], ['Asegurado Seis', 87]]);

const aprobado = solicitud(20, 14, tres.concat([['Pasajero Excluido', 65]]));
const rechazos = {
  fechas: solicitud(20, -3, tres),
  tiempo: solicitud(2, 10, tres),
  sin_elegibles: solicitud(20, 10, [['Pasajero Excluido', 65], ['Otro Excluido', 71]]),
  exceso_asegurados: solicitud(20, 10, seis)
};

fs.mkdirSync(salida, { recursive: true });
fs.writeFileSync(path.join(salida, 'propuesta_aprobada.html'), __gas.pdf(aprobado));
fs.writeFileSync(path.join(salida, 'correo_aprobado.html'), envolver(__gas.aprobado(aprobado)));
console.log('propuesta_aprobada.html / correo_aprobado.html -> ' + aprobado.estatus);
Object.keys(rechazos).forEach(function (motivo) {
  const data = rechazos[motivo];
  fs.writeFileSync(path.join(salida, 'correo_rechazo_' + motivo + '.html'), envolver(__gas.rechazo(data)));
  console.log('correo_rechazo_' + motivo + '.html -> ' + data.estatus);
});
