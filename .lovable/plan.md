# Trading Compass — Dashboard XAU/USD v1

Dashboard para decidir entradas manuales en la sesión de Londres (3 a.m.) sobre XAU/USD, con análisis multi-timeframe, motor de señales basado en tus reglas, calculadora de riesgo dinámica y alertas a Telegram. Solo tú lo usas por ahora.

## Lo que vamos a construir

### 1. Vista multi-timeframe (núcleo visual)
Tres gráficos sincronizados H4 / H1 / M15 de XAU/USD, lado a lado en desktop y apilados en mobile.
- Velas japonesas con `lightweight-charts` (la librería oficial de TradingView, gratis y rápida).
- Solo **EMA 20 y EMA 50** dibujadas. Nada de saturar con indicadores basura.
- Detección automática de estructura: marcadores de HH (Higher High), HL, LH, LL para leer tendencia de un vistazo.
- Cajas de **liquidez** (swing highs/lows recientes) y **FVG** (Fair Value Gaps) en H1 y M15.
- Reloj de sesión: bloque visual marcando Asia / Londres / Nueva York en hora local.

### 2. Motor de señales (tus reglas, no ruido)
Corre cada minuto durante la ventana de Londres (2:30–6:00 a.m. tu hora) y evalúa:
1. **Contexto H4**: tendencia por EMA 20 vs 50 + estructura.
2. **Liquidez H1**: ¿se barrió un swing relevante en la última hora?
3. **Confirmación M15**: FVG / Order Block + cierre a favor del contexto.
4. **Filtros de descarte**: spread alto, noticia roja en 30 min (ForexFactory feed), o ya hiciste 2 ops hoy.

Cuando los 4 puntos alinean, genera un **Setup Card** con:
- Bias (long/short) y confianza (alta / media).
- Entrada sugerida, SL (debajo/encima de la liquidez barrida), TP1 (1R), TP2 (2R), TP3 (3R o siguiente liquidez).
- Tamaño de lote ya calculado para 0.5% de tu balance Exness cents.
- Plan de gestión: mover SL a BE al alcanzar TP1, cerrar 50% en TP1, 30% en TP2, dejar 20% runner.
- Botón "Enviar a Telegram" + auto-envío si confianza = alta.

### 3. Calculadora de riesgo + gestión dinámica
Panel siempre visible:
- Balance actual (lo ingresas o lo sincronizamos después con MT5).
- Slider de riesgo (default 0.5%, máximo 1%).
- Calcula lote exacto para Exness cents según distancia al SL.
- Simulador "what if": arrastra entrada/SL/TP sobre el gráfico y ve R múltiplo + ganancia esperada en USD.
- Recordatorio de reglas: contador de ops del día (máx 2), pérdida acumulada (stop a -1.5% diario).

### 4. Journal mínimo (para que las estadísticas tengan sentido)
Aunque dijiste solo las 3 primeras, sin journal el motor no aprende qué setups te funcionan. Versión mínima:
- Cada Setup que ejecutas se guarda automático con screenshot del gráfico al momento de la señal.
- Marcas resultado: ganador / perdedor / BE.
- Lo dejamos listo, lo activamos cuando quieras (no estorba en v1).

### 5. Alertas Telegram
Bot dedicado que te manda:
- Setup detectado con bias, entrada, SL, TPs y screenshot del M15.
- Recordatorio 15 min antes de Londres.
- Alerta si tocas pérdida diaria máxima.

## Cómo se ve la pantalla

```text
┌─────────────────────────────────────────────────────────────────┐
│  Trading Compass    XAU/USD  2425.30  ▲0.42%   🟢 Londres 03:47 │
├──────────────────────────┬──────────────────────────────────────┤
│  H4         H1      M15  │  SETUP ACTIVO                        │
│ ┌──────┐ ┌──────┐ ┌─────┐│  ▲ LONG  Confianza: ALTA            │
│ │ /\  /│ │  /\  │ │ /\ ││  Entrada:  2424.80                   │
│ │/  \/ │ │ /  \ │ │/  \││  SL:       2421.20  (-36 pips)       │
│ │ EMA20│ │ FVG  │ │ OB  ││  TP1:      2428.40  (+1R)            │
│ └──────┘ └──────┘ └─────┘│  TP2:      2432.00  (+2R)            │
│ Tendencia: Alcista       │  Lote: 0.18  Riesgo: $5 (0.5%)       │
│ Liquidez barrida: ✓      │  [ Enviar a Telegram ]               │
├──────────────────────────┴──────────────────────────────────────┤
│  Riesgo hoy: $0 / $15 max    Ops: 0/2    P&L: +$0               │
└─────────────────────────────────────────────────────────────────┘
```

## Stack técnico

- **Frontend**: TanStack Start (lo que ya tienes) + `lightweight-charts` para gráficos.
- **Backend**: Server functions para llamar Twelve Data y correr el motor de señales.
- **Datos**: Twelve Data API (free tier, 800 req/día — suficiente con polling de 1 min en ventana de Londres).
- **Storage**: Lovable Cloud para guardar setups, journal y configuración personal.
- **Auth**: Email/password (solo tú).
- **Alertas**: Conector Telegram de Lovable.
- **Cron**: Polling activo solo en ventana 2:30–6:00 a.m. para no agotar el free tier.

## Lo que necesito de ti antes de construir

1. **API key de Twelve Data** — te la pediré con el formulario seguro. Tarda 1 min en sacarla en twelvedata.com (gratis, solo email).
2. **Conectar Telegram** — abrir el conector y autorizar tu bot (o crear uno nuevo con @BotFather si no tienes).
3. **Tu chat_id de Telegram** — para saber a quién mandar las alertas (te explico cómo sacarlo).

## Orden de construcción

1. Activar Lovable Cloud + auth + tablas (setups, journal, config).
2. Conectar Twelve Data y Telegram.
3. Vista multi-timeframe con datos reales y EMAs.
4. Detección de estructura + liquidez + FVG.
5. Motor de señales con tus reglas y Setup Card.
6. Calculadora de riesgo y panel de límites diarios.
7. Envío a Telegram + cron de la ventana de Londres.
8. Journal mínimo (oculto pero grabando).

Si apruebas, arranco con el paso 1 y te pido las credenciales en los pasos 2 y 3.
