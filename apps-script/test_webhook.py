#!/usr/bin/env python3
"""Simula el POST que Apps Script envía al webhook de Power Automate.

Uso:
    # Solicitud aprobada (con adjunto en base64)
    python3 test_webhook.py "https://prod-XX.westus.logic.azure.com/...invoke?..."

    # Solicitud rechazada por anticipación (sin adjunto)
    python3 test_webhook.py "https://..." --estatus RECHAZADO_TIEMPO
"""
import argparse
import base64
import json
import urllib.error
import urllib.request
from datetime import datetime, timezone

CUERPO_APROBADO = """<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:640px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#0d5e3a;border-collapse:collapse;">
<tr><td style="padding:14px 18px;"><div style="font-size:17px;font-weight:bold;color:#ffffff;">Cotizacion Seguro de Viaje SENIOR +79</div></td></tr>
</table>
<div style="padding:18px;border:1px solid #cbd5e1;border-top:none;">
<p>PRUEBA desde test_webhook.py — cuerpo simplificado.</p>
</div></div>"""

CUERPO_RECHAZO = """<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:640px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#0d5e3a;border-collapse:collapse;">
<tr><td style="padding:14px 18px;"><div style="font-size:17px;font-weight:bold;color:#ffffff;">Solicitud no procesada</div></td></tr>
</table>
<div style="padding:18px;border:1px solid #cbd5e1;border-top:none;">
<p>PRUEBA desde test_webhook.py — rechazo por anticipacion.</p>
</div></div>"""

HTML_ADJUNTO = "<html><head><meta charset=\"UTF-8\"></head><body><h1>Cotizacion de prueba</h1></body></html>"


def construir_payload(estatus, email, folio):
    aprobado = estatus == "APROBADO"
    folio = folio or f"COT-TEST-{datetime.now().strftime('%Y%m%d-%H%M%S')}"

    if aprobado:
        asunto = f"Cotizacion Seguro de Viaje SENIOR +79 — Brasil — Folio {folio}"
        cuerpo = CUERPO_APROBADO
        html_b64 = base64.b64encode(HTML_ADJUNTO.encode("utf-8")).decode("ascii")
        nombre_archivo = f"Cotizacion_{folio}.html"
    else:
        asunto = f"Solicitud no procesada — Seguro de Viaje SENIOR +79 — Folio {folio}"
        cuerpo = CUERPO_RECHAZO
        html_b64 = ""
        nombre_archivo = ""

    return {
        "emailCliente": email,
        "correoCC": "contacto@example.com",
        "asunto": asunto,
        "estatus": estatus,
        "cuerpoCorreoHtml": cuerpo,
        "tipoProducto": "Grupal",
        "htmlBase64": html_b64,
        "nombreArchivo": nombre_archivo,
        "folio": folio,
        "htmlFileId": "1AbCDeFGhIjKlMnOpQrStUvWxYz_ID_DE_PRUEBA" if aprobado else "",
        "fechaGeneracion": datetime.now(timezone.utc).isoformat()
    }


def main():
    parser = argparse.ArgumentParser(description="Prueba el webhook de Power Automate simulando el payload de Apps Script.")
    parser.add_argument("url", help="URL del trigger HTTP de Power Automate")
    parser.add_argument("--estatus", default="APROBADO", choices=["APROBADO", "RECHAZADO_TIEMPO", "RECHAZADO_SIN_ELEGIBLES"])
    parser.add_argument("--email", default="prueba@example.com")
    parser.add_argument("--folio", default=None)
    args = parser.parse_args()

    payload = construir_payload(args.estatus, args.email, args.folio)
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
