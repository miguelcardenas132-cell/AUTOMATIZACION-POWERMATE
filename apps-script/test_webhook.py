#!/usr/bin/env python3
"""Simula el POST que Apps Script envía al webhook de Power Automate.

Sirve para probar el flujo de Power Automate sin pasar por el formulario.
Usa los cuerpos de correo y la propuesta de /ejemplos (generados con
`node herramientas/generar_ejemplos.js`), así que lo que llega al buzón se ve
igual que en producción, con datos ficticios.

Uso (desde la raíz del repo):
    # Propuesta aprobada (adjunta el PDF de la propuesta)
    python3 apps-script/test_webhook.py "https://...invoke?..." --email tu@correo.com

    # Propuesta aprobada individual
    python3 apps-script/test_webhook.py "https://..." --asegurados 1

    # Rechazos (sin adjuntos)
    python3 apps-script/test_webhook.py "https://..." --estatus RECHAZADO_TIEMPO
    python3 apps-script/test_webhook.py "https://..." --estatus RECHAZADO_FECHAS
    python3 apps-script/test_webhook.py "https://..." --estatus RECHAZADO_SIN_ELEGIBLES
    python3 apps-script/test_webhook.py "https://..." --estatus RECHAZADO_EXCESO_ASEGURADOS
"""
import argparse
import base64
import json
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

EJEMPLOS = Path(__file__).resolve().parent.parent / "ejemplos"

CUERPOS_RECHAZO = {
    "RECHAZADO_TIEMPO": "correo_rechazo_tiempo.html",
    "RECHAZADO_FECHAS": "correo_rechazo_fechas.html",
    "RECHAZADO_SIN_ELEGIBLES": "correo_rechazo_sin_elegibles.html",
    "RECHAZADO_EXCESO_ASEGURADOS": "correo_rechazo_exceso_asegurados.html",
}


def leer_ejemplo(nombre):
    ruta = EJEMPLOS / nombre
    if not ruta.exists():
        raise SystemExit(f"No existe {ruta}. Corre primero: node herramientas/generar_ejemplos.js")
    return ruta.read_text(encoding="utf-8")


def construir_payload(estatus, email, folio, asegurados):
    aprobado = estatus == "APROBADO"
    folio = folio or f"SEGURO_VIAJE_+79-PRUEBA-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    nomenclatura = f"Propuesta Seguro de Viaje Senior +79 - 01122026 // 15D, FRA {datetime.now().strftime('%d%m%Y')}"

    if aprobado:
        html_propuesta = leer_ejemplo("propuesta_aprobada.html")
        asunto = f"[PRUEBA] {nomenclatura}"
        cuerpo = leer_ejemplo("correo_aprobado.html")
        html_b64 = base64.b64encode(html_propuesta.encode("utf-8")).decode("ascii")
        nombre_archivo = nomenclatura.replace(" // ", " - ") + ".pdf"
    else:
        asunto = "[PRUEBA] Solicitud de Propuesta de Seguro no procesada"
        cuerpo = leer_ejemplo(CUERPOS_RECHAZO[estatus])
        html_b64 = nombre_archivo = ""

    return {
        "emailCliente": email,
        "correoCC": "",
        "asunto": asunto,
        "estatus": estatus,
        "cuerpoCorreoHtml": cuerpo,
        "tipoProducto": "Grupal" if asegurados > 1 else "Individual",
        "htmlBase64": html_b64,
        "nombreArchivo": nombre_archivo,
        "folio": folio,
        "htmlFileId": "",
        "fechaGeneracion": datetime.now(timezone.utc).isoformat(),
    }


def main():
    parser = argparse.ArgumentParser(description="Prueba el webhook de Power Automate simulando el payload de Apps Script.")
    parser.add_argument("url", help="URL del trigger HTTP de Power Automate")
    parser.add_argument("--estatus", default="APROBADO", choices=["APROBADO", *CUERPOS_RECHAZO])
    parser.add_argument("--email", default="prueba@example.com", help="A quién llega el correo de prueba")
    parser.add_argument("--asegurados", type=int, default=3, choices=range(1, 6),
                        help="1 = Individual; 2 a 5 = Grupal (tipoProducto)")
    parser.add_argument("--folio", default=None)
    args = parser.parse_args()

    payload = construir_payload(args.estatus, args.email, args.folio, args.asegurados)
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    resumen = dict(payload)
    resumen["cuerpoCorreoHtml"] = f"[{len(payload['cuerpoCorreoHtml'])} caracteres]"
    resumen["htmlBase64"] = f"[{len(payload['htmlBase64'])} caracteres]"
    print("Payload enviado:")
    print(json.dumps(resumen, indent=2, ensure_ascii=False))

    req = urllib.request.Request(
        args.url,
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as respuesta:
            print(f"\nStatus: {respuesta.status}")
            print("Respuesta:", respuesta.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        print(f"\nStatus: {error.code}")
        print("Respuesta:", error.read().decode("utf-8"))
    except urllib.error.URLError as error:
        print(f"\nError de conexión: {error.reason}")


if __name__ == "__main__":
    main()
