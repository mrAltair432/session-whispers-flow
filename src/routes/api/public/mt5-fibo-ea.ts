import { createFileRoute } from "@tanstack/react-router";

// Sirve el Expert Advisor MQL5 del Fibo Scalping (E3) como texto descargable.
// Replica 1:1 las reglas de src/lib/strategies/fibo-scalping.ts:
//   H4 bias EMA20/50 → swing H1 → Fibo 0.5-0.786 → confirmación M15
//   Killzone Londres UTC 07-11, sin domingo, viernes hasta UTC 12
//   Filtro ATR M15 vs mediana 80, SL pasado 0.786 con buffer ATR,
//   TP1/TP2/TP3 = 1R/2R/3R con parcial + break-even + trailing.
const SCRIPT = `//+------------------------------------------------------------------+
//| TradingCompass_FiboScalping.mq5                                  |
//| Expert Advisor — replica del motor E3 (Fibo Scalping Londres).   |
//| Reglas idénticas al backtest de Trading Compass, sin IA.         |
//|                                                                  |
//| Instalación:                                                     |
//|  1. MT5 > File > Open Data Folder > MQL5/Experts/                |
//|  2. Copiar este archivo dentro. Compilar (F7).                   |
//|  3. Arrastrar sobre un gráfico M15 de XAUUSD.                    |
//|  4. En Common: permitir AutoTrading. En Inputs: ajustar riesgo.  |
//+------------------------------------------------------------------+
#property copyright "Trading Compass"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>
CTrade trade;

//--- Inputs
input double InpRiskPercent      = 0.5;    // % de equity por operación
input int    InpMinScore         = 65;     // Score mínimo (0-100)
input int    InpMagic            = 730031; // Magic number
input bool   InpUsePartials      = true;   // Cerrar 1/3 en TP1 y 1/3 en TP2
input bool   InpTrailAfterTP1    = true;   // SL a break-even tras TP1
input int    InpMaxSpreadPoints  = 60;     // Spread máximo permitido
input bool   InpOnlyLondonKZ     = true;   // Solo Killzone Londres 07-11 UTC

//--- Estado
datetime lastBarTime = 0;
ulong    entryTicket = 0;
double   entryPrice  = 0;
double   entrySL     = 0;
double   entryTP1    = 0;
double   entryTP2    = 0;
double   entryTP3    = 0;
bool     tp1Done     = false;
bool     tp2Done     = false;

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(20);
   Print("Trading Compass · Fibo Scalping EA iniciado");
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) {}

//+------------------------------------------------------------------+
//| Utilidades                                                       |
//+------------------------------------------------------------------+
double EMA(const string sym, ENUM_TIMEFRAMES tf, int period, int shift)
{
   int h = iMA(sym, tf, period, 0, MODE_EMA, PRICE_CLOSE);
   if(h == INVALID_HANDLE) return 0.0;
   double buf[]; ArraySetAsSeries(buf, true);
   if(CopyBuffer(h, 0, shift, 1, buf) <= 0) { IndicatorRelease(h); return 0.0; }
   IndicatorRelease(h);
   return buf[0];
}

double ATRVal(const string sym, ENUM_TIMEFRAMES tf, int period, int shift)
{
   int h = iATR(sym, tf, period);
   if(h == INVALID_HANDLE) return 0.0;
   double buf[]; ArraySetAsSeries(buf, true);
   if(CopyBuffer(h, 0, shift, 1, buf) <= 0) { IndicatorRelease(h); return 0.0; }
   IndicatorRelease(h);
   return buf[0];
}

// Mediana de ATR sobre las últimas N velas (para ratio de volatilidad).
double ATRMedian(const string sym, ENUM_TIMEFRAMES tf, int period, int lookback)
{
   int h = iATR(sym, tf, period);
   if(h == INVALID_HANDLE) return 0.0;
   double buf[]; ArraySetAsSeries(buf, true);
   int copied = CopyBuffer(h, 0, 1, lookback, buf);
   IndicatorRelease(h);
   if(copied <= 0) return 0.0;
   double vals[]; ArrayResize(vals, copied);
   for(int i = 0; i < copied; i++) vals[i] = buf[i];
   ArraySort(vals);
   return vals[copied / 2];
}

// Detecta el último swing high y low significativos en H1 (fractal simple, k=2).
bool LastSwings(const string sym, ENUM_TIMEFRAMES tf, int bars,
                double &swingHigh, datetime &tHigh,
                double &swingLow,  datetime &tLow)
{
   MqlRates r[]; ArraySetAsSeries(r, true);
   int copied = CopyRates(sym, tf, 0, bars, r);
   if(copied < 10) return false;
   swingHigh = 0; swingLow = 0;
   tHigh = 0; tLow = 0;
   // Recorremos de más reciente a más viejo (índice 2 en adelante para tener k=2 futuro)
   for(int i = 2; i < copied - 2; i++)
   {
      bool isHigh = r[i].high > r[i-1].high && r[i].high > r[i-2].high
                 && r[i].high > r[i+1].high && r[i].high > r[i+2].high;
      bool isLow  = r[i].low  < r[i-1].low  && r[i].low  < r[i-2].low
                 && r[i].low  < r[i+1].low  && r[i].low  < r[i+2].low;
      if(isHigh && swingHigh == 0) { swingHigh = r[i].high; tHigh = r[i].time; }
      if(isLow  && swingLow  == 0) { swingLow  = r[i].low;  tLow  = r[i].time; }
      if(swingHigh > 0 && swingLow > 0) break;
   }
   return (swingHigh > 0 && swingLow > 0);
}

bool NewM15Bar()
{
   datetime t = iTime(_Symbol, PERIOD_M15, 0);
   if(t == lastBarTime) return false;
   lastBarTime = t;
   return true;
}

double LotFromRisk(double stopDistance)
{
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double riskCash = equity * InpRiskPercent / 100.0;
   double tickVal  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickSize <= 0 || tickVal <= 0 || stopDistance <= 0) return 0.01;
   double lossPerLot = (stopDistance / tickSize) * tickVal;
   if(lossPerLot <= 0) return 0.01;
   double lots = riskCash / lossPerLot;
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double minL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   lots = MathFloor(lots / step) * step;
   if(lots < minL) lots = minL;
   if(lots > maxL) lots = maxL;
   return NormalizeDouble(lots, 2);
}

//+------------------------------------------------------------------+
//| Manager de posición abierta: parciales + break-even              |
//+------------------------------------------------------------------+
void ManageOpenPosition()
{
   if(!PositionSelectByTicket(entryTicket))
   {
      // Cerrada (SL/TP total o intervención). Reset.
      entryTicket = 0; tp1Done = false; tp2Done = false; return;
   }
   long   type   = PositionGetInteger(POSITION_TYPE);
   double vol    = PositionGetDouble(POSITION_VOLUME);
   double price  = (type == POSITION_TYPE_BUY)
                     ? SymbolInfoDouble(_Symbol, SYMBOL_BID)
                     : SymbolInfoDouble(_Symbol, SYMBOL_ASK);

   bool longSide = (type == POSITION_TYPE_BUY);
   bool tp1Hit = longSide ? price >= entryTP1 : price <= entryTP1;
   bool tp2Hit = longSide ? price >= entryTP2 : price <= entryTP2;

   if(InpUsePartials && !tp1Done && tp1Hit)
   {
      double part = NormalizeDouble(vol / 3.0, 2);
      if(part > 0) trade.PositionClosePartial(entryTicket, part);
      tp1Done = true;
      if(InpTrailAfterTP1)
         trade.PositionModify(entryTicket, entryPrice, entryTP3);
   }
   if(InpUsePartials && tp1Done && !tp2Done && tp2Hit)
   {
      if(PositionSelectByTicket(entryTicket))
      {
         double left = PositionGetDouble(POSITION_VOLUME);
         double part = NormalizeDouble(left / 2.0, 2);
         if(part > 0) trade.PositionClosePartial(entryTicket, part);
         tp2Done = true;
      }
   }
}

//+------------------------------------------------------------------+
//| Señal: replica evaluateFiboScalping                              |
//+------------------------------------------------------------------+
bool EvaluateSignal(bool &isLong, double &sl, double &tp1, double &tp2, double &tp3, double &entry, int &score)
{
   // --- H4 bias ---
   double ema20H4 = EMA(_Symbol, PERIOD_H4, 20, 1);
   double ema50H4 = EMA(_Symbol, PERIOD_H4, 50, 1);
   if(ema50H4 == 0) return false;
   double diffH4 = (ema20H4 - ema50H4) / ema50H4;
   if(MathAbs(diffH4) < 0.0005) return false;
   isLong = diffH4 > 0;

   // --- H1 swing ---
   double swingHigh, swingLow; datetime tH, tL;
   if(!LastSwings(_Symbol, PERIOD_H1, 40, swingHigh, tH, swingLow, tL)) return false;
   double range = swingHigh - swingLow;
   if(range <= 0) return false;

   // Fibo levels
   double lvl500 = isLong ? swingHigh - range * 0.500 : swingLow + range * 0.500;
   double lvl618 = isLong ? swingHigh - range * 0.618 : swingLow + range * 0.618;
   double lvl786 = isLong ? swingHigh - range * 0.786 : swingLow + range * 0.786;
   double zoneTop = isLong ? lvl500 : lvl786;
   double zoneBot = isLong ? lvl786 : lvl500;

   // --- M15: precio tocó zona en últimas 6 velas ---
   MqlRates m15[]; ArraySetAsSeries(m15, true);
   if(CopyRates(_Symbol, PERIOD_M15, 0, 8, m15) < 8) return false;
   bool touched = false;
   for(int i = 1; i <= 6; i++)
      if(m15[i].low <= zoneTop && m15[i].high >= zoneBot) { touched = true; break; }
   if(!touched) return false;

   // Confirmación en la última vela cerrada
   MqlRates last = m15[1];
   double ema20M15 = EMA(_Symbol, PERIOD_M15, 20, 1);
   bool confirm = isLong
      ? (last.close > last.open && last.close >= lvl618 && last.close > ema20M15)
      : (last.close < last.open && last.close <= lvl618 && last.close < ema20M15);
   if(!confirm) return false;

   // --- Filtros de tiempo ---
   MqlDateTime mdt; TimeToStruct(last.time, mdt);
   int hUTC = mdt.hour;
   int wd   = mdt.day_of_week;
   bool inKz = (hUTC >= 7 && hUTC < 11);
   if(InpOnlyLondonKZ && !inKz) return false;
   if(wd == 0) return false;                  // domingo
   if(wd == 5 && hUTC >= 12) return false;    // viernes tarde

   // --- ATR filter ---
   double atrNow = ATRVal(_Symbol, PERIOD_M15, 14, 1);
   double atrMed = ATRMedian(_Symbol, PERIOD_M15, 14, 80);
   double atrRatio = (atrMed > 0) ? atrNow / atrMed : 1.0;
   if(atrRatio < 0.7) return false;

   // --- H1 alignment ---
   double ema20H1 = EMA(_Symbol, PERIOD_H1, 20, 1);
   double ema50H1 = EMA(_Symbol, PERIOD_H1, 50, 1);
   bool h1Aligned = isLong ? (ema20H1 > ema50H1) : (ema20H1 < ema50H1);

   // --- Score ---
   int sc = 20 + 20 + 15 + 5;                 // h4Trend + h1Sweep + m15Fvg + m15Bos base
   sc += inKz ? 12 : 0;
   sc += (atrRatio >= 1.0) ? 10 : (atrRatio >= 0.85 ? 7 : 4);
   sc += h1Aligned ? 5 : 0;
   if(sc < InpMinScore) return false;
   score = sc;

   // --- Entry / SL / TPs ---
   entry = last.close;
   double buffer = MathMax(atrNow * 0.4, (last.high - last.low) * 0.4);
   sl  = isLong ? lvl786 - buffer : lvl786 + buffer;
   double risk = MathAbs(entry - sl);
   if(risk <= 0) return false;
   tp1 = isLong ? entry + risk     : entry - risk;
   tp2 = isLong ? entry + risk * 2 : entry - risk * 2;
   tp3 = isLong ? entry + risk * 3 : entry - risk * 3;
   return true;
}

//+------------------------------------------------------------------+
void OnTick()
{
   // Gestión de posición viva en cada tick (parciales + BE)
   if(entryTicket != 0) ManageOpenPosition();

   // Nueva señal solo al cerrar vela M15
   if(!NewM15Bar()) return;
   if(entryTicket != 0) return;                     // ya hay posición

   long spread = SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   if(spread > InpMaxSpreadPoints) return;

   bool isLong; double sl, tp1, tp2, tp3, entry; int score;
   if(!EvaluateSignal(isLong, sl, tp1, tp2, tp3, entry, score)) return;

   double lots = LotFromRisk(MathAbs(entry - sl));
   if(lots <= 0) return;

   // TP objetivo = TP3 (parciales cierran 1/3 en TP1 y 1/3 en TP2)
   bool ok = isLong
      ? trade.Buy(lots, _Symbol, 0, sl, tp3,
                  StringFormat("TC Fibo L score=%d", score))
      : trade.Sell(lots, _Symbol, 0, sl, tp3,
                   StringFormat("TC Fibo S score=%d", score));
   if(ok)
   {
      entryTicket = trade.ResultOrder();
      entryPrice  = entry; entrySL = sl;
      entryTP1 = tp1; entryTP2 = tp2; entryTP3 = tp3;
      tp1Done = false; tp2Done = false;
      PrintFormat("Trade abierto %s lot=%.2f entry=%.2f SL=%.2f TP=%.2f score=%d",
                  (isLong ? "BUY" : "SELL"), lots, entry, sl, tp3, score);
   }
}
//+------------------------------------------------------------------+
`;

export const Route = createFileRoute("/api/public/mt5-fibo-ea")({
  server: {
    handlers: {
      GET: () =>
        new Response(SCRIPT, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="TradingCompass_FiboScalping.mq5"',
            "Cache-Control": "public, max-age=3600",
          },
        }),
    },
  },
});