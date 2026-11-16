"""FastAPI microservice for real-time parcel climate risk scoring, forecasting, and AI chat."""

import math
import os
from typing import Dict, List, Optional

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
    version="1.2.0",
    description=(
        "Real-time geospatial climate risk scoring, valuation adjustment, "
        "ARIMA-X forecasting, and AI valuation assistant microservice."
    ),
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


class ParcelContext(BaseModel):
    """Selected parcel context passed by the frontend to ground AI valuation Q&A."""

    parcel_id: str = Field(..., min_length=1, max_length=64)
    circle_rate: float = Field(0.0, ge=0.0, allow_inf_nan=False)
    distance_to_hazard: float = Field(250.0, ge=0.0, allow_inf_nan=False)
    risk_score: Optional[float] = Field(None, ge=0.0, le=100.0)
    risk_adjusted_valuation: Optional[float] = Field(None, ge=0.0)
    baseline_trajectory: Optional[List[float]] = None
    infrastructure_trajectory: Optional[List[float]] = None
    adverse_risk_trajectory: Optional[List[float]] = None
    horizon_milestones: Optional[Dict[str, Dict[str, float]]] = None


class ChatMessage(BaseModel):
    """Single conversational history turn."""

    role: str = Field(..., pattern="^(user|assistant)$")
    content: str = Field(..., min_length=1, max_length=4000)


class ValuationChatRequest(BaseModel):
    """Request payload for the AI Valuation Chat Assistant."""

    message: str = Field(..., min_length=1, max_length=2000)
    parcel_context: Optional[ParcelContext] = None
    history: List[ChatMessage] = Field(default_factory=list)


class ValuationChatResponse(BaseModel):
    """Data-backed conversational response grounded in parcel ML metrics."""

    reply: str
    parcel_id: Optional[str] = None
    computed_metrics: Optional[Dict[str, float]] = None
    suggested_questions: List[str] = Field(default_factory=list)


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


def _classify_risk_tier(risk_score: float) -> str:
    if risk_score >= 75.0:
        return "Critical"
    if risk_score >= 50.0:
        return "High"
    if risk_score >= 25.0:
        return "Moderate"
    return "Low"


def _classify_buffer_zone(distance_to_hazard: float) -> str:
    if distance_to_hazard <= 50.0:
        return "Immediate Hazard Core (<= 50 m)"
    if distance_to_hazard <= 150.0:
        return "High-Exposure Buffer (51-150 m)"
    if distance_to_hazard <= 500.0:
        return "Moderate Proximity Zone (151-500 m)"
    if distance_to_hazard <= 1500.0:
        return "Outer Attenuation Zone (501-1,500 m)"
    return "Low-Exposure Peripheral Zone (> 1,500 m)"


def _generate_valuation_chat_reply(
    query: str,
    context: ParcelContext,
) -> ValuationChatResponse:
    """Build a quantitative, model-grounded conversational answer for the selected parcel."""
    model_risk, model_val = _simulate_ensemble_risk_model(
        circle_rate=context.circle_rate,
        distance_to_hazard=context.distance_to_hazard,
    )
    risk_score = context.risk_score if context.risk_score is not None else model_risk
    adj_val = (
        context.risk_adjusted_valuation
        if context.risk_adjusted_valuation is not None
        else model_val
    )

    if (
        context.baseline_trajectory
        and context.infrastructure_trajectory
        and context.adverse_risk_trajectory
        and len(context.baseline_trajectory) >= 10
    ):
        baseline_arr = context.baseline_trajectory
        infra_arr = context.infrastructure_trajectory
        adverse_arr = context.adverse_risk_trajectory
    else:
        forecast = forecast_price_trajectories(
            base_valuation=adj_val,
            risk_score=risk_score,
            circle_rate=context.circle_rate,
            horizon_years=10,
        )
        baseline_arr = forecast["scenarios"]["baseline"]
        infra_arr = forecast["scenarios"]["infrastructure_accelerated"]
        adverse_arr = forecast["scenarios"]["adverse_risk"]

    tier = _classify_risk_tier(risk_score)
    zone_desc = _classify_buffer_zone(context.distance_to_hazard)
    discount_pct = (
        round(((context.circle_rate - adj_val) / context.circle_rate) * 100.0, 2)
        if context.circle_rate > 0
        else 0.0
    )

    y3_base, y5_base, y10_base = baseline_arr[2], baseline_arr[4], baseline_arr[9]
    y3_infra, y5_infra, y10_infra = infra_arr[2], infra_arr[4], infra_arr[9]
    y3_adv, y5_adv, y10_adv = adverse_arr[2], adverse_arr[4], adverse_arr[9]

    infra_uplift_pct = (
        round(((y10_infra - y10_base) / y10_base) * 100.0, 2) if y10_base > 0 else 0.0
    )
    adverse_drop_pct = (
        round(((y10_base - y10_adv) / y10_base) * 100.0, 2) if y10_base > 0 else 0.0
    )

    # Sensitivity check: what happens if hazard mitigation doubles effective buffer distance
    mitigated_risk, mitigated_val = _simulate_ensemble_risk_model(
        circle_rate=context.circle_rate,
        distance_to_hazard=max(context.distance_to_hazard * 2.0, context.distance_to_hazard + 250.0),
    )

    q = query.lower()
    wants_forecast = any(
        kw in q for kw in ("forecast", "10", "5", "3", "year", "trajectory", "future", "infra", "adverse", "arima", "growth")
    )
    wants_risk = any(
        kw in q for kw in ("risk", "hazard", "distance", "why", "driver", "flood", "mitigat", "score")
    )
    wants_invest = any(
        kw in q for kw in ("invest", "buy", "hold", "recommend", "worth", "value", "valuation", "price", "circle")
    )

    sections: List[str] = []

    if wants_risk or (not wants_forecast and not wants_invest):
        sections.append(
            f"**Parcel {context.parcel_id} — Risk & Hazard Assessment ({tier} Tier)**\n"
            f"- **Risk Score**: {risk_score}/100\n"
            f"- **Hazard Distance**: {context.distance_to_hazard:.0f} m ({zone_desc})\n"
            f"- **Valuation Haircut**: -{discount_pct}% from base circle rate "
            f"(${context.circle_rate:,.2f} -> ${adj_val:,.2f})\n"
            f"- **Mitigation Sensitivity**: Expanding effective hazard protection (+250 m / 2x buffer) "
            f"would lower modeled risk to **{mitigated_risk}/100** and lift adjusted valuation to **${mitigated_val:,.2f}**."
        )

    if wants_forecast or not (wants_risk or wants_invest):
        sections.append(
            f"**ARIMA-X 3Y / 5Y / 10Y Price Trajectories**\n"
            f"- **Year 3**: Baseline `${y3_base:,.2f}` | Infra `${y3_infra:,.2f}` | Adverse `${y3_adv:,.2f}`\n"
            f"- **Year 5**: Baseline `${y5_base:,.2f}` | Infra `${y5_infra:,.2f}` | Adverse `${y5_adv:,.2f}`\n"
            f"- **Year 10**: Baseline `${y10_base:,.2f}` | Infra `${y10_infra:,.2f}` (+{infra_uplift_pct}%) | Adverse `${y10_adv:,.2f}` (-{adverse_drop_pct}%)"
        )

    if wants_invest:
        spread = y10_infra - y10_adv
        stance = (
            "Favorable for long-horizon accumulation if paired with flood/drainage resilience."
            if risk_score < 50.0
            else "Requires targeted climate-adaptation capex or insurance hedging before underwriting."
        )
        sections.append(
            f"**Valuation & Investment Outlook**\n"
            f"- **Current Risk-Adjusted Value**: `${adj_val:,.2f}` (-{discount_pct}% climate adjustment)\n"
            f"- **10-Year Scenario Spread**: `${spread:,.2f}` between Infrastructure-Accelerated "
            f"(`${y10_infra:,.2f}`) and Adverse-Risk (`${y10_adv:,.2f}`)\n"
            f"- **Underwriting Note**: {stance}"
        )

    if not sections:
        sections.append(
            f"**Parcel {context.parcel_id} Snapshot**: Risk score **{risk_score}/100** ({tier}), "
            f"risk-adjusted valuation **${adj_val:,.2f}**, and 10Y Baseline projection of **${y10_base:,.2f}** "
            f"(Infra: **${y10_infra:,.2f}**, Adverse: **${y10_adv:,.2f}**)."
        )

    return ValuationChatResponse(
        reply="\n\n".join(sections),
        parcel_id=context.parcel_id,
        computed_metrics={
            "risk_score": round(float(risk_score), 2),
            "risk_adjusted_valuation": round(float(adj_val), 2),
            "discount_percent": discount_pct,
            "year_10_baseline": round(float(y10_base), 2),
            "year_10_infrastructure": round(float(y10_infra), 2),
            "year_10_adverse_risk": round(float(y10_adv), 2),
        },
        suggested_questions=[
            "Why is the risk score at this level?",
            "Compare 10-year Infra vs Adverse Risk scenarios",
            "What is the investment outlook for this parcel?",
        ],
    )


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


@app.post("/chat/valuation", response_model=ValuationChatResponse, status_code=status.HTTP_200_OK)
async def valuation_chat(payload: ValuationChatRequest) -> ValuationChatResponse:
    """
    Answer conversational questions about the selected parcel using the ML risk
    model and ARIMA-X 10-year forecast context.
    """
    if payload.parcel_context is None:
        return ValuationChatResponse(
            reply=(
                "No municipal parcel is currently selected. Search for a city like **Delhi**, "
                "**Gurgaon**, or **Noida** in the top-left search bar and click any parcel polygon "
                "on the map to analyze its risk score, hazard proximity, and 10-year valuation forecast."
            ),
            parcel_id=None,
            computed_metrics=None,
            suggested_questions=[
                "How does GeoValue calculate climate risk?",
                "What do the 3 forecast scenarios mean?",
            ],
        )

    try:
        return _generate_valuation_chat_reply(
            query=payload.message,
            context=payload.parcel_context,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid chat parcel context: {exc}",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Valuation chat error: {exc}",
        ) from exc


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
