import { createFileRoute } from "@tanstack/react-router";

// Sirve el script MQL5 como texto plano descargable.
// Evita el 404 que producen extensiones .mq5 no servidas por el runtime.
const SCRIPT = `//+------------------------------------------------------------------+
//| XAUUSD_History_Export.mq5                                        |
//| Exporta histórico OHLC de XAUUSD a CSV para Trading Compass.     |
//| Uso:                                                             |
//|  1. Copiar en MQL5/Scripts/ (File > Open Data Folder en MT5).    |
//|  2. Refrescar Scripts en el Navegador.                           |
//|  3. En MT5: abre el grafico de XAUUSD en cada TF y desplaza      |
//|     hacia atras (Home / PgUp) para que descargue el historico.   |
//|  4. Arrastrar el script sobre un grafico de XAUUSD.              |
//|  5. CSV salen en MQL5/Files/. Subirlos en la pestana Backtest.   |
//+------------------------------------------------------------------+
#property script_show_inputs
#property strict

input int     YearsBack = 10;
input string  InpSymbol = "XAUUSD";

void ExportTF(ENUM_TIMEFRAMES tf, string tfName)
{
   datetime to   = TimeCurrent();
   datetime from = to - (datetime)YearsBack * 365 * 24 * 60 * 60;
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int copied = CopyRates(InpSymbol, tf, from, to, rates);
   if(copied <= 0) { PrintFormat("Sin datos %s %s err=%d", InpSymbol, tfName, GetLastError()); return; }
   string fileName = StringFormat("%s_%s.csv", InpSymbol, tfName);
   int fh = FileOpen(fileName, FILE_WRITE|FILE_CSV|FILE_ANSI, ',');
   if(fh == INVALID_HANDLE) { PrintFormat("No se pudo abrir %s", fileName); return; }
   FileWrite(fh, "Date","Open","High","Low","Close","Volume");
   for(int i = 0; i < copied; i++)
   {
      MqlDateTime mdt; TimeToStruct(rates[i].time, mdt);
      string dateStr = StringFormat("%04d.%02d.%02d %02d:%02d", mdt.year, mdt.mon, mdt.day, mdt.hour, mdt.min);
      FileWrite(fh, dateStr,
                DoubleToString(rates[i].open,  2),
                DoubleToString(rates[i].high,  2),
                DoubleToString(rates[i].low,   2),
                DoubleToString(rates[i].close, 2),
                (long)rates[i].tick_volume);
   }
   FileClose(fh);
   PrintFormat("Exportadas %d velas -> %s", copied, fileName);
}

void OnStart()
{
   PrintFormat("Exportando historico de %s (%d anios)...", InpSymbol, YearsBack);
   ExportTF(PERIOD_D1,  "D1");
   ExportTF(PERIOD_H4,  "H4");
   ExportTF(PERIOD_H1,  "H1");
   ExportTF(PERIOD_M15, "M15");
   ExportTF(PERIOD_M5,  "M5");
   ExportTF(PERIOD_M1,  "M1");
   Print("Listo. Archivos CSV en MQL5/Files/");
}
`;

export const Route = createFileRoute("/api/public/mt5-export")({
  server: {
    handlers: {
      GET: () =>
        new Response(SCRIPT, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": 'attachment; filename="XAUUSD_History_Export.mq5"',
            "Cache-Control": "public, max-age=3600",
          },
        }),
    },
  },
});