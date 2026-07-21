"""Lovable Backtest — laboratorio Python de las 6 estrategias del dashboard.

Este módulo es la contraparte 1:1 de `src/lib/**` en TypeScript. Cualquier
cambio de lógica debe replicarse en ambos lados para que la paridad se
mantenga (ver README.md).

Estructura:
    - Indicadores           : ema, rsi, atr, macd, swings, BOS, detect_trend
    - I/O                   : parse_xau_csv, aggregate_candles, load_bars
    - Motor de backtest     : run_backtest_bars (mismo simulador que TS)
    - Estrategias           : STRATEGIES dict con las 6 funciones evaluate_*
    - Optimizador           : grid_search + walk_forward (paraleliza joblib)
    - Export                : export_best_params (JSON para dashboard/EA)
"""

from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from itertools import product
from typing import Any, Callable, Iterable

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Tipos y constantes
# ---------------------------------------------------------------------------

TF_MINUTES = {"M1": 1, "M5": 5, "M15": 15, "H1": 60, "H4": 240, "D1": 1440}

FEATURE_NAMES = (
    "h4Trend", "h1Sweep", "m15Fvg", "m15Bos", "killzone", "atrScore",
    "h1Align", "totalScore", "biasLong", "hourSin", "hourCos",
    "weekdaySin", "weekdayCos",
)

Bars = dict[str, pd.DataFrame]  # {"M1": df, "M5": df, ...}, ordenado por time asc


# ---------------------------------------------------------------------------
# Indicadores (paridad TS: src/lib/analysis.ts)
# ---------------------------------------------------------------------------

def ema(values: np.ndarray, period: int) -> np.ndarray:
    """EMA con seeding en values[0] (idéntico a analysis.ts)."""
    out = np.empty_like(values, dtype=float)
    if len(values) == 0:
        return out
    k = 2.0 / (period + 1.0)
    out[0] = values[0]
    for i in range(1, len(values)):
        out[i] = values[i] * k + out[i - 1] * (1 - k)
    return out


def atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    """ATR Wilder smoothing (idéntico a analysis.ts)."""
    n = len(close)
    out = np.zeros(n)
    if n < 2:
        return out
    trs = np.zeros(n)
    for i in range(1, n):
        trs[i] = max(
            high[i] - low[i],
            abs(high[i] - close[i - 1]),
            abs(low[i] - close[i - 1]),
        )
    prev = 0.0
    for i in range(1, n):
        if i < period:
            prev += trs[i]
            if i == period - 1:
                prev = prev / (period - 1)
                out[i] = prev
        else:
            prev = (prev * (period - 1) + trs[i]) / period
            out[i] = prev
    return out


def rsi(close: np.ndarray, period: int = 14) -> np.ndarray:
    n = len(close)
    out = np.full(n, 50.0)
    if n <= period:
        return out
    gain = loss = 0.0
    for i in range(1, period + 1):
        d = close[i] - close[i - 1]
        if d >= 0:
            gain += d
        else:
            loss -= d
    gain /= period
    loss /= period
    out[period] = 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)
    for i in range(period + 1, n):
        d = close[i] - close[i - 1]
        g = d if d > 0 else 0
        l = -d if d < 0 else 0
        gain = (gain * (period - 1) + g) / period
        loss = (loss * (period - 1) + l) / period
        out[i] = 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)
    return out


def macd(close: np.ndarray, fast: int = 12, slow: int = 26, signal: int = 9):
    fast_e = ema(close, fast)
    slow_e = ema(close, slow)
    macd_line = fast_e - slow_e
    sig_line = ema(macd_line, signal)
    hist = macd_line - sig_line
    return macd_line, sig_line, hist


@dataclass
class Swing:
    index: int
    price: float
    type: str  # "high" | "low"
    time: int


def detect_swings(df: pd.DataFrame, lookback: int = 2) -> list[Swing]:
    high = df["high"].values
    low = df["low"].values
    time = df["time"].values
    out: list[Swing] = []
    n = len(df)
    for i in range(lookback, n - lookback):
        is_high = True
        is_low = True
        for j in range(1, lookback + 1):
            if high[i] <= high[i - j] or high[i] <= high[i + j]:
                is_high = False
            if low[i] >= low[i - j] or low[i] >= low[i + j]:
                is_low = False
        if is_high:
            out.append(Swing(i, float(high[i]), "high", int(time[i])))
        if is_low:
            out.append(Swing(i, float(low[i]), "low", int(time[i])))
    return out


def detect_trend(df: pd.DataFrame) -> str:
    if len(df) < 50:
        return "ranging"
    closes = df["close"].values
    e20 = ema(closes, 20)[-1]
    e50 = ema(closes, 50)[-1]
    diff = (e20 - e50) / e50
    if diff > 0.0005:
        return "bullish"
    if diff < -0.0005:
        return "bearish"
    return "ranging"


def detect_bos(df: pd.DataFrame, bias: str, lookback: int = 20) -> bool:
    if len(df) < lookback + 3:
        return False
    window = df.iloc[-lookback - 1 : -1]
    last = df.iloc[-1]
    if bias == "long":
        return last["close"] > window["high"].max()
    return last["close"] < window["low"].min()


def detect_recent_sweep(df: pd.DataFrame, swings: list[Swing]):
    n = len(df)
    if n < 3:
        return None
    last = df.iloc[-1]
    for s in reversed([s for s in swings if s.index < n - 1 and s.index > n - 50]):
        if s.type == "high" and last["high"] > s.price and last["close"] < s.price:
            return {"type": "high", "swept_price": s.price, "swept_time": s.time, "candle_time": int(last["time"])}
        if s.type == "low" and last["low"] < s.price and last["close"] > s.price:
            return {"type": "low", "swept_price": s.price, "swept_time": s.time, "candle_time": int(last["time"])}
    return None


def detect_fvgs(df: pd.DataFrame, max_age_bars: int = 30):
    fvgs = []
    high = df["high"].values
    low = df["low"].values
    time = df["time"].values
    n = len(df)
    start = max(2, n - max_age_bars)
    for i in range(start, n):
        c1_high, c1_low = high[i - 2], low[i - 2]
        c3_high, c3_low = high[i], low[i]
        if c3_low > c1_high:
            fvgs.append({"start_time": int(time[i - 2]), "end_time": int(time[i]),
                         "top": c3_low, "bottom": c1_high, "bias": "bullish"})
        if c3_high < c1_low:
            fvgs.append({"start_time": int(time[i - 2]), "end_time": int(time[i]),
                         "top": c1_low, "bottom": c3_high, "bias": "bearish"})
    return fvgs


# ---------------------------------------------------------------------------
# I/O — parser CSV (paridad con src/lib/csv-parser.ts)
# ---------------------------------------------------------------------------

_RE_MT5 = re.compile(r"^(\d{4})[./-](\d{1,2})[./-](\d{1,2})\s+(\d{1,2}):(\d{2})")
_RE_US = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2})")


def parse_xau_csv(path: str) -> pd.DataFrame:
    """Parsea CSV en formato MT5 export o Investing/Web. Devuelve DataFrame
    ordenado por time asc, deduplicado por timestamp."""
    rows: list[tuple[int, float, float, float, float]] = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip().replace('"', "")
            if not line:
                continue
            parts = line.split(",")
            if len(parts) < 5:
                continue
            m = _RE_MT5.match(parts[0]) or _RE_US.match(parts[0])
            if not m:
                continue
            if m.re is _RE_MT5:
                yyyy, mm, dd, hh, mi = m.groups()
            else:
                mm, dd, yyyy, hh, mi = m.groups()
            try:
                o, h, l, c = (float(parts[i]) for i in range(1, 5))
            except ValueError:
                continue
            if any(not math.isfinite(v) for v in (o, h, l, c)):
                continue
            t = int(datetime(int(yyyy), int(mm), int(dd), int(hh), int(mi),
                              tzinfo=timezone.utc).timestamp())
            rows.append((t, o, h, l, c))
    if not rows:
        return pd.DataFrame(columns=["time", "open", "high", "low", "close"])
    df = pd.DataFrame(rows, columns=["time", "open", "high", "low", "close"])
    df = df.drop_duplicates("time").sort_values("time").reset_index(drop=True)
    return df


def aggregate_candles(source: pd.DataFrame, target_minutes: int) -> pd.DataFrame:
    """Agrega OHLC alineando buckets al epoch UTC (idéntico a csv-parser.ts)."""
    if source.empty:
        return source
    bucket = target_minutes * 60
    b = (source["time"].values // bucket) * bucket
    df = source.copy()
    df["_b"] = b
    grp = df.groupby("_b", sort=True)
    out = pd.DataFrame({
        "time": grp["_b"].first().values,
        "open": grp["open"].first().values,
        "high": grp["high"].max().values,
        "low": grp["low"].min().values,
        "close": grp["close"].last().values,
    }).reset_index(drop=True)
    return out


def load_bars(files: dict[str, str], build_missing: bool = True) -> Bars:
    """Carga un dict {tf: csv_path} y devuelve un `Bars` completo.

    Si `build_missing=True`, cualquier TF ausente se agrega desde el TF más
    fino disponible (ej. M1 → M5/M15/H1/H4)."""
    bars: Bars = {}
    for tf, path in files.items():
        if tf not in TF_MINUTES:
            raise ValueError(f"TF desconocido: {tf}")
        bars[tf] = parse_xau_csv(path)
    if build_missing and bars:
        # elige el TF más fino como fuente para agregar los faltantes
        avail = [(tf, TF_MINUTES[tf]) for tf in bars]
        avail.sort(key=lambda x: x[1])
        finest_tf, finest_min = avail[0]
        src = bars[finest_tf]
        for tf, m in TF_MINUTES.items():
            if tf not in bars and m > finest_min:
                bars[tf] = aggregate_candles(src, m)
    return bars


def slice_bars_last_months(bars: Bars, months: int = 4) -> Bars:
    """Recorta todos los timeframes a los últimos `months` meses aproximados.

    Útil en Colab: evita que grid/walk-forward/ML recorran 5 años completos.
    El corte se calcula desde el timestamp máximo disponible del TF más fino.
    """
    if not bars:
        return bars
    finest_tf = min(bars.keys(), key=lambda tf: TF_MINUTES.get(tf, 10**9))
    finest = bars[finest_tf]
    if finest.empty:
        return bars
    month_seconds = 30 * 24 * 3600
    t1 = int(finest["time"].max())
    t0 = t1 - int(months * month_seconds)
    out: Bars = {}
    for tf, df in bars.items():
        if df.empty:
            out[tf] = df
            continue
        mask = df["time"] >= t0
        out[tf] = df.loc[mask].reset_index(drop=True)
    return out


# ---------------------------------------------------------------------------
# Filtros de mercado (paridad con backtest.ts::isMarketClosedOrRisky)
# ---------------------------------------------------------------------------

def is_market_closed_or_risky(unix_seconds: int) -> bool:
    d = datetime.fromtimestamp(unix_seconds, tz=timezone.utc)
    wd = (d.weekday() + 1) % 7  # convertir a 0=Sun..6=Sat (JS style)
    h = d.hour
    if wd == 6:                        # sábado
        return True
    if wd == 0 and h < 22:             # domingo antes de apertura
        return True
    if wd == 5 and h >= 21:            # cierre viernes
        return True
    if wd == 1 and h < 2:              # gap lunes
        return True
    if 1 <= wd <= 4 and h == 22:       # pausa CME diaria
        return True
    return False


# ---------------------------------------------------------------------------
# Simulador de trade (paridad con backtest.ts::simulateTrade)
# ---------------------------------------------------------------------------

@dataclass
class TradeSim:
    exit: float
    r_multiple: float
    outcome: str  # 'tp1'|'tp2'|'tp3'|'sl'|'be'|'timeout'
    close_time: int


def simulate_trade(
    df: pd.DataFrame, entry_idx: int, bias: str, entry: float,
    initial_sl: float, tp1: float, tp2: float, tp3: float,
    max_hold_bars: int, cost_per_side_usd: float,
    management: dict | None = None,
) -> TradeSim:
    high = df["high"].values
    low = df["low"].values
    close = df["close"].values
    open_ = df["open"].values
    time = df["time"].values
    init_risk = abs(entry - initial_sl)
    sl = initial_sl
    tp1_hit = False
    tp2_hit = False
    realized_r = 0.0
    remaining = 1.0
    cost_r = cost_per_side_usd / init_risk if init_risk > 0 else 0.0
    realized_r -= cost_r  # coste entrada
    be_at_r = (management or {}).get("breakEvenAtR")
    time_stop_bars = (management or {}).get("timeStopBars")
    be_moved = False

    end = min(len(df) - 1, entry_idx + max_hold_bars)

    def close_remaining(price: float, t: int, outcome: str) -> TradeSim:
        nonlocal realized_r, remaining
        move_r = (price - entry) / init_risk if bias == "long" else (entry - price) / init_risk
        realized_r += remaining * move_r
        realized_r -= remaining * cost_r
        remaining = 0.0
        return TradeSim(price, realized_r, outcome, int(t))

    for i in range(entry_idx + 1, end + 1):
        # Time-stop (H)
        if (not tp1_hit) and time_stop_bars and (i - entry_idx) >= time_stop_bars:
            return close_remaining(float(open_[i]), time[i], "timeout")
        # Break-even a N*R (I)
        if (not tp1_hit) and (not be_moved) and be_at_r and be_at_r > 0:
            trigger = entry + be_at_r * init_risk if bias == "long" else entry - be_at_r * init_risk
            reached = high[i] >= trigger if bias == "long" else low[i] <= trigger
            if reached:
                sl = entry
                be_moved = True
        if bias == "long":
            if low[i] <= sl:
                if not tp1_hit:
                    return close_remaining(sl, time[i], "be" if be_moved else "sl")
                outcome = "tp2" if tp2_hit else "tp1"
                return close_remaining(sl, time[i], outcome)
            if not tp1_hit and high[i] >= tp1:
                realized_r += 0.5 * 1
                realized_r -= 0.5 * cost_r
                remaining -= 0.5
                sl = entry
                tp1_hit = True
            if tp1_hit and not tp2_hit and high[i] >= tp2:
                realized_r += 0.3 * 2
                realized_r -= 0.3 * cost_r
                remaining -= 0.3
                tp2_hit = True
            if tp2_hit and high[i] >= tp3:
                realized_r += 0.2 * 3
                realized_r -= 0.2 * cost_r
                remaining = 0
                return TradeSim(tp3, realized_r, "tp3", int(time[i]))
        else:
            if high[i] >= sl:
                if not tp1_hit:
                    return close_remaining(sl, time[i], "be" if be_moved else "sl")
                outcome = "tp2" if tp2_hit else "tp1"
                return close_remaining(sl, time[i], outcome)
            if not tp1_hit and low[i] <= tp1:
                realized_r += 0.5 * 1
                realized_r -= 0.5 * cost_r
                remaining -= 0.5
                sl = entry
                tp1_hit = True
            if tp1_hit and not tp2_hit and low[i] <= tp2:
                realized_r += 0.3 * 2
                realized_r -= 0.3 * cost_r
                remaining -= 0.3
                tp2_hit = True
            if tp2_hit and low[i] <= tp3:
                realized_r += 0.2 * 3
                realized_r -= 0.2 * cost_r
                remaining = 0
                return TradeSim(tp3, realized_r, "tp3", int(time[i]))
    return close_remaining(close[end], time[end], "timeout")


# ---------------------------------------------------------------------------
# Features (mismo orden que TS::buildFeatures)
# ---------------------------------------------------------------------------

def build_features(breakdown: dict, bias: str, hour_utc: int, weekday: int) -> list[float]:
    two_pi = math.pi * 2
    return [
        breakdown["h4Trend"] / 20,
        breakdown["h1Sweep"] / 25,
        breakdown["m15Fvg"] / 20,
        breakdown["m15Bos"] / 15,
        breakdown["killzone"] / 12,
        breakdown["atr"] / 10,
        breakdown["h1Alignment"] / 5,
        breakdown["total"] / 100,
        1.0 if bias == "long" else 0.0,
        math.sin(two_pi * hour_utc / 24),
        math.cos(two_pi * hour_utc / 24),
        math.sin(two_pi * weekday / 7),
        math.cos(two_pi * weekday / 7),
    ]


# ---------------------------------------------------------------------------
# Estrategias — ports 1:1 desde src/lib/strategies/*.ts
# ---------------------------------------------------------------------------

def _bars_slice_up_to(df: pd.DataFrame, t: int) -> pd.DataFrame:
    if df.empty:
        return df
    idx = np.searchsorted(df["time"].values, t, side="right") - 1
    if idx < 0:
        return df.iloc[0:0]
    return df.iloc[: idx + 1]


def _round(n: float) -> float:
    return round(n * 100) / 100


# ---- E3: Fibo Scalping M5 ---------------------------------------------------

def evaluate_fibo_scalping(bars: Bars, params: dict) -> dict | None:
    min_score = params.get("min_score", 65)
    h4 = bars.get("H4"); h1 = bars.get("H1"); m15 = bars.get("M15"); m5 = bars.get("M5")
    if h4 is None or h1 is None or m15 is None or m5 is None:
        return None
    if len(h4) < 50 or len(h1) < 40 or len(m15) < 25 or len(m5) < 60:
        return None
    h4_close = h4["close"].values
    e20 = ema(h4_close, 20)[-1]; e50 = ema(h4_close, 50)[-1]
    diff_h4 = (e20 - e50) / e50
    if abs(diff_h4) < 0.0005:
        return None
    bias = "long" if diff_h4 > 0 else "short"

    h1_window = h1.iloc[-40:]
    swings = detect_swings(h1_window.reset_index(drop=True), 2)
    if len(swings) < 2:
        return None
    last_high = next((s for s in reversed(swings) if s.type == "high"), None)
    last_low = next((s for s in reversed(swings) if s.type == "low"), None)
    if not last_high or not last_low:
        return None
    hi = last_high.price; lo = last_low.price
    rng = hi - lo
    if rng <= 0:
        return None
    if bias == "long":
        lvl500 = hi - rng * 0.5; lvl618 = hi - rng * 0.618; lvl786 = hi - rng * 0.786
        zone_top, zone_bot = lvl500, lvl786
    else:
        lvl500 = lo + rng * 0.5; lvl618 = lo + rng * 0.618; lvl786 = lo + rng * 0.786
        zone_top, zone_bot = lvl786, lvl500
    recent = m15.iloc[-6:]
    touched = ((recent["low"] <= zone_top) & (recent["high"] >= zone_bot)).any()
    if not touched:
        return None

    last_m5 = m5.iloc[-1]
    e20_5 = ema(m5["close"].values, 20)[-1]
    if bias == "long":
        m5_confirm = last_m5["close"] > last_m5["open"] and last_m5["close"] >= lvl618 and last_m5["close"] > e20_5
    else:
        m5_confirm = last_m5["close"] < last_m5["open"] and last_m5["close"] <= lvl618 and last_m5["close"] < e20_5
    if not m5_confirm:
        return None
    bos_ok = detect_bos(m5, bias, 20)

    d = datetime.fromtimestamp(int(last_m5["time"]), tz=timezone.utc)
    h_utc = d.hour; wd = (d.weekday() + 1) % 7
    in_kz = 7 <= h_utc < 11
    if wd == 0:
        return None
    if wd == 5 and h_utc >= 12:
        return None

    m5_atr = atr(m5["high"].values, m5["low"].values, m5["close"].values, 14)
    last_atr = m5_atr[-1] or 1.0
    recent_atr = np.sort(m5_atr[-120:][m5_atr[-120:] > 0])
    median = recent_atr[len(recent_atr) // 2] if len(recent_atr) else last_atr
    atr_ratio = last_atr / median if median > 0 else 1.0
    if atr_ratio < 0.7:
        return None

    h1_close = h1["close"].values
    h1_e20 = ema(h1_close, 20)[-1]; h1_e50 = ema(h1_close, 50)[-1]
    h1_aligned = h1_e20 > h1_e50 if bias == "long" else h1_e20 < h1_e50

    breakdown = {
        "h4Trend": 20,
        "h1Sweep": 20,
        "m15Fvg": 15,
        "m15Bos": 15 if bos_ok else 5,
        "killzone": 12 if in_kz else 0,
        "atr": 10 if atr_ratio >= 1 else 7 if atr_ratio >= 0.85 else 4,
        "h1Alignment": 5 if h1_aligned else 0,
    }
    breakdown["total"] = sum(breakdown[k] for k in breakdown if k != "total")
    if breakdown["total"] < min_score:
        return None

    entry = float(last_m5["close"])
    buffer_ = max(last_atr * 0.5, (last_m5["high"] - last_m5["low"]) * 0.4)
    sl = lvl786 - buffer_ if bias == "long" else lvl786 + buffer_
    risk = abs(entry - sl)
    if risk <= 0:
        return None
    tp1 = entry + risk if bias == "long" else entry - risk
    tp2 = entry + risk * 2 if bias == "long" else entry - risk * 2
    tp3 = entry + risk * 3 if bias == "long" else entry - risk * 3
    return {
        "bias": bias, "score": breakdown["total"], "scoreBreakdown": breakdown,
        "entry": _round(entry), "stopLoss": _round(sl),
        "tp1": _round(tp1), "tp2": _round(tp2), "tp3": _round(tp3),
    }


# ---- E4: VWAP Mean Reversion M1 --------------------------------------------

def evaluate_gold_scalping(bars: Bars, params: dict) -> dict | None:
    min_score = params.get("min_score", 65)
    m1 = bars.get("M1"); m5 = bars.get("M5")
    if m1 is None or m5 is None or len(m1) < 90 or len(m5) < 20:
        return None
    last = m1.iloc[-1]
    d = datetime.fromtimestamp(int(last["time"]), tz=timezone.utc)
    h_utc = d.hour; wd = (d.weekday() + 1) % 7
    if wd == 0 or wd == 6:
        return None
    if h_utc >= 22 or h_utc < 5:
        return None
    day_start = (int(last["time"]) // 86400) * 86400
    sess = m1[(m1["time"] >= day_start) & (m1["time"] <= int(last["time"]))]
    if len(sess) < 60:
        return None
    typical = (sess["high"].values + sess["low"].values + sess["close"].values) / 3
    w = np.maximum(0.01, sess["high"].values - sess["low"].values)
    vv = w.sum()
    if vv <= 0:
        return None
    vwap = float((typical * w).sum() / vv)
    sigma = float(np.sqrt(((typical - vwap) ** 2).mean()))
    sigma_safe = max(0.05, sigma)

    m1_atr = atr(m1["high"].values, m1["low"].values, m1["close"].values, 14)
    last_m1_atr = m1_atr[-1] or 0.15
    if last_m1_atr < 0.10:
        return None
    m5_atr_arr = atr(m5["high"].values, m5["low"].values, m5["close"].values, 14)
    last_m5_atr = m5_atr_arr[-1] or 0.4
    if last_m5_atr < 0.4:
        return None
    stretch_sigmas = abs(last["close"] - vwap) / sigma_safe
    if stretch_sigmas < 1.5:
        return None
    bias = "long" if last["close"] < vwap else "short"

    rng = max(0.01, last["high"] - last["low"])
    body = abs(last["close"] - last["open"])
    upper_wick = last["high"] - max(last["open"], last["close"])
    lower_wick = min(last["open"], last["close"]) - last["low"]
    close_pos = (last["close"] - last["low"]) / rng
    reject_long = bias == "long" and last["close"] > last["open"] and lower_wick > body and close_pos > 0.6
    reject_short = bias == "short" and last["close"] < last["open"] and upper_wick > body and close_pos < 0.4
    if not reject_long and not reject_short:
        return None

    e20 = ema(m5["close"].values, 20)[-1]; e50 = ema(m5["close"].values, 50)[-1]
    m5_diff = (e20 - e50) / e50
    m5_up = m5_diff > 0.0002; m5_dn = m5_diff < -0.0002
    m5_with = (bias == "long" and m5_up) or (bias == "short" and m5_dn)
    m5_neutral = (not m5_up) and (not m5_dn)

    stretch_score = min(30, round((stretch_sigmas - 1) * 12))
    wick = lower_wick if bias == "long" else upper_wick
    wick_score = min(20, round((wick / rng) * 25))
    body_score = min(15, round((body / rng) * 20))
    atr_m1_score = 10 if last_m1_atr >= 0.35 else 7 if last_m1_atr >= 0.20 else 4
    atr_m5_score = 10 if last_m5_atr >= 1 else 8 if last_m5_atr >= 0.6 else 5
    hour_score = 10 if 7 <= h_utc <= 16 else 5
    align_score = 5 if m5_with else 3 if m5_neutral else 1
    breakdown = {
        "h4Trend": stretch_score, "h1Sweep": wick_score, "m15Fvg": body_score,
        "m15Bos": atr_m1_score, "killzone": hour_score, "atr": atr_m5_score,
        "h1Alignment": align_score,
    }
    breakdown["total"] = sum(v for k, v in breakdown.items() if k != "total")
    if breakdown["total"] < min_score:
        return None

    entry = float(last["close"])
    w3 = m1.iloc[-3:]
    hi3 = w3["high"].max(); lo3 = w3["low"].min()
    buffer_ = max(last_m1_atr * 0.3, 0.15)
    sl = lo3 - buffer_ if bias == "long" else hi3 + buffer_
    risk = abs(entry - sl)
    if risk <= 0.1:
        return None
    dist_to_vwap = abs(vwap - entry)
    if dist_to_vwap < risk * 0.8:
        return None
    tp1 = vwap
    tp2 = vwap + sigma_safe if bias == "long" else vwap - sigma_safe
    tp3 = entry + dist_to_vwap * 1.5 if bias == "long" else entry - dist_to_vwap * 1.5
    return {"bias": bias, "score": breakdown["total"], "scoreBreakdown": breakdown,
            "entry": _round(entry), "stopLoss": _round(sl),
            "tp1": _round(tp1), "tp2": _round(tp2), "tp3": _round(tp3)}


# ---- E5: EMA Cross Reversal M1 (simétrico) ---------------------------------

def evaluate_ema_cross_m1(bars: Bars, params: dict) -> dict | None:
    min_score = params.get("min_score", 70)
    m1 = bars.get("M1"); m5 = bars.get("M5")
    if m1 is None or m5 is None or len(m1) < 60 or len(m5) < 30:
        return None
    last = m1.iloc[-1]; prev = m1.iloc[-2]
    closes = m1["close"].values
    e9 = ema(closes, 9); e21 = ema(closes, 21)
    n = len(closes) - 1
    cross_up = e9[n - 1] <= e21[n - 1] and e9[n] > e21[n]
    cross_dn = e9[n - 1] >= e21[n - 1] and e9[n] < e21[n]
    if not cross_up and not cross_dn:
        return None
    bias = "long" if cross_up else "short"
    slope = e9[n] - e9[n - 5]
    if not (slope >= 0.10 if bias == "long" else slope <= -0.10):
        return None
    r = rsi(closes, 14)[-1]
    if not (r > 55 if bias == "long" else r < 45):
        return None
    _, _, hist = macd(closes)
    h0, h_1 = hist[n], hist[n - 1]
    macd_ok = (h0 > 0 and h_1 <= 0) if bias == "long" else (h0 < 0 and h_1 >= 0)
    if not macd_ok:
        return None
    d = datetime.fromtimestamp(int(last["time"]), tz=timezone.utc)
    h_utc = d.hour; wd = (d.weekday() + 1) % 7
    if wd == 0 or wd == 6:
        return None
    if not (7 <= h_utc <= 16):
        return None
    m5_atr_arr = atr(m5["high"].values, m5["low"].values, m5["close"].values, 14)
    last_m5_atr = m5_atr_arr[-1] or 0.0
    if last_m5_atr < 0.40:
        return None
    m1_atr = atr(m1["high"].values, m1["low"].values, m1["close"].values, 14)
    last_m1_atr = m1_atr[-1] or 0.15

    slope_strength = min(1.0, abs(slope) / 0.30)
    rsi_strength = min(1.0, ((r - 55) / 15) if bias == "long" else ((45 - r) / 15))
    atr_score_m5 = 10 if last_m5_atr >= 1 else 8 if last_m5_atr >= 0.6 else 5
    body_range = max(0.01, last["high"] - last["low"])
    body_pct = abs(last["close"] - last["open"]) / body_range
    breakdown = {
        "h4Trend": round(20 * slope_strength),
        "h1Sweep": round(20 * rsi_strength),
        "m15Fvg": 15,
        "m15Bos": round(10 * body_pct),
        "killzone": 10,
        "atr": atr_score_m5,
        "h1Alignment": 5 if ((bias == "long" and last["close"] > prev["close"])
                             or (bias == "short" and last["close"] < prev["close"])) else 2,
    }
    breakdown["total"] = sum(v for k, v in breakdown.items() if k != "total")
    if breakdown["total"] < min_score:
        return None
    entry = float(last["close"])
    w3 = m1.iloc[-3:]
    hi3 = w3["high"].max(); lo3 = w3["low"].min()
    buffer_ = last_m1_atr * 1.2
    sl = lo3 - buffer_ if bias == "long" else hi3 + buffer_
    risk = abs(entry - sl)
    if risk <= 0.1:
        return None
    tp1 = entry + risk if bias == "long" else entry - risk
    tp2 = entry + risk * 2 if bias == "long" else entry - risk * 2
    tp3 = entry + risk * 3 if bias == "long" else entry - risk * 3
    return {"bias": bias, "score": breakdown["total"], "scoreBreakdown": breakdown,
            "entry": _round(entry), "stopLoss": _round(sl),
            "tp1": _round(tp1), "tp2": _round(tp2), "tp3": _round(tp3)}


# ---- E6: Straddle Breakout ATR M1 ------------------------------------------

def evaluate_straddle_breakout(bars: Bars, params: dict) -> dict | None:
    min_score = params.get("min_score", 65)
    m1 = bars.get("M1"); m5 = bars.get("M5")
    if m1 is None or m5 is None or len(m1) < 40 or len(m5) < 20:
        return None
    last = m1.iloc[-1]; prev = m1.iloc[-2]
    d = datetime.fromtimestamp(int(last["time"]), tz=timezone.utc)
    h_utc = d.hour; wd = (d.weekday() + 1) % 7
    if wd == 0 or wd == 6:
        return None
    in_london = 7 <= h_utc < 10
    in_ny = 13 <= h_utc < 15
    if not (in_london or in_ny):
        return None
    m5_atr_arr = atr(m5["high"].values, m5["low"].values, m5["close"].values, 14)
    last_m5_atr = m5_atr_arr[-1] or 0.0
    if last_m5_atr < 0.35:
        return None
    m1_atr = atr(m1["high"].values, m1["low"].values, m1["close"].values, 14)
    last_m1_atr = m1_atr[-1] or 0.15
    D = 0.6 * last_m5_atr
    upper = prev["close"] + D; lower = prev["close"] - D
    rng = max(0.01, last["high"] - last["low"])
    body = abs(last["close"] - last["open"])
    body_pct = body / rng
    break_up = last["close"] > upper and last["close"] > last["open"] and body_pct >= 0.55
    break_dn = last["close"] < lower and last["close"] < last["open"] and body_pct >= 0.55
    if not break_up and not break_dn:
        return None
    bias = "long" if break_up else "short"
    e20 = ema(m5["close"].values, 20)[-1]; e50 = ema(m5["close"].values, 50)[-1]
    m5_bias = e20 - e50
    m5_aligned = m5_bias > 0 if bias == "long" else m5_bias < 0
    stretch = abs(last["close"] - prev["close"]) / max(0.05, D)
    stretch_score = min(25, round(stretch * 15))
    body_score = min(20, round(body_pct * 25))
    atr_score_m5 = 10 if last_m5_atr >= 1 else 8 if last_m5_atr >= 0.6 else 5
    breakdown = {
        "h4Trend": stretch_score, "h1Sweep": body_score, "m15Fvg": 15,
        "m15Bos": 10 if m5_aligned else 3,
        "killzone": 12 if in_london else 10,
        "atr": atr_score_m5, "h1Alignment": 5,
    }
    breakdown["total"] = sum(v for k, v in breakdown.items() if k != "total")
    if breakdown["total"] < min_score:
        return None
    entry = float(last["close"])
    buffer_ = last_m1_atr * 0.8
    sl = entry - buffer_ if bias == "long" else entry + buffer_
    risk = abs(entry - sl)
    if risk <= 0.1:
        return None
    tp1 = entry + risk if bias == "long" else entry - risk
    tp2 = entry + risk * 2 if bias == "long" else entry - risk * 2
    tp3 = entry + risk * 3 if bias == "long" else entry - risk * 3
    return {"bias": bias, "score": breakdown["total"], "scoreBreakdown": breakdown,
            "entry": _round(entry), "stopLoss": _round(sl),
            "tp1": _round(tp1), "tp2": _round(tp2), "tp3": _round(tp3)}


# ---- E1: SMC Londres (Sweep + FVG) — port compacto -------------------------

def evaluate_smc_london(bars: Bars, params: dict) -> dict | None:
    min_score = params.get("min_score", 70)
    h4 = bars.get("H4"); h1 = bars.get("H1"); m15 = bars.get("M15")
    if h4 is None or h1 is None or m15 is None:
        return None
    if len(h4) < 50 or len(h1) < 50 or len(m15) < 25:
        return None
    trend = detect_trend(h4)
    if trend == "ranging":
        return None
    bias = "long" if trend == "bullish" else "short"
    h1_swings = detect_swings(h1, 2)
    sweep = detect_recent_sweep(h1, h1_swings)
    if sweep is None:
        return None
    sweep_aligned = (bias == "long" and sweep["type"] == "low") or (bias == "short" and sweep["type"] == "high")
    if not sweep_aligned:
        return None
    fvgs = detect_fvgs(m15, 30)
    fvg = next((f for f in reversed(fvgs) if (bias == "long" and f["bias"] == "bullish") or (bias == "short" and f["bias"] == "bearish")), None)
    if not fvg:
        return None
    bos_ok = detect_bos(m15, bias, 20)
    if not bos_ok:
        return None
    last = m15.iloc[-1]
    d = datetime.fromtimestamp(int(last["time"]), tz=timezone.utc)
    h_utc = d.hour
    in_kz = 2 <= h_utc < 5
    m15_atr = atr(m15["high"].values, m15["low"].values, m15["close"].values, 14)
    last_atr = m15_atr[-1] or 1
    recent = np.sort(m15_atr[-80:][m15_atr[-80:] > 0])
    median = recent[len(recent) // 2] if len(recent) else last_atr
    atr_ratio = last_atr / median if median > 0 else 1
    if atr_ratio < 0.7:
        return None
    breakdown = {
        "h4Trend": 20, "h1Sweep": 25, "m15Fvg": 20, "m15Bos": 10,
        "killzone": 10 if in_kz else 0,
        "atr": 10 if atr_ratio >= 1 else 7 if atr_ratio >= 0.85 else 4,
        "h1Alignment": 5,
    }
    breakdown["total"] = sum(v for k, v in breakdown.items() if k != "total")
    if breakdown["total"] < min_score:
        return None
    entry = float(last["close"])
    buffer_ = max(last_atr * 0.5, (last["high"] - last["low"]) * 0.4)
    sl = fvg["bottom"] - buffer_ if bias == "long" else fvg["top"] + buffer_
    risk = abs(entry - sl)
    if risk <= 0:
        return None
    tp1 = entry + risk if bias == "long" else entry - risk
    tp2 = entry + risk * 2 if bias == "long" else entry - risk * 2
    tp3 = entry + risk * 3 if bias == "long" else entry - risk * 3
    return {"bias": bias, "score": breakdown["total"], "scoreBreakdown": breakdown,
            "entry": _round(entry), "stopLoss": _round(sl),
            "tp1": _round(tp1), "tp2": _round(tp2), "tp3": _round(tp3)}


# ---- E2: Alligator + Bollinger Breakout (M15) ----------------------------
# Réplica 1:1 de src/lib/strategies/alligator-bb.ts. Basado en el EA MQL5
# AlligatorBB_RegimeEA_v2 del usuario. Ver ese archivo para las reglas.

def _smma(values: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(values), np.nan, dtype=float)
    if len(values) < n:
        return out
    out[n - 1] = float(np.mean(values[:n]))
    for i in range(n, len(values)):
        out[i] = (out[i - 1] * (n - 1) + values[i]) / n
    return out


def _bollinger_at(closes: np.ndarray, idx: int, n: int, k: float):
    if idx < n - 1:
        return None
    window = closes[idx - n + 1 : idx + 1]
    mid = float(window.mean())
    sd  = float(window.std(ddof=0))
    return mid + k * sd, mid, mid - k * sd


def evaluate_alligator_bb(bars: Bars, params: dict) -> dict | None:
    min_score = params.get("min_score", 70)
    m15 = bars.get("M15"); h1 = bars.get("H1"); h4 = bars.get("H4")
    if m15 is None or h1 is None:
        return None
    if len(m15) < 60 or len(h1) < 220:
        return None

    last = m15.iloc[-1]; prev = m15.iloc[-2]
    dt = datetime.fromtimestamp(int(last["time"]), tz=timezone.utc)
    h_utc = dt.hour
    # [J] Overlap Londres-NY estricto
    if not (12 <= h_utc <= 17):
        return None
    in_kz = True

    # Alligator SMMA sobre precio mediano
    median = ((m15["high"].values + m15["low"].values) / 2.0)
    jaw_arr   = _smma(median, 13)
    teeth_arr = _smma(median, 8)
    lips_arr  = _smma(median, 5)
    i = len(m15) - 1
    if i - 9 < 0:
        return None
    jaw0, jaw1     = jaw_arr[i - 8],   jaw_arr[i - 9]
    teeth0, teeth1 = teeth_arr[i - 5], teeth_arr[i - 6]
    lips0, lips1   = lips_arr[i - 3],  lips_arr[i - 4]
    vals = [jaw0, jaw1, teeth0, teeth1, lips0, lips1]
    if any((not np.isfinite(v)) for v in vals):
        return None

    bull = lips0 > teeth0 > jaw0 and lips1 > teeth1 > jaw1
    bear = lips0 < teeth0 < jaw0 and lips1 < teeth1 < jaw1
    if not (bull or bear):
        return None
    bias = "long" if bull else "short"

    closes = m15["close"].values
    bb0 = _bollinger_at(closes, i, 20, 2.0)
    if bb0 is None:
        return None
    up0, mid0, lo0 = bb0

    m15_atr = atr(m15["high"].values, m15["low"].values, m15["close"].values, 14)
    last_a = float(m15_atr[-1]) if len(m15_atr) else 0.0
    if last_a <= 0:
        return None

    # [F] TTM-Squeeze release: BB dentro de Keltner(20,1.5×ATR) en las
    # últimas 6-20 velas, y AHORA fuera.
    k_mult = 1.5
    kc_up0 = mid0 + k_mult * last_a
    kc_lo0 = mid0 - k_mult * last_a
    if not (up0 > kc_up0 and lo0 < kc_lo0):
        return None
    had_squeeze = False
    for kk in range(2, 21):
        idx = i - kk
        if idx < 20: break
        bbk = _bollinger_at(closes, idx, 20, 2.0)
        atrk = float(m15_atr[idx]) if idx < len(m15_atr) else 0.0
        if bbk is None or atrk <= 0: continue
        upk, midk, lok = bbk
        kcU = midk + k_mult * atrk; kcL = midk - k_mult * atrk
        if upk < kcU and lok > kcL:
            had_squeeze = True
            break
    if not had_squeeze:
        return None

    # [A] RETEST: buscar breakout en velas i-1..i-3 (cuerpo≥65%, mecha≤30%)
    breakout_idx = -1
    breakout_body = 0.0
    breakout_range = 0.0
    for k in range(1, 4):
        b_idx = i - k
        if b_idx < 21:
            break
        bb_b = _bollinger_at(closes, b_idx, 20, 2.0)
        bb_bp = _bollinger_at(closes, b_idx - 1, 20, 2.0)
        if bb_b is None or bb_bp is None:
            continue
        up_b, _mid_b, lo_b = bb_b
        up_bp, _mid_bp, lo_bp = bb_bp
        bar = m15.iloc[b_idx]
        rng = max(0.01, float(bar["high"] - bar["low"]))
        bod = abs(float(bar["close"] - bar["open"]))
        body_pct = bod / rng
        if body_pct < 0.65:
            continue
        upper_wick = float(bar["high"]) - max(float(bar["open"]), float(bar["close"]))
        lower_wick = min(float(bar["open"]), float(bar["close"])) - float(bar["low"])
        opp_wick = upper_wick if bias == "long" else lower_wick
        if opp_wick / rng > 0.30:
            continue
        prev_bar = m15.iloc[b_idx - 1]
        broke_up   = bias == "long"  and float(prev_bar["close"]) <= up_bp and float(bar["close"]) > up_b and float(bar["close"]) > float(bar["open"])
        broke_down = bias == "short" and float(prev_bar["close"]) >= lo_bp and float(bar["close"]) < lo_b and float(bar["close"]) < float(bar["open"])
        if broke_up or broke_down:
            breakout_idx = b_idx
            breakout_body = body_pct
            breakout_range = rng
            break
    if breakout_idx < 0:
        return None

    if bias == "long":
        pulled_back = (float(last["low"]) <= up0 * 1.001
                       and float(last["close"]) > mid0
                       and float(last["close"]) > float(prev["low"]))
    else:
        pulled_back = (float(last["high"]) >= lo0 * 0.999
                       and float(last["close"]) < mid0
                       and float(last["close"]) < float(prev["high"]))
    if not pulled_back:
        return None

    # [G] Awesome Oscillator (Bill Williams)
    ao_arr = _awesome_osc(median, 5, 34)
    ao0, ao1, ao2 = ao_arr[i], ao_arr[i - 1], ao_arr[i - 2]
    if not all(np.isfinite([ao0, ao1, ao2])):
        return None
    if bias == "long"  and not (ao0 > 0 and ao0 > ao1 and ao1 > ao2): return None
    if bias == "short" and not (ao0 < 0 and ao0 < ao1 and ao1 < ao2): return None

    # [H] ADX(14) ≥ 22 en M15
    adx_v = _adx_last(m15["high"].values, m15["low"].values, m15["close"].values, 14)
    if not np.isfinite(adx_v) or adx_v < 22:
        return None

    # [I] Macro H1 EMA200 con pendiente
    h1_ema = ema(h1["close"].values, 200)
    last_ema = float(h1_ema[-1])
    if len(h1_ema) < 11:
        return None
    past_ema = float(h1_ema[-11])
    last_h1_close = float(h1.iloc[-1]["close"])
    if not np.isfinite(last_ema) or last_ema <= 0 or not np.isfinite(past_ema):
        return None
    if bias == "long"  and last_h1_close <= last_ema: return None
    if bias == "short" and last_h1_close >= last_ema: return None
    ema_slope = (last_ema - past_ema) / past_ema
    if bias == "long"  and ema_slope < 0.0002: return None
    if bias == "short" and ema_slope > -0.0002: return None

    # [I] H4 EMA200 alineada (si viene)
    if h4 is not None and len(h4) >= 210:
        h4_ema = ema(h4["close"].values, 200)
        last_h4 = float(h4.iloc[-1]["close"])
        last_h4_ema = float(h4_ema[-1])
        if np.isfinite(last_h4_ema) and last_h4_ema > 0:
            if bias == "long"  and last_h4 <= last_h4_ema: return None
            if bias == "short" and last_h4 >= last_h4_ema: return None

    arr = m15_atr[-80:]
    recent = np.sort(arr[arr > 0])
    median80 = float(recent[len(recent) // 2]) if len(recent) else last_a
    atr_ratio = last_a / median80 if median80 > 0 else 1.0
    if atr_ratio < 0.6 or atr_ratio > 2.0:
        return None

    gator_spread = abs(lips0 - jaw0) / last_a
    if gator_spread < 0.9:
        return None

    bb_width_pct = (up0 - lo0) / mid0
    if bb_width_pct < 0.004:
        return None

    entry = float(last["close"])
    lookback = m15.iloc[-10:]
    swing_low = float(lookback["low"].min())
    swing_high = float(lookback["high"].max())
    buffer_ = 0.3 * last_a
    struct_sl = swing_low - buffer_ if bias == "long" else swing_high + buffer_
    atr_cap = entry - 1.8 * last_a if bias == "long" else entry + 1.8 * last_a
    sl = max(struct_sl, atr_cap) if bias == "long" else min(struct_sl, atr_cap)
    min_risk = 0.6 * last_a
    if abs(entry - sl) < min_risk:
        sl = entry - min_risk if bias == "long" else entry + min_risk
    risk = abs(entry - sl)
    if risk <= 0:
        return None
    tp1 = entry + risk     if bias == "long" else entry - risk
    tp2 = entry + risk * 2 if bias == "long" else entry - risk * 2
    tp3 = entry + risk * 3 if bias == "long" else entry - risk * 3

    rng_bo = breakout_range
    break_strength = ((float(last["close"]) - up0) / rng_bo) if bias == "long" else ((lo0 - float(last["close"])) / rng_bo)

    breakdown = {
        "h4Trend": 22 if adx_v >= 30 else 18 if adx_v >= 25 else 14,
        "h1Sweep": 20 if breakout_body >= 0.80 else 16 if breakout_body >= 0.70 else 12,
        "m15Fvg":  14 if gator_spread >= 1.4 else 11 if gator_spread >= 1.1 else 8,
        "m15Bos":  12 if break_strength > 0.25 else 9 if break_strength > 0.1 else 6,
        "killzone": 12,
        "atr":     10 if (0.8 <= atr_ratio <= 1.5) else 7,
        "h1Alignment": 10 if (ema_slope > 0.001 or ema_slope < -0.001) else 6,
    }
    breakdown["total"] = sum(v for k, v in breakdown.items() if k != "total")
    if breakdown["total"] < min_score:
        return None
    return {"bias": bias, "score": breakdown["total"], "scoreBreakdown": breakdown,
            "entry": _round(entry), "stopLoss": _round(sl),
            "tp1": _round(tp1), "tp2": _round(tp2), "tp3": _round(tp3),
            "management": {"breakEvenAtR": 0.7, "timeStopBars": 10}}


def _awesome_osc(median: np.ndarray, fast: int = 5, slow: int = 34) -> np.ndarray:
    n = len(median)
    out = np.full(n, np.nan, dtype=float)
    if n < slow: return out
    csum = np.cumsum(np.insert(median, 0, 0.0))
    def sma(k, i):
        return (csum[i + 1] - csum[i + 1 - k]) / k
    for i in range(slow - 1, n):
        out[i] = sma(fast, i) - sma(slow, i)
    return out


def _adx_last(high: np.ndarray, low: np.ndarray, close: np.ndarray, n: int = 14) -> float:
    L = len(close)
    if L < n * 2 + 1: return float("nan")
    tr = np.zeros(L - 1); pdm = np.zeros(L - 1); mdm = np.zeros(L - 1)
    for i in range(1, L):
        up = high[i] - high[i - 1]
        dn = low[i - 1] - low[i]
        pdm[i - 1] = up if (up > dn and up > 0) else 0.0
        mdm[i - 1] = dn if (dn > up and dn > 0) else 0.0
        tr[i - 1] = max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1]))
    def wilder(a: np.ndarray) -> np.ndarray:
        out = np.full(len(a), np.nan)
        s = float(a[:n].sum())
        out[n - 1] = s
        for i in range(n, len(a)):
            out[i] = out[i - 1] - out[i - 1] / n + a[i]
        return out
    trS = wilder(tr); pS = wilder(pdm); mS = wilder(mdm)
    dx = np.full(len(trS), np.nan)
    for i in range(len(trS)):
        if not np.isfinite(trS[i]) or trS[i] == 0: continue
        pdi = 100.0 * pS[i] / trS[i]; mdi = 100.0 * mS[i] / trS[i]
        denom = pdi + mdi
        dx[i] = 0.0 if denom == 0 else 100.0 * abs(pdi - mdi) / denom
    valid = np.where(np.isfinite(dx))[0]
    if len(valid) < n: return float("nan")
    start = int(valid[0])
    adx = float(dx[start:start + n].mean())
    for i in range(start + n, len(dx)):
        if not np.isfinite(dx[i]): continue
        adx = (adx * (n - 1) + dx[i]) / n
    return adx


# ---------------------------------------------------------------------------
# Registry de estrategias
# ---------------------------------------------------------------------------

@dataclass
class StrategyEngine:
    key: str
    name: str
    trigger_tf: str
    required_tfs: tuple[str, ...]
    evaluate: Callable[[Bars, dict], dict | None]
    default_params: dict


STRATEGIES: dict[str, StrategyEngine] = {
    "smc_london": StrategyEngine(
        "smc_london", "SMC Londres", "M15",
        ("H4", "H1", "M15"), evaluate_smc_london, {"min_score": 70}),
    "alligator_bb": StrategyEngine(
        "alligator_bb", "Alligator + BB v4 (M15)", "M15",
        ("H4", "H1", "M15"), evaluate_alligator_bb, {"min_score": 70}),
    "fibo_scalping": StrategyEngine(
        "fibo_scalping", "Fibo Scalping M5", "M5",
        ("H4", "H1", "M15", "M5"), evaluate_fibo_scalping, {"min_score": 65}),
    "gold_scalping": StrategyEngine(
        "gold_scalping", "VWAP Reversion M1", "M1",
        ("M1", "M5"), evaluate_gold_scalping, {"min_score": 65}),
    "ema_cross_m1": StrategyEngine(
        "ema_cross_m1", "EMA Cross M1", "M1",
        ("M1", "M5"), evaluate_ema_cross_m1, {"min_score": 70}),
    "straddle_breakout": StrategyEngine(
        "straddle_breakout", "Straddle Breakout M1", "M1",
        ("M1", "M5"), evaluate_straddle_breakout, {"min_score": 65}),
}


# ---------------------------------------------------------------------------
# Motor de backtest (paridad con backtest.ts::runBacktestBars)
# ---------------------------------------------------------------------------

@dataclass
class BacktestCosts:
    spread_usd: float = 0.0
    slippage_usd: float = 0.0
    commission_usd: float = 0.0
    latency_bars: int = 0


@dataclass
class Trade:
    open_time: int
    close_time: int
    bias: str
    score: float
    entry: float
    stop_loss: float
    tp1: float
    tp2: float
    tp3: float
    exit: float
    r_multiple: float
    outcome: str
    hour_utc: int
    weekday: int
    features: list[float] = field(default_factory=list)


def compute_metrics(trades: list[Trade]) -> dict:
    n = len(trades)
    if n == 0:
        return {"trades": 0, "wins": 0, "losses": 0, "winrate": 0.0,
                "total_r": 0.0, "avg_r": 0.0, "expectancy": 0.0,
                "profit_factor": 0.0, "max_drawdown_r": 0.0, "sharpe": 0.0}
    rs = np.array([t.r_multiple for t in trades])
    wins = int(np.sum(rs > 0.05)); losses = int(np.sum(rs < -0.05))
    total_r = float(rs.sum()); avg_r = float(rs.mean())
    pos = rs[rs > 0].sum(); neg = -rs[rs < 0].sum()
    equity = np.cumsum(rs)
    peak = np.maximum.accumulate(np.concatenate(([0.0], equity)))
    dd = float((peak - np.concatenate(([0.0], equity))).max())
    std = rs.std()
    sharpe = float((avg_r / std) * math.sqrt(n)) if std > 0 else 0.0
    return {
        "trades": n, "wins": wins, "losses": losses,
        "winrate": wins / n, "total_r": total_r, "avg_r": avg_r,
        "expectancy": avg_r,
        "profit_factor": float(pos / neg) if neg > 0 else float("inf") if pos > 0 else 0.0,
        "max_drawdown_r": dd, "sharpe": sharpe,
    }


def run_backtest_bars(
    bars: Bars, engine_key: str, params: dict | None = None,
    warmup_bars: int | None = None, max_hold_bars: int | None = None,
    cooldown_bars: int | None = None, auto_time_filters: bool = True,
    costs: BacktestCosts | None = None,
    progress: Callable[[float, int], None] | None = None,
) -> dict:
    strat = STRATEGIES[engine_key]
    p = {**strat.default_params, **(params or {})}
    trigger_tf = strat.trigger_tf
    trig = bars.get(trigger_tf)
    if trig is None or trig.empty:
        return {"engine_key": engine_key, "metrics": compute_metrics([]), "trades": []}
    tf_min = TF_MINUTES[trigger_tf]
    default_max_hold = max(20, round(24 * 60 / tf_min))
    default_cooldown = max(3, round(4 * 60 / tf_min))
    warmup = warmup_bars if warmup_bars is not None else (300 if trigger_tf == "M1" else 100)
    max_hold = max_hold_bars if max_hold_bars is not None else default_max_hold
    cooldown = cooldown_bars if cooldown_bars is not None else default_cooldown

    # Defaults costos por TF (paridad TS)
    if costs is None:
        if trigger_tf == "M1":
            costs = BacktestCosts(0.20, 0.05, 0.0, 1)
        else:
            costs = BacktestCosts(0.20, 0.05, 0.0, 0) if trigger_tf == "M5" else BacktestCosts()
    cost_per_side = costs.spread_usd / 2 + costs.slippage_usd + costs.commission_usd

    aux_tfs = [tf for tf in strat.required_tfs if tf != trigger_tf]
    trades: list[Trade] = []
    last_exit_idx = -10**9
    trig_time = trig["time"].values
    total = len(trig)
    progress_step = max(2000, total // 40)
    last_report = warmup

    i = warmup
    while i < total - 2:
        if progress and i - last_report >= progress_step:
            last_report = i
            progress(i / total, len(trades))
        if i - last_exit_idx < cooldown:
            i += 1
            continue
        bar_time = int(trig_time[i])
        if auto_time_filters and is_market_closed_or_risky(bar_time):
            i += 1
            continue
        sliced: Bars = {trigger_tf: trig.iloc[: i + 1]}
        for tf in aux_tfs:
            src = bars.get(tf)
            if src is not None and not src.empty:
                sliced[tf] = _bars_slice_up_to(src, bar_time)
        sig = strat.evaluate(sliced, p)
        if not sig:
            i += 1
            continue
        entry_idx = i + 1 + costs.latency_bars
        if entry_idx >= total - 1:
            i += 1
            continue
        entry_bar = trig.iloc[entry_idx]
        entry = float(entry_bar["open"])
        dist = abs(sig["entry"] - sig["stopLoss"])
        bias = sig["bias"]
        sl = entry - dist if bias == "long" else entry + dist
        tp1 = entry + dist if bias == "long" else entry - dist
        tp2 = entry + dist * 2 if bias == "long" else entry - dist * 2
        tp3 = entry + dist * 3 if bias == "long" else entry - dist * 3
        sim = simulate_trade(
            trig, entry_idx, bias, entry, sl, tp1, tp2, tp3, max_hold, cost_per_side,
            management=sig.get("management"),
        )
        de = datetime.fromtimestamp(int(entry_bar["time"]), tz=timezone.utc)
        hour_utc = de.hour
        weekday = (de.weekday() + 1) % 7
        feats = build_features(sig["scoreBreakdown"], bias, hour_utc, weekday)
        trades.append(Trade(
            int(entry_bar["time"]), sim.close_time, bias, sig["score"],
            entry, sl, tp1, tp2, tp3, sim.exit, sim.r_multiple, sim.outcome,
            hour_utc, weekday, feats,
        ))
        exit_idx_arr = np.searchsorted(trig_time, sim.close_time, side="left")
        last_exit_idx = int(exit_idx_arr) if exit_idx_arr < total else i + max_hold
        i = last_exit_idx + 1

    return {
        "engine_key": engine_key,
        "params": p,
        "metrics": compute_metrics(trades),
        "trades": trades,
    }


# ---------------------------------------------------------------------------
# Optimizador (grid + walk-forward, paraleliza con joblib si está)
# ---------------------------------------------------------------------------

def _score(metrics: dict, min_trades: int = 10) -> float:
    """Función objetivo: expectancy × sqrt(n), penaliza pocos trades."""
    n = metrics["trades"]
    if n < min_trades:
        return -1e9
    exp = metrics["avg_r"]
    return exp * math.sqrt(n)


def grid_search(
    bars: Bars, engine_key: str, grid: dict[str, list],
    min_trades: int = 10, n_jobs: int = 1,
) -> pd.DataFrame:
    keys = list(grid.keys())
    combos = list(product(*[grid[k] for k in keys]))

    def _run(vals):
        params = dict(zip(keys, vals))
        res = run_backtest_bars(bars, engine_key, params)
        m = res["metrics"]
        return {**params, **m, "score": _score(m, min_trades)}

    if n_jobs != 1:
        try:
            from joblib import Parallel, delayed
            rows = Parallel(n_jobs=n_jobs, backend="loky")(delayed(_run)(v) for v in combos)
        except ImportError:
            rows = [_run(v) for v in combos]
    else:
        rows = [_run(v) for v in combos]
    df = pd.DataFrame(rows).sort_values("score", ascending=False).reset_index(drop=True)
    return df


def _slice_bars_by_time(bars: Bars, t0: int, t1: int) -> Bars:
    out: Bars = {}
    for tf, df in bars.items():
        mask = (df["time"] >= t0) & (df["time"] <= t1)
        out[tf] = df.loc[mask].reset_index(drop=True)
    return out


def walk_forward(
    bars: Bars, engine_key: str, grid: dict[str, list],
    train_months: int = 3, test_months: int = 1, min_trades: int = 10,
    n_jobs: int = 1,
) -> pd.DataFrame:
    """Walk-forward rolling: optimiza en `train_months` y evalúa OOS en
    `test_months`. Devuelve un DataFrame con las métricas OOS por ventana."""
    trigger = STRATEGIES[engine_key].trigger_tf
    trig = bars[trigger]
    t_min = int(trig["time"].min())
    t_max = int(trig["time"].max())
    month = 30 * 24 * 3600
    windows = []
    start = t_min
    while start + (train_months + test_months) * month <= t_max:
        train_end = start + train_months * month
        test_end = train_end + test_months * month
        windows.append((start, train_end, test_end))
        start = train_end  # rolling sin solape en test
    rows = []
    for (t0, t1, t2) in windows:
        train_bars = _slice_bars_by_time(bars, t0, t1)
        test_bars = _slice_bars_by_time(bars, t1, t2)
        train_df = grid_search(train_bars, engine_key, grid, min_trades, n_jobs)
        if train_df.empty:
            continue
        best = train_df.iloc[0]
        best_params = {k: best[k] for k in grid.keys()}
        oos = run_backtest_bars(test_bars, engine_key, best_params)
        m = oos["metrics"]
        rows.append({
            "train_from": datetime.fromtimestamp(t0, tz=timezone.utc).date().isoformat(),
            "train_to": datetime.fromtimestamp(t1, tz=timezone.utc).date().isoformat(),
            "test_to": datetime.fromtimestamp(t2, tz=timezone.utc).date().isoformat(),
            **best_params,
            "oos_trades": m["trades"], "oos_winrate": m["winrate"],
            "oos_total_r": m["total_r"], "oos_avg_r": m["avg_r"],
            "oos_pf": m["profit_factor"], "oos_dd": m["max_drawdown_r"],
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Export → JSON consumible por el dashboard/EA
# ---------------------------------------------------------------------------

def export_best_params(results: dict[str, dict], path: str) -> None:
    """Escribe un JSON con la forma:
        { "version": 1, "generated_at": ISO,
          "engines": { "<key>": {"params": {...}, "metrics": {...}} } }
    """
    payload = {
        "version": 1,
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "engines": {},
    }
    for key, res in results.items():
        payload["engines"][key] = {
            "params": res.get("params", {}),
            "metrics": {k: (None if isinstance(v, float) and (math.isinf(v) or math.isnan(v)) else v)
                        for k, v in res["metrics"].items()},
        }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)


# ---------------------------------------------------------------------------
# Helper: trades → DataFrame (features para ML)
# ---------------------------------------------------------------------------

def trades_to_df(trades: list[Trade]) -> pd.DataFrame:
    if not trades:
        return pd.DataFrame()
    rows = []
    for t in trades:
        row = {
            "open_time": t.open_time, "close_time": t.close_time,
            "bias": t.bias, "score": t.score, "entry": t.entry,
            "sl": t.stop_loss, "tp1": t.tp1, "tp2": t.tp2, "tp3": t.tp3,
            "exit": t.exit, "r": t.r_multiple, "outcome": t.outcome,
            "hour": t.hour_utc, "weekday": t.weekday,
        }
        for i, name in enumerate(FEATURE_NAMES):
            row[f"f_{name}"] = t.features[i] if i < len(t.features) else 0.0
        rows.append(row)
    return pd.DataFrame(rows)


__all__ = [
    "TF_MINUTES", "FEATURE_NAMES", "STRATEGIES", "BacktestCosts",
    "parse_xau_csv", "aggregate_candles", "load_bars", "slice_bars_last_months",
    "run_backtest_bars", "grid_search", "walk_forward",
    "export_best_params", "trades_to_df",
]