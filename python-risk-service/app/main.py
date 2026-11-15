"""FastAPI microservice for real-time parcel climate risk scoring and forecasting."""

import math
import os
from typing import Dict, List

import uvicorn
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:
    from app.forecasting import forecast_price_trajectories
except ImportError:  # pragma: no cover - when launched directly from app/
    from forecasting import forecast_price_trajectories

app = FastAPI(
    title="GeoValue 2.0 Climate Risk Service",
    version="1.1.0",
    description="Real-time geospatial climate risk scoring, valuation adjustment, and ARIMA-X forecasting microservice.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RiskPredictionRequest(BaseModel):
    """Input payload for parcel climate risk, valuation, and forecast prediction."""

    parcel_id: str = Field(..., min_length=1, max_length=64, description="Municipal parcel identifier")
    circle_rate: float = Field(
        ...,
        ge=0.0,
        allow_inf_nan=False,
        description="Benchmark government valuation rate for the parcel",
    )
    distance_to_hazard: float = Field(
        ...,
        ge=0.0,
        allow_inf_nan=False,
        description="Distance in meters to the nearest mapped climate hazard",
    )


class RiskPredictionResponse(BaseModel):
    """Predicted climate risk score, valuation, and 10-year scenario forecasts."""

    parcel_id: str
    risk_score: float = Field(..., ge=0.0, le=100.0)
    risk_adjusted_valuation: float = Field(..., ge=0.0)
    forecast_years: List[int]
    baseline_trajectory: List[float]
    infrastructure_trajectory: List[float]
    adverse_risk_trajectory: List[float]
    horizon_milestones: Dict[str, Dict[str, float]]


def _simulate_ensemble_risk_model(
    circle_rate: float,
    distance_to_hazard: float,
) -> tuple[float, float]:
    """
    Simulate an XGBoost/RandomForest ensemble for climate risk scoring.

    Combines continuous exponential spatial hazard decay, discrete tree-split
    buffer weights, and an exposure interaction term, then computes a non-linear
    climate risk valuation discount.
    """
    decay_signal = math.exp(-distance_to_hazard / 500.0)

    if distance_to_hazard <= 50.0:
        zone_leaf_weight = 22.0
    elif distance_to_hazard <= 150.0:
        zone_leaf_weight = 14.5
    elif distance_to_hazard <= 500.0:
        zone_leaf_weight = 8.0
    elif distance_to_hazard <= 1500.0:
        zone_leaf_weight = 3.5
    else:
        zone_leaf_weight = 0.5

    exposure_interaction = min(8.0, math.log1p(circle_rate) * 0.45 * decay_signal)

    raw_score = 70.0 * decay_signal + zone_leaf_weight + exposure_interaction
    risk_score = round(max(0.0, min(100.0, raw_score)), 2)

    penalty_ratio = ((risk_score / 100.0) ** 1.15) * 0.35
    risk_adjusted_valuation = round(max(0.0, circle_rate * (1.0 - penalty_ratio)), 2)

    return risk_score, risk_adjusted_valuation


@app.get("/health")
async def health_check() -> dict[str, str]:
    """Liveness probe for the Python FastAPI risk microservice."""
    return {"status": "ok", "service": "geovalue-python-risk-service"}


@app.post("/predict/risk", response_model=RiskPredictionResponse, status_code=status.HTTP_200_OK)
async def predict_risk(payload: RiskPredictionRequest) -> RiskPredictionResponse:
    """
    Predict parcel climate risk_score (0-100), risk_adjusted_valuation,
    and 10-year ARIMA-X trajectories across Baseline, Infrastructure-Accelerated,
    and Adverse-Risk scenarios.
    """
    try:
        risk_score, risk_adjusted_valuation = _simulate_ensemble_risk_model(
            circle_rate=payload.circle_rate,
            distance_to_hazard=payload.distance_to_hazard,
        )
        forecast = forecast_price_trajectories(
            base_valuation=risk_adjusted_valuation,
            risk_score=risk_score,
            circle_rate=payload.circle_rate,
            horizon_years=10,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid model input: {exc}",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Risk prediction engine error: {exc}",
        ) from exc

    scenarios = forecast["scenarios"]
    return RiskPredictionResponse(
        parcel_id=payload.parcel_id,
        risk_score=risk_score,
        risk_adjusted_valuation=risk_adjusted_valuation,
        forecast_years=forecast["years"],
        baseline_trajectory=scenarios["baseline"],
        infrastructure_trajectory=scenarios["infrastructure_accelerated"],
        adverse_risk_trajectory=scenarios["adverse_risk"],
        horizon_milestones=forecast["horizons"],
    )


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
