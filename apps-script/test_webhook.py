#!/usr/bin/env python3
"""Simula el POST que Apps Script envía al webhook de Power Automate.

Uso:
    python3 test_webhook.py "https://prod-XX.westus.logic.azure.com/...invoke?..." \
        --destino Brasil --email prueba@example.com
"""
import argparse
import json
import urllib.error
import urllib.request
from datetime import datetime, timezone


def construir_payload(destino, email, folio):
    num_asegurados = 2
    return {
        "htmlFileId": "1AbCDeFGhIjKlMnOpQrStUvWxYz_ID_DE_PRUEBA",
        "htmlFileUrl": "https://drive.google.com/file/d/1AbCDeFGhIjKlMnOpQrStUvWxYz_ID_DE_PRUEBA/view",
        "nombreArchivo": "Cotizacion_PRUEBA.html",
        "folio": folio or f"COT-TEST-{datetime.now().strftime('%Y%m%d-%H%M%S')}",
        "emailCliente": email,
        "correoCC": "contacto@example.com",
        "destino": destino,
        "fechaInicio": "18/08/2026",
        "fechaFin": "28/08/2026",
        "cantidadDias": "11",
        "vigenciaCotizacion": "10 de agosto de 2026",
        "numAsegurados": num_asegurados,
        "listaAsegurados": "Roberto García (82 años), María López (85 años)",
        "tipoProducto": "Grupal" if num_asegurados > 1 else "Individual",
        "primaMaster": 45.5,
        "primaSmart": 65,
        "primaElite": 95,
        "primaPremium": 125,
        "fechaGeneracion": datetime.now(timezone.utc).isoformat()
    }


def main():
    parser = argparse.ArgumentParser(description="Prueba el webhook de Power Automate simulando el payload de Apps Script.")
    parser.add_argument("url", help="URL del trigger HTTP de Power Automate")
    parser.add_argument("--destino", default="Brasil")
    parser.add_argument("--email", default="prueba@example.com")
    parser.add_argument("--folio", default=None)
    args = parser.parse_args()

    payload = construir_payload(args.destino, args.email, args.folio)
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    print("Payload enviado:")
    print(json.dumps(payload, indent=2, ensure_ascii=False))

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
