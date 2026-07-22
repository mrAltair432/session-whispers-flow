//+------------------------------------------------------------------+
//|  LovableBridge.mq5  —  EA "puente tonto" v0.11                   |
//|  Ejecuta las señales que publica el dashboard en la tabla        |
//|  mt5_signals. NO decide nada por sí mismo.                       |
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
#property version   "0.110"
#property strict

input string InpBaseUrl      = "https://session-whispers-flow.lovable.app";
input string InpEaToken      = "";                    // Token del EA (mt5_ea_tokens)
input string InpSymbol       = "XAUUSD";
input double InpRiskPercent  = 0.5;                   // % del balance por trade
input double InpMaxSpreadUsd = 0.60;                  // spread máximo aceptado en USD
input int    InpPollSeconds  = 5;                     // polling
input int    InpMagic        = 202607;

#include <Trade\Trade.mqh>
CTrade trade;

datetime g_lastPoll = 0;

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
   Print("LovableBridge v0.11 iniciado. BaseUrl=", InpBaseUrl, " Symbol=", InpSymbol, " Poll=", InpPollSeconds, "s");
   PollAndExecute();
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer()
{
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
   int res = WebRequest("GET", WithToken(url), headers, 5000, post, result, respHeaders);
   outStatus = res;
   if(res == -1) {
      int err = GetLastError();
      PrintFormat("LovableBridge WebRequest GET falló. err=%d. Revisa Tools -> Options -> Expert Advisors -> Allow WebRequest: %s", err, InpBaseUrl);
      return "";
   }
   return CharArrayToString(result);
}

bool HttpPostJson(string url, string body)
{
   char post[]; StringToCharArray(body, post, 0, StringLen(body));
   char result[]; string respHeaders;
   string headers = "X-EA-Token: " + InpEaToken + "\r\nContent-Type: application/json\r\n";
   ResetLastError();
   int res = WebRequest("POST", WithToken(url), headers, 5000, post, result, respHeaders);
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

//---
void PollAndExecute()
{
   int status = 0;
   string url = InpBaseUrl + "/api/public/mt5-signals";
   string body = HttpGet(url, status);
   if(status == 401) { Print("LovableBridge: token inválido o no coincide con el dashboard. Genera uno nuevo, pégalo completo y reinicia el EA. Respuesta=", body); return; }
   if(status < 200 || status >= 300) { PrintFormat("LovableBridge GET HTTP %d resp=%s", status, body); return; }
   if(body == "" || StringFind(body, "\"signal\":null") >= 0) return;

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
   PrintFormat("Ejecutada señal %s → ticket=%I64u lots=%.2f", id, ticket, lots);
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

void ReportError(string id, string msg)
{
   string url = InpBaseUrl + "/api/public/mt5-signals";
   string body = StringFormat("{\"signal_id\":\"%s\",\"action\":\"error\",\"error_message\":\"%s\"}", id, msg);
   HttpPostJson(url, body);
   Print("Signal ", id, " → ERROR: ", msg);
}