//+------------------------------------------------------------------+
//|  LovableBridge.mq5  —  EA "puente tonto" v0.14                   |
//|  Ejecuta las señales que publica el dashboard en la tabla        |
//|  mt5_signals. NO decide nada por sí mismo.                       |
//|  Reporta cierres reales (SL, TP, manual) para que el dashboard    |
//|  calcule P&L y WinRate con datos reales de MT5, y ADEMÁS envía    |
//|  las velas del broker (M1..D1) para que el análisis del           |
//|  dashboard use exactamente los precios de tu cuenta.              |
//|                                                                  |
//|  Instalación (una sola vez):                                     |
//|   1) MT5 → File → Open Data Folder → MQL5/Experts/                |
//|      Guardar este archivo ahí y compilar con F7 en MetaEditor.   |
//|   2) MT5 → Tools → Options → Expert Advisors:                    |
//|        [x] Allow WebRequest for listed URL:                      |
//|          https://session-whispers-flow.lovable.app                |
//|          https://project--ab140c2e-e87d-4efe-93e3-7ee43ff16310.lovable.app
//|   3) Arrastrar el EA sobre un gráfico de XAUUSD.                  |
//|   4) En la pestaña "Inputs" pegar el token del EA.                |
//+------------------------------------------------------------------+
#property copyright "Lovable"
#property version   "0.150"
#property strict

input string InpBaseUrl      = "https://session-whispers-flow.lovable.app";
input string InpEaToken      = "";                    // Token del EA (mt5_ea_tokens)
input string InpSymbol       = "XAUUSD";
input double InpRiskPercent  = 0.5;                   // % del balance por trade
input double InpMaxSpreadUsd = 0.60;                  // spread máximo aceptado en USD
input int    InpPollSeconds  = 5;                     // polling
input int    InpMagic        = 202607;
input bool   InpDiagnosticOnInit = true;              // Prueba conexión/token al iniciar, sin operar
input bool   InpPushBars     = true;                  // Enviar velas del broker al dashboard
input int    InpPushBarsSec  = 30;                    // Cada cuántos segundos enviar M1
input int    InpBarsM1       = 400;                   // Velas M1 por envío
input int    InpBarsHigherTf = 200;                   // Velas por TF superior

#include <Trade\Trade.mqh>
CTrade trade;

struct TradeRecord {
   long    ticket;
   string  signal_id;
   double  lots;
   double  entry;
   double  sl;
   double  tp1;
   string  bias;
   bool    reported;
};

TradeRecord g_trades[];
datetime g_lastPoll = 0;
datetime g_lastPushM1 = 0;
datetime g_lastPushHtf = 0;
int      g_htfIndex = 0;
int g_emptyPolls = 0;

string WithToken(string url)
{
   string sep = (StringFind(url, "?") >= 0 ? "&" : "?");
   return url + sep + "token=" + InpEaToken;
}

int OnInit()
{
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetTypeFillingBySymbol(InpSymbol);
   if(StringLen(InpEaToken) < 8)
   { Alert("LovableBridge: token EA vacío. Pega el token en inputs."); return(INIT_FAILED); }
   EventSetTimer(MathMax(1, InpPollSeconds));
   Print("LovableBridge v0.16 iniciado. BaseUrl=", InpBaseUrl, " Symbol=", InpSymbol, " Poll=", InpPollSeconds, "s");
   if(InpDiagnosticOnInit) DiagnosticPing();
   PollAndExecute();
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer()
{
   CheckClosedTrades();
   PushBarsCycle();
   if(TimeCurrent() - g_lastPoll < InpPollSeconds) return;
   g_lastPoll = TimeCurrent();
   PollAndExecute();
}

void OnTick() {}

//---
string HttpGet(string url, int &outStatus)
{
   char post[]; char result[]; string headers = "X-EA-Token: " + InpEaToken + "\r\n";
   string respHeaders;
   ResetLastError();
   int res = WebRequest("GET", WithToken(url), headers, 15000, post, result, respHeaders);
   outStatus = res;
   if(res == -1) {
      int err = GetLastError();
      PrintFormat("LovableBridge WebRequest GET falló. err=%d. Revisa Tools -> Options -> Expert Advisors -> Allow WebRequest: %s", err, InpBaseUrl);
      return "";
   }
   string body = CharArrayToString(result);
   if(res < 200 || res >= 300) {
      PrintFormat("LovableBridge GET HTTP %d resp=%s", res, body);
   }
   return body;
}

bool HttpPostJson(string url, string body)
{
   char post[]; StringToCharArray(body, post, 0, StringLen(body));
   char result[]; string respHeaders;
   string headers = "X-EA-Token: " + InpEaToken + "\r\nContent-Type: application/json\r\n";
   ResetLastError();
   int res = WebRequest("POST", WithToken(url), headers, 30000, post, result, respHeaders);
   if(res == -1) {
      int err = GetLastError();
      PrintFormat("LovableBridge WebRequest POST falló. err=%d. Revisa Tools -> Options -> Expert Advisors -> Allow WebRequest: %s", err, InpBaseUrl);
      return false;
   }
   if(res < 200 || res >= 300) {
      PrintFormat("LovableBridge POST HTTP %d resp=%s", res, CharArrayToString(result));
   }
   return (res >= 200 && res < 300);
}

//--- extractor JSON muy simple (busca "key":value o "key":"value")
string JsonStr(string src, string key)
{
   string needle = "\"" + key + "\":";
   int i = StringFind(src, needle);
   if(i < 0) return "";
   i += StringLen(needle);
   while(i < StringLen(src) && (StringGetCharacter(src, i) == ' ')) i++;
   if(i >= StringLen(src)) return "";
   ushort ch = StringGetCharacter(src, i);
   if(ch == '"') {
      int j = StringFind(src, "\"", i + 1);
      if(j < 0) return "";
      return StringSubstr(src, i + 1, j - i - 1);
   } else {
      int j = i;
      while(j < StringLen(src)) {
         ushort c = StringGetCharacter(src, j);
         if(c == ',' || c == '}' || c == ' ' || c == '\n' || c == '\r') break;
         j++;
      }
      return StringSubstr(src, i, j - i);
   }
}

double JsonNum(string src, string key) { string v = JsonStr(src, key); return (v == "" ? 0.0 : StringToDouble(v)); }

void DiagnosticPing()
{
   int status = 0;
   string url = InpBaseUrl + "/api/public/mt5-signals?diag=1";
   string body = HttpGet(url, status);
   if(status == 200 && StringFind(body, "\"ok\":true") >= 0) {
      Print("LovableBridge DIAGNOSTICO OK: conexión/token válidos. Respuesta=", body);
      return;
   }
   if(status == 401) {
      Print("LovableBridge DIAGNOSTICO FALLÓ: token inválido o no coincide con el dashboard. Respuesta=", body);
      return;
   }
   PrintFormat("LovableBridge DIAGNOSTICO FALLÓ: HTTP=%d resp=%s", status, body);
}

//---
// Cierra todas las posiciones del EA y cancela las órdenes pendientes.
void FlattenAll(string reason)
{
   int closed = 0, deleted = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(!PositionSelectByTicket(ticket)) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      if(PositionGetString(POSITION_SYMBOL) != InpSymbol) continue;
      if(trade.PositionClose(ticket)) closed++;
   }
   for(int i = OrdersTotal() - 1; i >= 0; i--) {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(OrderGetInteger(ORDER_MAGIC) != InpMagic) continue;
      if(OrderGetString(ORDER_SYMBOL) != InpSymbol) continue;
      if(trade.OrderDelete(ticket)) deleted++;
   }
   if(closed > 0 || deleted > 0)
      PrintFormat("LovableBridge FlattenAll (%s): %d posiciones cerradas, %d pendientes canceladas", reason, closed, deleted);
}

void PollAndExecute()
{
   int status = 0;
   string url = InpBaseUrl + "/api/public/mt5-signals";
   string body = HttpGet(url, status);
   if(status == 401) { Print("LovableBridge: token inválido o no coincide con el dashboard. Genera uno nuevo, pégalo completo y reinicia el EA. Respuesta=", body); return; }
   if(status < 200 || status >= 300) { PrintFormat("LovableBridge GET HTTP %d resp=%s", status, body); return; }

   // --- Gestión de fin de semana: el backend ordena aplanar la cuenta.
   if(StringFind(body, "\"flatten\":true") >= 0) {
      FlattenAll("weekend-guard");
   }
   if(StringFind(body, "\"weekend_blocked\":true") >= 0) {
      static datetime lastWeekendLog = 0;
      if(TimeCurrent() - lastWeekendLog > 3600) {
         lastWeekendLog = TimeCurrent();
         Print("LovableBridge: ventana de fin de semana activa (", JsonStr(body, "weekend_reason"), "). Sin entradas nuevas.");
      }
      return;
   }

   if(body == "" || StringFind(body, "\"signal\":null") >= 0) {
      g_emptyPolls++;
      if(g_emptyPolls == 1 || MathMod(g_emptyPolls, 12) == 0) {
         PrintFormat("LovableBridge conectado: sin señales pendientes. polls_vacios=%d", g_emptyPolls);
      }
      return;
   }
   g_emptyPolls = 0;

   string id       = JsonStr(body, "id");
   string bias     = JsonStr(body, "bias");
   double entry    = JsonNum(body, "entry");
   double sl       = JsonNum(body, "stop_loss");
   double tp1      = JsonNum(body, "tp1");
   double lotFromDb= JsonNum(body, "lot_size");

   if(id == "" || (bias != "long" && bias != "short")) return;

   // Filtro spread
   MqlTick tick; if(!SymbolInfoTick(InpSymbol, tick)) { ReportError(id, "no tick"); return; }
   double spread = (tick.ask - tick.bid);
   if(spread > InpMaxSpreadUsd) { ReportError(id, StringFormat("spread %.3f > %.3f", spread, InpMaxSpreadUsd)); return; }

   // Position sizing: por riesgo % o usa lot_size si viene del dashboard
   double lots = (lotFromDb > 0 ? lotFromDb : ComputeLots(entry, sl));
   if(lots <= 0) { ReportError(id, "lot=0"); return; }

   bool ok = false;
   double execPrice = 0;
   if(bias == "long")  { ok = trade.Buy(lots, InpSymbol, tick.ask, sl, tp1); execPrice = tick.ask; }
   else                { ok = trade.Sell(lots, InpSymbol, tick.bid, sl, tp1); execPrice = tick.bid; }

   if(!ok) { ReportError(id, StringFormat("OrderSend err=%d retcode=%d", GetLastError(), trade.ResultRetcode())); return; }

   ulong ticket = trade.ResultOrder();
   ReportFilled(id, (long)ticket, execPrice);
   AddTradeRecord((long)ticket, id, lots, execPrice, sl, tp1, bias);
   PrintFormat("Ejecutada señal %s → ticket=%I64u lots=%.2f", id, ticket, lots);
}

void AddTradeRecord(long ticket, string signal_id, double lots, double entry, double sl, double tp1, string bias)
{
   int n = ArraySize(g_trades);
   ArrayResize(g_trades, n + 1);
   g_trades[n].ticket = ticket;
   g_trades[n].signal_id = signal_id;
   g_trades[n].lots = lots;
   g_trades[n].entry = entry;
   g_trades[n].sl = sl;
   g_trades[n].tp1 = tp1;
   g_trades[n].bias = bias;
   g_trades[n].reported = false;
}

void CheckClosedTrades()
{
   if(ArraySize(g_trades) == 0) return;
   if(!HistorySelect(0, TimeCurrent())) return;

   for(int i = ArraySize(g_trades) - 1; i >= 0; i--)
   {
      TradeRecord rec = g_trades[i];
      if(rec.reported) { ArrayRemove(g_trades, i, 1); continue; }

      // ¿Aún abierta?
      if(PositionSelectByTicket((ulong)rec.ticket)) continue;

      // Buscar el deal de cierre en el historial
      bool found = false;
      for(int d = HistoryDealsTotal() - 1; d >= 0; d--)
      {
         ulong dealTicket = HistoryDealGetTicket(d);
         if(dealTicket == 0) continue;
         long posId = HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
         if(posId != rec.ticket) continue;

         double profit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT);
         double swap   = HistoryDealGetDouble(dealTicket, DEAL_SWAP);
         double comm   = HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
         double pnlUsd = profit + swap + comm;
         double exitPrice = HistoryDealGetDouble(dealTicket, DEAL_PRICE);
         long reason = HistoryDealGetInteger(dealTicket, DEAL_REASON);

         string reasonStr = "manual";
         if(reason == DEAL_REASON_SL) reasonStr = "sl";
         else if(reason == DEAL_REASON_TP) reasonStr = "tp1";
         else if(reason == DEAL_REASON_SO) reasonStr = "margin";

         // Calcular R basado en riesgo real del trade
         double riskUsd = RiskUsdForTrade(rec.entry, rec.sl, rec.lots);
         double r = (riskUsd > 0 ? pnlUsd / riskUsd : 0);

         ReportClosed(rec.signal_id, rec.ticket, exitPrice, pnlUsd, r, reasonStr);
         rec.reported = true;
         g_trades[i].reported = true;
         found = true;
         PrintFormat("Señal %s cerrada → ticket=%I64u reason=%s pnl=%.2f r=%.2f", rec.signal_id, rec.ticket, reasonStr, pnlUsd, r);
         break;
      }

      if(found) ArrayRemove(g_trades, i, 1);
   }
}

double RiskUsdForTrade(double entry, double sl, double lots)
{
   double tickVal = SymbolInfoDouble(InpSymbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSz  = SymbolInfoDouble(InpSymbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickSz <= 0 || tickVal <= 0) return 0;
   double dist = MathAbs(entry - sl);
   double lossPerLot = (dist / tickSz) * tickVal;
   return lossPerLot * lots;
}

double ComputeLots(double entry, double sl)
{
   double bal   = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskU = bal * InpRiskPercent / 100.0;
   double dist  = MathAbs(entry - sl);
   if(dist <= 0) return 0.0;
   double tickVal = SymbolInfoDouble(InpSymbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSz  = SymbolInfoDouble(InpSymbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickSz <= 0 || tickVal <= 0) return 0.0;
   double lossPerLot = (dist / tickSz) * tickVal;
   double lots = riskU / lossPerLot;
   double step = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_STEP);
   double minL = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MIN);
   double maxL = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MAX);
   lots = MathFloor(lots / step) * step;
   lots = MathMax(minL, MathMin(maxL, lots));
   return lots;
}

void ReportFilled(string id, long ticket, double price)
{
   string url = InpBaseUrl + "/api/public/mt5-signals";
   string body = StringFormat("{\"signal_id\":\"%s\",\"action\":\"filled\",\"mt5_ticket\":%I64d,\"fill_price\":%.2f}",
                              id, ticket, price);
   HttpPostJson(url, body);
}

void ReportClosed(string id, long ticket, double exitPrice, double pnlUsd, double r, string reason)
{
   string url = InpBaseUrl + "/api/public/mt5-signals";
   string reasonEsc = reason;
   StringReplace(reasonEsc, "\\", "\\\\");
   StringReplace(reasonEsc, "\"", "\\\"");
   string body = StringFormat("{\"signal_id\":\"%s\",\"action\":\"closed\",\"mt5_ticket\":%I64d,\"exit_price\":%.2f,\"pnl_usd\":%.2f,\"r_multiple\":%.3f,\"closed_reason\":\"%s\"}",
                              id, ticket, exitPrice, pnlUsd, r, reasonEsc);
   HttpPostJson(url, body);
}

void ReportError(string id, string msg)
{
   string url = InpBaseUrl + "/api/public/mt5-signals";
   string msgEsc = msg;
   StringReplace(msgEsc, "\\", "\\\\");
   StringReplace(msgEsc, "\"", "\\\"");
   string body = StringFormat("{\"signal_id\":\"%s\",\"action\":\"error\",\"error_message\":\"%s\"}", id, msgEsc);
   HttpPostJson(url, body);
   Print("Signal ", id, " → ERROR: ", msg);
}

//+------------------------------------------------------------------+
//|  Envío de velas del broker al dashboard (v0.14)                   |
//|  El dashboard prefiere estos precios sobre el proveedor externo,   |
//|  porque son los mismos que ejecuta tu cuenta (spread y sesión).    |
//+------------------------------------------------------------------+
void PushBarsCycle()
{
   if(!InpPushBars) return;
   datetime now = TimeCurrent();

   if(now - g_lastPushM1 >= MathMax(10, InpPushBarsSec))
   {
      g_lastPushM1 = now;
      PushBars("M1", PERIOD_M1, InpBarsM1);
   }

   // TFs superiores: uno por ciclo (cada 20s) para no bloquear el EA con
   // cuatro WebRequests grandes seguidos. Ciclo completo ~80s.
   if(now - g_lastPushHtf >= 20)
   {
      g_lastPushHtf = now;
      switch(g_htfIndex)
      {
         case 0: PushBars("M15", PERIOD_M15, InpBarsHigherTf); break;
         case 1: PushBars("H1",  PERIOD_H1,  InpBarsHigherTf); break;
         case 2: PushBars("H4",  PERIOD_H4,  InpBarsHigherTf); break;
         default: PushBars("D1", PERIOD_D1,  120); break;
      }
      g_htfIndex = (g_htfIndex + 1) % 4;
   }
}

void PushBars(string tfName, ENUM_TIMEFRAMES period, int count)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int copied = CopyRates(InpSymbol, period, 0, count, rates);
   if(copied <= 0) { PrintFormat("LovableBridge: CopyRates %s falló err=%d", tfName, GetLastError()); return; }

   MqlTick tick; double spread = 0;
   if(SymbolInfoTick(InpSymbol, tick)) spread = tick.ask - tick.bid;

   string json = "{\"symbol\":\"" + InpSymbol + "\",\"tf\":\"" + tfName + "\"," +
                 "\"broker\":\"" + AccountInfoString(ACCOUNT_COMPANY) + "\"," +
                 StringFormat("\"spread\":%.3f,", spread) + "\"bars\":[";

   for(int i = 0; i < copied; i++)
   {
      if(i > 0) json += ",";
      json += StringFormat("[%I64d,%.3f,%.3f,%.3f,%.3f]",
                           (long)rates[i].time, rates[i].open, rates[i].high, rates[i].low, rates[i].close);
   }
   json += "]}";

   string url = InpBaseUrl + "/api/public/mt5-bars";
   if(!HttpPostJson(url, json))
      PrintFormat("LovableBridge: envío de velas %s falló (%d velas, %d chars)", tfName, copied, StringLen(json));
   else
      PrintFormat("LovableBridge: velas %s enviadas (%d)", tfName, copied);
}
