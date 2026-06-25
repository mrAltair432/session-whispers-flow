import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "@/lib/analysis";
import { ema } from "@/lib/analysis";

type Props = {
  candles: Candle[];
  title: string;
  trendLabel?: string;
  height?: number;
  highlights?: Array<{ price: number; color: string; label: string }>;
};

export function PriceChart({ candles, title, trendLabel, height = 320, highlights }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const ema20Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const ema50Ref = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      height,
      layout: {
        background: { color: "transparent" },
        textColor: "#a3a3b8",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      crosshair: { mode: 1 },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#3ecf8e",
      downColor: "#ef4444",
      borderUpColor: "#3ecf8e",
      borderDownColor: "#ef4444",
      wickUpColor: "#3ecf8e",
      wickDownColor: "#ef4444",
    });
    const e20 = chart.addSeries(LineSeries, { color: "#f0b929", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const e50 = chart.addSeries(LineSeries, { color: "#60a5fa", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

    chartRef.current = chart;
    candleRef.current = candleSeries;
    ema20Ref.current = e20;
    ema50Ref.current = e50;

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);

    return () => { ro.disconnect(); chart.remove(); };
  }, [height]);

  useEffect(() => {
    if (!candleRef.current || !ema20Ref.current || !ema50Ref.current) return;
    if (!candles.length) return;
    candleRef.current.setData(
      candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })),
    );
    const closes = candles.map((c) => c.close);
    if (closes.length >= 20) {
      const e20 = ema(closes, 20);
      ema20Ref.current.setData(candles.map((c, i) => ({ time: c.time as UTCTimestamp, value: e20[i] })));
    }
    if (closes.length >= 50) {
      const e50 = ema(closes, 50);
      ema50Ref.current.setData(candles.map((c, i) => ({ time: c.time as UTCTimestamp, value: e50[i] })));
    }

    // Apply price lines for highlights
    candleRef.current.applyOptions({});
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // Highlight price lines
  useEffect(() => {
    if (!candleRef.current || !highlights) return;
    const lines = highlights.map((h) =>
      candleRef.current!.createPriceLine({
        price: h.price,
        color: h.color,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: h.label,
      }),
    );
    return () => {
      lines.forEach((l) => candleRef.current?.removePriceLine(l));
    };
  }, [highlights]);

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-baseline justify-between mb-2 px-1">
        <div>
          <span className="text-xs font-semibold tracking-wider text-muted-foreground">{title}</span>
          {trendLabel && <span className="ml-2 text-xs text-primary">{trendLabel}</span>}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><i className="inline-block w-2 h-0.5 bg-[#f0b929]" />EMA20</span>
          <span className="flex items-center gap-1"><i className="inline-block w-2 h-0.5 bg-[#60a5fa]" />EMA50</span>
        </div>
      </div>
      <div ref={containerRef} />
    </div>
  );
}