"""Convierte los SLIP originales en plantillas: quita los datos de asegurados
anteriores y deja una fila modelo con marcas %%C1%%..%%C6%% entre
%%FILA_INICIO%% y %%FILA_FIN%%. Elite recibe la tabla de 6 columnas de Master."""
import sys, os
src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)

CELDAS = ('\\pard\\plain \\ltrpar\\qc \\li0\\ri0\\widctlpar\\intbl\\wrapdefault\\aspalpha\\aspnum\\faauto\\adjustright\\rin0\\lin0\\yts15 '
          '\\rtlch\\fcs1 \\af0\\afs22\\alang1025 \\ltrch\\fcs0 \\f31506\\fs22\\lang2058\\langfe1033\\cgrid\\langnp2058\\langfenp1033 '
          + ''.join('{\\rtlch\\fcs1 \\af1\\afs14 \\ltrch\\fcs0 \\f1\\fs14 %%C' + str(i) + '%%\\cell }' for i in range(1, 7)))

def leer(n):
    s = open(os.path.join(src, n), encoding='ascii').read()
    # El original de Master trae "NACIMI/ENTO": se quita la diagonal suelta.
    return s.replace('{\\rtlch\\fcs1 \\ab\\af1\\afs14 \n\\ltrch\\fcs0 \\b\\f1\\fs14\\insrsid8995918 /}', '')

def tabla_6(s):
    a = s.find('ASEGURADO'); t0 = s.find('\\trowd', a)
    lr = s.find('\\lastrow', t0)
    inicio_fila = s.rfind('\\trowd', t0, lr)
    lr2 = s.find('\\lastrow', lr + 10)
    fin = s.find('\\row }', lr2) + len('\\row }')
    fila = s[inicio_fila:fin]
    rowdef = fila[:fila.find('\\pard')]
    i2 = fila.rfind('\\trowd'); j = fila.rfind('{', 0, i2); k = fila.rfind('\\pard', 0, j)
    modelo = '%%FILA_INICIO%%' + rowdef + CELDAS + fila[k:] + '%%FILA_FIN%%'
    return t0, inicio_fila, fin, s[t0:inicio_fila], modelo

salidas = {
    'MASTER': 'SLIP_MASTER_79_.rtf', 'MASTER_SMART': 'SLIP_MASTER_SMART_79_.rtf',
    'MASTER_PREMIUM': 'SLIP_MASTER_PREMIUM_79_.rtf',
}
master = leer('SLIP_MASTER_79_.rtf')
_, _, _, enc_master, modelo_master = tabla_6(master)
for plan, n in salidas.items():
    s = leer(n)
    t0, ini, fin, enc, modelo = tabla_6(s)
    out = s[:ini] + modelo + s[fin:]
    open(os.path.join(dst, 'PLANTILLA_SLIP_' + plan + '.rtf'), 'w', encoding='ascii').write(out)

# Elite: reemplaza su tabla de 3 columnas completa por la de 6 de Master.
s = leer('SLIP_MASTER_ELITE_79_.rtf')
a = s.find('ASEGURADO'); t0 = s.find('\\trowd', a)
lr = s.find('\\lastrow', t0); fin = s.find('\\row }', lr) + len('\\row }')
out = s[:t0] + enc_master + modelo_master + s[fin:]
open(os.path.join(dst, 'PLANTILLA_SLIP_MASTER_ELITE.rtf'), 'w', encoding='ascii').write(out)
print('ok')
