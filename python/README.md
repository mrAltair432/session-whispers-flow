# Lovable Backtest — Python (Colab)

Laboratorio Python del proyecto Lovable Dashboard MT5. Reproduce en Python las
mismas 6 estrategias que corren en el dashboard TypeScript, con dos objetivos:

1. **Optimización masiva** de parámetros usando el procesador de Colab/Kaggle
   (no tu PC).
2. **Base para ML** (Random Forest, XGBoost, sklearn) sobre los mismos
   features que ya emite el motor TS.

## Modelo B — Lab vs Producción

| Rol | Herramienta | Cuándo |
|-----|-------------|--------|
| **Laboratorio** | Python / Colab (este paquete) | Optimización, walk-forward, ML |
| **Producción**  | Dashboard TypeScript | Validación visual, MQL5, envío a EA |

Ambos leen el **mismo spec** (`strategies_spec.json`) y ejecutan la **misma
lógica**. Una celda de paridad valida que los trades coinciden entre TS y
Python (tolerancia < 0.1%).

## Cómo usar en Colab

1. Sube este directorio (`python/`) o clona el repo entero en Colab.
2. Abre `backtest_lovable.ipynb`.
3. Ejecuta la celda 1: instala dependencias y carga la librería.
4. Ejecuta la celda 2: sube tus CSV M1/M5/M15/H1/H4 (mismos formatos que el
   dashboard: `YYYY.MM.DD HH:MM,open,high,low,close,volume` o
   `MM/DD/YYYY HH:MM,...`).
5. Ejecuta la celda 3: single backtest sanity check.
6. Ejecuta la celda 4: **grid optimizer** (paraleliza con `joblib`).
7. Ejecuta la celda 5: **walk-forward** (train/test rolling).
8. Ejecuta la celda 6: exporta el mejor set de parámetros a
   `best_params.json` para cargarlo en el dashboard.

## Estructura

```
python/
├── backtest_lovable.ipynb      Notebook Colab con 6 celdas listas.
├── lovable_backtest.py         Librería: indicadores + engine + estrategias.
├── strategies_spec.json        Spec compartido de parámetros (fuente única).
├── requirements.txt            Dependencias mínimas.
└── README.md                   Este archivo.
```

## Requisitos

Colab ya trae numpy/pandas/joblib. Solo si corres localmente:

```bash
pip install -r requirements.txt
```

## Contrato de paridad TS ↔ Python

Ambos motores comparten:

- **Simulador**: partials 50%/30%/20% en TP1/TP2/TP3, SL a BE tras TP1,
  timeout por `max_hold_bars`, costos por lado (spread/2 + slippage + commission).
- **Filtros de mercado**: sábado, domingo <22 UTC, viernes ≥21 UTC, gap lunes,
  pausa CME 22 UTC L-J.
- **Features**: mismo orden y normalización que `FEATURE_NAMES` en TS.
- **Latencia**: entrada en `open` de la barra `i+1+latency_bars`.

Cualquier discrepancia > 0.1% en R multiple debe considerarse **bug** en uno
de los dos motores y corregirse antes de continuar.

## Flujo típico

```
idea       → editar lovable_backtest.py (rama de estrategia)
optimizar  → celda 4 (grid) o celda 5 (walk-forward)
exportar   → best_params.json
validar    → cargar en dashboard, correr 3-6 meses visualmente
publicar   → dashboard emite señal → tabla mt5_signals → EA MT5 ejecuta
```

Nunca al revés: si editas primero en TS y luego olvidas Python, la paridad
se rompe y las optimizaciones futuras usan una lógica distinta.