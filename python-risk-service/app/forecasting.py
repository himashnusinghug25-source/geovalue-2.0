"""ARIMA-X time-series forecasting module for GeoValue 2.0 Indian NCR parcel valuations (INR/Gaj)."""

from __future__ import annotations

import math
import warnings
from typing import Any

import numpy as np

try:
    from statsmodels.tsa.arima.model import ARIMA
except ImportError:  # pragma: no cover - optional runtime fallback
    ARIMA = None


def _build_historical_series(
    base_valuation: float,
    risk_score: float,
    lookback_years: int = 15,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Construct a synthetic historical ₹/Gaj valuation series ending at base_valuation
    along with a 2-column exogenous feature matrix [macro_index, hazard_pressure].
    """
    risk_norm = max(0.0, min(1.0, risk_score / 100.0))
    # Historical NCR corridor growth tempered by flood/environmental risk
    annual_growth = 0.064 - 0.022 * risk_norm

    t_hist = np.arange(-lookback_years + 1, 1, dtype=float)
    cycle = 1.0 + 0.009 * np.sin(t_hist * 0.85)
    cycle[-1] = 1.0

    history = base_valuation * ((1.0 + annual_growth) ** t_hist) * cycle
    history[-1] = base_valuation

    macro_index = np.arange(1, lookback_years + 1, dtype=float)
    hazard_pressure = np.full(lookback_years, risk_norm, dtype=float) + 0.01 * np.cos(t_hist)
    exog_hist = np.column_stack([macro_index, hazard_pressure])

    return history, exog_hist


def _fit_arimax_baseline(
    base_valuation: float,
    risk_score: float,
    horizon_years: int,
) -> np.ndarray:
    """
    Fit an ARIMA-X (1, 1, 1) model via statsmodels and forecast horizon_years ahead.
    Falls back to calibrated compounding growth if statsmodels is unavailable or
    numerical convergence fails on degenerate inputs.
    """
    risk_norm = max(0.0, min(1.0, risk_score / 100.0))
    history, exog_hist = _build_historical_series(base_valuation, risk_score)
    lookback = len(history)

    future_steps = np.arange(1, horizon_years + 1, dtype=float)
    exog_future = np.column_stack(
        [
            np.arange(lookback + 1, lookback + horizon_years + 1, dtype=float),
            np.full(horizon_years, risk_norm, dtype=float),
        ]
    )

    if ARIMA is not None:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                model = ARIMA(
                    endog=history,
                    exog=exog_hist,
                    order=(1, 1, 1),
                    enforce_stationarity=False,
                    enforce_invertibility=False,
                )
                fitted = model.fit()
                forecast_vals = np.asarray(
                    fitted.forecast(steps=horizon_years, exog=exog_future),
                    dtype=float,
                )
                if np.all(np.isfinite(forecast_vals)) and np.all(forecast_vals > 0):
                    anchor_rate = 0.058 - 0.018 * risk_norm
                    expected_y1 = base_valuation * (1.0 + anchor_rate)
                    shift_ratio = expected_y1 / forecast_vals[0]
                    blend = np.linspace(1.0, 0.35, horizon_years)
                    anchored = forecast_vals * (1.0 + (shift_ratio - 1.0) * blend)
                    return np.maximum(0.0, anchored)
        except Exception:
            pass

    baseline_cagr = 0.058 - 0.018 * risk_norm
    return base_valuation * ((1.0 + baseline_cagr) ** future_steps)


def forecast_price_trajectories(
    base_valuation: float,
    risk_score: float,
    circle_rate: float | None = None,
    horizon_years: int = 10,
    policy_uplift_bonus: float = 0.0,
) -> dict[str, Any]:
    """
    Forecast 3-year, 5-year, and 10-year INR/Gaj valuation trajectories across
    three Indian NCR scenarios using statsmodels ARIMA-X:
      - baseline: Conservative Baseline macro growth moderated by parcel risk.
      - infrastructure_accelerated: Policy & Metro/Jewar/RRTS catalyst uplift (+15% to +22%).
      - adverse_risk: Compounding flood/waterlogging & regulatory risk discounts.
    """
    if horizon_years < 10:
        horizon_years = 10
    if base_valuation < 0 or not math.isfinite(base_valuation):
        raise ValueError("base_valuation must be a finite non-negative number.")

    years = list(range(1, horizon_years + 1))

    if base_valuation == 0.0:
        zeros = [0.0] * horizon_years
        return {
            "years": years,
            "scenarios": {
                "baseline": zeros.copy(),
                "infrastructure_accelerated": zeros.copy(),
                "adverse_risk": zeros.copy(),
            },
            "horizons": {
                "3_year": {"baseline": 0.0, "infrastructure_accelerated": 0.0, "adverse_risk": 0.0},
                "5_year": {"baseline": 0.0, "infrastructure_accelerated": 0.0, "adverse_risk": 0.0},
                "10_year": {"baseline": 0.0, "infrastructure_accelerated": 0.0, "adverse_risk": 0.0},
            },
        }

    baseline_arr = _fit_arimax_baseline(
        base_valuation=base_valuation,
        risk_score=risk_score,
        horizon_years=horizon_years,
    )

    risk_norm = max(0.0, min(1.0, risk_score / 100.0))
    step_fractions = np.arange(1, horizon_years + 1, dtype=float) / float(horizon_years)

    # Policy-Accelerated: +15% to +22% uplift by Year 10 from MPD-2041, Jewar, DMRC/RRTS
    bounded_bonus = max(0.0, min(0.04, policy_uplift_bonus))
    terminal_uplift = 0.185 - 0.035 * risk_norm + bounded_bonus
    infra_uplift_curve = terminal_uplift * (step_fractions ** 0.75)
    infra_arr = baseline_arr * (1.0 + infra_uplift_curve)

    # Adverse-Risk: compounding monsoon flooding, NGT buffer & insurance discounts
    terminal_discount = 0.10 + 0.24 * (risk_norm ** 0.85)
    adverse_discount_curve = terminal_discount * (step_fractions ** 0.9)
    adverse_arr = baseline_arr * np.maximum(0.25, 1.0 - adverse_discount_curve)

    baseline_list = [round(float(v), 2) for v in baseline_arr]
    infra_list = [round(float(v), 2) for v in infra_arr]
    adverse_list = [round(float(v), 2) for v in adverse_arr]

    return {
        "years": years,
        "scenarios": {
            "baseline": baseline_list,
            "infrastructure_accelerated": infra_list,
            "adverse_risk": adverse_list,
        },
        "horizons": {
            "3_year": {
                "baseline": baseline_list[2],
                "infrastructure_accelerated": infra_list[2],
                "adverse_risk": adverse_list[2],
            },
            "5_year": {
                "baseline": baseline_list[4],
                "infrastructure_accelerated": infra_list[4],
                "adverse_risk": adverse_list[4],
            },
            "10_year": {
                "baseline": baseline_list[9],
                "infrastructure_accelerated": infra_list[9],
                "adverse_risk": adverse_list[9],
            },
        },
    }
