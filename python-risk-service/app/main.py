"""FastAPI microservice for Indian NCR AHP land valuation, ARIMA-X forecasting, and AI chat."""

import hashlib
import math
import os
from typing import Any, Dict, List, Optional

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:
    from app.forecasting import forecast_price_trajectories
except ImportError:  # pragma: no cover - when launched directly from app/
    from forecasting import forecast_price_trajectories

app = FastAPI(
    title="GeoValue 2.0 Indian Real Estate & Spatial Risk Service",
    version="2.0.0",
    description=(
        "Saaty AHP multi-criteria land valuation (INR/Gaj), ARIMA-X 10-year "
        "forecasting, comparable registry engine, and AI copilot microservice."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


AHP_CRITERIA_LABELS = [
    "Recent Comparable Registry Rate",
    "Metro / RRTS & Expressway Proximity",
    "Upcoming Govt Policy & Master Plan Catalyst",
    "Flood, Soil & Environmental Hazard Safety",
    "Social Infrastructure (Hospitals, Malls & Schools)",
    "Crime Rate & Neighborhood Safety Index",
]

# Saaty 1-9 Pairwise Comparison Matrix across the 6 spatial criteria
SAATY_PAIRWISE_MATRIX = np.array(
    [
        [1.0, 1.0, 2.0, 2.0, 3.0, 4.0],
        [1.0, 1.0, 1.0, 2.0, 2.0, 3.0],
        [1.0 / 2.0, 1.0, 1.0, 1.0, 2.0, 2.0],
        [1.0 / 2.0, 1.0 / 2.0, 1.0, 1.0, 1.0, 2.0],
        [1.0 / 3.0, 1.0 / 2.0, 1.0 / 2.0, 1.0, 1.0, 1.0],
        [1.0 / 4.0, 1.0 / 3.0, 1.0 / 2.0, 1.0 / 2.0, 1.0, 1.0],
    ],
    dtype=float,
)
SAATY_RI_N6 = 1.24  # Standard Saaty Random Index for n=6


def compute_ahp_matrix_and_weights() -> Dict[str, Any]:
    """
    Compute principal eigenvector weights, lambda_max, Consistency Index (CI),
    and Consistency Ratio (CR < 0.10) from the 6x6 Saaty Pairwise Matrix.
    """
    eigvals, eigvecs = np.linalg.eig(SAATY_PAIRWISE_MATRIX)
    max_idx = int(np.argmax(eigvals.real))
    lambda_max = float(eigvals[max_idx].real)

    principal_vec = np.abs(eigvecs[:, max_idx].real)
    normalized_weights = principal_vec / np.sum(principal_vec)

    n = len(AHP_CRITERIA_LABELS)
    ci = (lambda_max - n) / (n - 1)
    cr = ci / SAATY_RI_N6

    weights = [
        {
            "criterion": label,
            "weight_pct": round(float(w) * 100.0, 2),
            "weight": round(float(w), 4),
        }
        for label, w in zip(AHP_CRITERIA_LABELS, normalized_weights)
    ]

    return {
        "weights": weights,
        "lambda_max": round(lambda_max, 4),
        "consistency_index": round(ci, 4),
        "consistency_ratio": round(cr, 4),
        "is_consistent": cr < 0.10,
    }


AHP_MODEL_CACHE = compute_ahp_matrix_and_weights()


def _deterministic_unit(seed: str) -> float:
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return int(digest[:8], 16) / float(0xFFFFFFFF)


def _format_inr(amount: float) -> str:
    """Format an amount in Indian Rupees with standard lakh/crore comma grouping."""
    negative = amount < 0
    val = abs(round(amount))
    s = str(val)
    if len(s) <= 3:
        grouped = s
    else:
        last3 = s[-3:]
        rest = s[:-3]
        parts: List[str] = []
        while len(rest) > 2:
            parts.append(rest[-2:])
            rest = rest[:-2]
        if rest:
            parts.append(rest)
        grouped = ",".join(reversed(parts)) + "," + last3
    return f"-₹{grouped}" if negative else f"₹{grouped}"


def _format_inr_lakh_crore(amount: float) -> str:
    """Format INR totals into concise ₹ Lakhs or ₹ Crores."""
    abs_val = abs(amount)
    sign = "-" if amount < 0 else ""
    if abs_val >= 1e7:
        return f"{sign}₹{abs_val / 1e7:.2f} Cr"
    if abs_val >= 1e5:
        return f"{sign}₹{abs_val / 1e5:.2f} L"
    return _format_inr(amount)


def _resolve_ncr_zone_metadata(
    parcel_id: str,
    sub_region: Optional[str],
    longitude: Optional[float],
    latitude: Optional[float],
) -> Dict[str, Any]:
    """Map NCR sub-region to Circle Rate Authority, Sub-Registrar, and Govt Policies."""
    sr = (sub_region or "").lower()
    pid = parcel_id.lower()

    if "noida" in sr or "noida" in pid or (longitude is not None and longitude >= 77.30 and (latitude or 28.51) < 28.61):
        zone_name = sub_region or "Noida Sector 128 / Expressway"
        return {
            "zone_name": zone_name,
            "authority": "IGRS UP / NOIDA Authority",
            "sub_registrar": "Sub-Registrar III, Gautam Budh Nagar",
            "market_spread_base": 0.28,
            "policy_uplift_bonus": 0.032,
            "policies": [
                {
                    "name": "Noida Master Plan 2031 — Sector 128–150 Corridor",
                    "authority": "NOIDA / UP Town Planning",
                    "impact_horizon": "2026–2031",
                    "estimated_uplift": "+14% to +19%",
                    "summary": "Mixed-use FAR optimization along Noida–Greater Noida Expressway and green-belt drainage reinforcement.",
                },
                {
                    "name": "Noida International Airport (Jewar) & Film City",
                    "authority": "YEIDA / Govt. of Uttar Pradesh",
                    "impact_horizon": "2026–2030",
                    "estimated_uplift": "+16% to +22%",
                    "summary": "Expressway connectivity expansion driving institutional and commercial registry demand along Sector 128–Yamuna belt.",
                },
                {
                    "name": "NMRC Aqua Line Extension & FNG Link",
                    "authority": "NMRC / NHAI",
                    "impact_horizon": "2026–2029",
                    "estimated_uplift": "+9% to +13%",
                    "summary": "Transit-Oriented Development (TOD) density bonus within 800m of proposed expressway interchanges.",
                },
            ],
        }

    if "gurgaon" in sr or "gurugram" in sr or "ggn" in pid or (longitude is not None and longitude <= 77.15):
        return {
            "zone_name": sub_region or "Gurugram Cyber City / SPR",
            "authority": "Jamabandi Haryana / GMDA",
            "sub_registrar": "Tehsildar & Sub-Registrar, Badshahpur (Gurugram)",
            "market_spread_base": 0.34,
            "policy_uplift_bonus": 0.03,
            "policies": [
                {
                    "name": "GMDA Master Plan 2031 — TOD & New Sectors",
                    "authority": "Gurugram Metropolitan Development Authority",
                    "impact_horizon": "2026–2031",
                    "estimated_uplift": "+15% to +20%",
                    "summary": "High-density TOD zoning along Dwarka Expressway, SPR, and NH-48 commercial nodes.",
                },
                {
                    "name": "Gurugram Metro Loop (Millennium City to Cyber City)",
                    "authority": "HMRTC / Govt. of Haryana",
                    "impact_horizon": "2026–2030",
                    "estimated_uplift": "+12% to +17%",
                    "summary": "28.5 km elevated metro corridor improving last-mile connectivity and commercial lease yields.",
                },
                {
                    "name": "Delhi–SNB RapidX (Namo Bharat) RRTS Corridor",
                    "authority": "NCRTC",
                    "impact_horizon": "2027–2032",
                    "estimated_uplift": "+11% to +16%",
                    "summary": "High-speed regional rail integration connecting Aerocity, Udyog Vihar, and Manesar.",
                },
            ],
        }

    if "ghaziabad" in sr or "gzb" in pid or (longitude is not None and longitude >= 77.36 and (latitude or 28.65) >= 28.61):
        return {
            "zone_name": sub_region or "Ghaziabad Indirapuram / NH-9",
            "authority": "IGRS UP / GDA",
            "sub_registrar": "Sub-Registrar IV, Ghaziabad",
            "market_spread_base": 0.24,
            "policy_uplift_bonus": 0.026,
            "policies": [
                {
                    "name": "Delhi–Meerut RapidX (Namo Bharat) RRTS TOD Zones",
                    "authority": "NCRTC / GDA",
                    "impact_horizon": "2026–2029",
                    "estimated_uplift": "+14% to +18%",
                    "summary": "Operational RRTS stations at Sahibabad & Ghaziabad driving FAR 4.0 TOD redevelopment.",
                },
                {
                    "name": "GDA Unified Master Plan 2031 & Hindon Elevated Link",
                    "authority": "Ghaziabad Development Authority",
                    "impact_horizon": "2026–2031",
                    "estimated_uplift": "+10% to +15%",
                    "summary": "Logistics, NH-9 widening, and Hindon riverfront flood-embankment protection.",
                },
            ],
        }

    if "faridabad" in sr or "fbd" in pid or (latitude is not None and latitude < 28.47 and (longitude or 77.32) >= 77.22):
        return {
            "zone_name": sub_region or "Faridabad Smart City / Greater Faridabad",
            "authority": "Jamabandi Haryana / FMDA",
            "sub_registrar": "Sub-Registrar Central, Faridabad",
            "market_spread_base": 0.22,
            "policy_uplift_bonus": 0.028,
            "policies": [
                {
                    "name": "Faridabad–Noida–Ghaziabad (FNG) & Jewar Greenfield Spur",
                    "authority": "NHAI / FMDA",
                    "impact_horizon": "2026–2030",
                    "estimated_uplift": "+15% to +20%",
                    "summary": "Direct eastern Yamuna bridge and Ballabgarh–Jewar Airport expressway spur unlocking sector appreciation.",
                },
                {
                    "name": "Faridabad Master Plan 2031 Urban Extension",
                    "authority": "Town & Country Planning Haryana",
                    "impact_horizon": "2026–2031",
                    "estimated_uplift": "+11% to +15%",
                    "summary": "Industrial-to-residential mixed-use conversion along Delhi–Mathura NH-19 corridor.",
                },
            ],
        }

    return {
        "zone_name": sub_region or "New Delhi Central / MPD-2041 Zone",
        "authority": "DDA / Delhi Revenue (DORIS)",
        "sub_registrar": "Sub-Registrar VA, Mehrauli / Hauz Khas, New Delhi",
        "market_spread_base": 0.36,
        "policy_uplift_bonus": 0.03,
        "policies": [
            {
                "name": "Delhi Master Plan 2041 (MPD-2041) — TOD & Land Pooling",
                "authority": "Delhi Development Authority (DDA)",
                "impact_horizon": "2026–2041",
                "estimated_uplift": "+15% to +21%",
                "summary": "Unlocking vertical FAR along Metro hubs, green-blue infrastructure buffers, and urban regeneration zones.",
            },
            {
                "name": "DMRC Phase-IV & Phase-V Metro Corridors + UER-II",
                "authority": "DMRC / NHAI",
                "impact_horizon": "2026–2030",
                "estimated_uplift": "+12% to +17%",
                "summary": "Enhanced orbital expressway and metro interchange accessibility cutting cross-NCR travel times.",
            },
        ],
    }


class RiskPredictionRequest(BaseModel):
    """Input payload for Indian NCR AHP land valuation and forecast prediction."""

    parcel_id: str = Field(..., min_length=1, max_length=64, description="Municipal parcel identifier")
    circle_rate: float = Field(
        ...,
        ge=0.0,
        allow_inf_nan=False,
        description="Official Circle Rate (INR per Gaj / Sq. Yard)",
    )
    distance_to_hazard: float = Field(
        ...,
        ge=0.0,
        allow_inf_nan=False,
        description="Distance in meters to nearest flood/drainage hazard",
    )
    plot_area_gaj: Optional[float] = Field(None, gt=0.0, allow_inf_nan=False)
    sub_region: Optional[str] = None
    metro_distance_m: Optional[float] = Field(None, ge=0.0, allow_inf_nan=False)
    highway_distance_m: Optional[float] = Field(None, ge=0.0, allow_inf_nan=False)
    hospital_distance_m: Optional[float] = Field(None, ge=0.0, allow_inf_nan=False)
    mall_distance_m: Optional[float] = Field(None, ge=0.0, allow_inf_nan=False)
    police_distance_m: Optional[float] = Field(None, ge=0.0, allow_inf_nan=False)
    safety_score: Optional[float] = Field(None, ge=0.0, le=100.0, allow_inf_nan=False)
    longitude: Optional[float] = None
    latitude: Optional[float] = None


class RiskPredictionResponse(BaseModel):
    """Predicted risk score, INR/Gaj valuation, AHP ledger, comps, and 10Y ARIMA-X trajectories."""

    parcel_id: str
    risk_score: float = Field(..., ge=0.0, le=100.0)
    risk_adjusted_valuation: float = Field(..., ge=0.0, description="AI Market Valuation (INR/Gaj)")
    official_circle_rate_gaj: float = Field(..., ge=0.0)
    circle_to_market_spread_pct: float
    plot_area_gaj: float = Field(..., gt=0.0)
    plot_area_sqm: float = Field(..., gt=0.0)
    total_plot_valuation_inr: float = Field(..., ge=0.0)
    sub_region: str
    circle_rate_authority: str
    ahp_consistency_ratio: float
    ahp_lambda_max: float
    ahp_weights: List[Dict[str, Any]]
    explainable_breakdown: List[Dict[str, Any]]
    comparable_registries: List[Dict[str, Any]]
    policy_catalysts: List[Dict[str, Any]]
    spatial_distances_m: Dict[str, float]
    forecast_years: List[int]
    baseline_trajectory: List[float]
    infrastructure_trajectory: List[float]
    adverse_risk_trajectory: List[float]
    horizon_milestones: Dict[str, Dict[str, float]]


class ParcelContext(BaseModel):
    """Selected parcel context passed by frontend to ground AI valuation Q&A."""

    parcel_id: str = Field(..., min_length=1, max_length=64)
    circle_rate: float = Field(0.0, ge=0.0, allow_inf_nan=False)
    distance_to_hazard: float = Field(250.0, ge=0.0, allow_inf_nan=False)
    plot_area_gaj: Optional[float] = Field(None, gt=0.0, allow_inf_nan=False)
    sub_region: Optional[str] = None
    risk_score: Optional[float] = Field(None, ge=0.0, le=100.0)
    risk_adjusted_valuation: Optional[float] = Field(None, ge=0.0)
    total_plot_valuation_inr: Optional[float] = Field(None, ge=0.0)
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
    """Data-backed conversational response in INR/Gaj & Lakhs/Crores."""

    reply: str
    parcel_id: Optional[str] = None
    computed_metrics: Optional[Dict[str, float]] = None
    suggested_questions: List[str] = Field(default_factory=list)


def _simulate_ensemble_risk_model(
    circle_rate: float,
    distance_to_hazard: float,
) -> tuple[float, float]:
    """
    Simulate an XGBoost/RandomForest ensemble for climate hazard risk scoring (0-100)
    and baseline risk-discounted rate.
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
    risk_discounted_rate = round(max(0.0, circle_rate * (1.0 - penalty_ratio)), 2)

    return risk_score, risk_discounted_rate


def _build_indian_valuation_bundle(
    payload: RiskPredictionRequest,
) -> Dict[str, Any]:
    """Compute full AHP-weighted INR/Gaj valuation, explainable ledger, comps, and policies."""
    pid = payload.parcel_id
    # Normalize official circle rate into realistic NCR INR/Gaj
    official_circle_rate_gaj = round(float(payload.circle_rate), 2)

    risk_score, _ = _simulate_ensemble_risk_model(
        circle_rate=official_circle_rate_gaj,
        distance_to_hazard=payload.distance_to_hazard,
    )

    zone_meta = _resolve_ncr_zone_metadata(
        parcel_id=pid,
        sub_region=payload.sub_region,
        longitude=payload.longitude,
        latitude=payload.latitude,
    )

    u_area = _deterministic_unit(f"{pid}:area")
    u_metro = _deterministic_unit(f"{pid}:metro")
    u_hwy = _deterministic_unit(f"{pid}:hwy")
    u_hosp = _deterministic_unit(f"{pid}:hosp")
    u_mall = _deterministic_unit(f"{pid}:mall")
    u_pol = _deterministic_unit(f"{pid}:pol")
    u_saf = _deterministic_unit(f"{pid}:saf")

    plot_area_gaj = round(
        float(payload.plot_area_gaj) if payload.plot_area_gaj else (160.0 + u_area * 290.0),
        1,
    )
    plot_area_sqm = round(plot_area_gaj * 0.836127, 2)

    metro_dist = round(
        float(payload.metro_distance_m)
        if payload.metro_distance_m is not None
        else (380.0 + u_metro * 2200.0),
        0,
    )
    highway_dist = round(
        float(payload.highway_distance_m)
        if payload.highway_distance_m is not None
        else (220.0 + u_hwy * 1900.0),
        0,
    )
    hospital_dist = round(
        float(payload.hospital_distance_m)
        if payload.hospital_distance_m is not None
        else (550.0 + u_hosp * 2600.0),
        0,
    )
    mall_dist = round(
        float(payload.mall_distance_m)
        if payload.mall_distance_m is not None
        else (650.0 + u_mall * 3100.0),
        0,
    )
    police_dist = round(
        float(payload.police_distance_m)
        if payload.police_distance_m is not None
        else (450.0 + u_pol * 1800.0),
        0,
    )
    safety_score = round(
        float(payload.safety_score)
        if payload.safety_score is not None
        else (58.0 + u_saf * 34.0),
        1,
    )

    weights = AHP_MODEL_CACHE["weights"]

    # 1. Market Registry Spread (+18% to +38% above official Govt circle rate)
    comp_adj_gaj = round(
        official_circle_rate_gaj * (zone_meta["market_spread_base"] + (u_area - 0.5) * 0.06),
        2,
    )
    # 2. Metro / RRTS & Expressway Proximity bonus
    transit_factor = max(0.04, 0.16 * math.exp(-metro_dist / 1400.0) + 0.06 * math.exp(-highway_dist / 1200.0))
    transit_adj_gaj = round(official_circle_rate_gaj * transit_factor, 2)
    # 3. Upcoming Govt Policy & Master Plan Catalyst
    policy_adj_gaj = round(official_circle_rate_gaj * (0.06 + zone_meta["policy_uplift_bonus"] * 2.2), 2)
    # 4. Flood, Soil & Environmental Hazard deduction
    flood_deduct_pct = ((risk_score / 100.0) ** 1.1) * 0.24
    flood_adj_gaj = -round(official_circle_rate_gaj * flood_deduct_pct, 2)
    # 5. Social Infrastructure (Hospitals, Malls & Schools)
    social_factor = 0.065 * math.exp(-min(hospital_dist, mall_dist) / 1800.0)
    social_adj_gaj = round(official_circle_rate_gaj * social_factor, 2)
    # 6. Crime Rate & Neighborhood Safety Index (+/-)
    safety_delta = ((safety_score - 68.0) / 100.0) * 0.11
    safety_adj_gaj = round(official_circle_rate_gaj * safety_delta, 2)

    explainable_breakdown = [
        {
            "criterion": weights[0]["criterion"],
            "ahp_weight_pct": weights[0]["weight_pct"],
            "adjustment_per_gaj": comp_adj_gaj,
            "signal": "Market Registry Premium over Circle Rate",
        },
        {
            "criterion": weights[1]["criterion"],
            "ahp_weight_pct": weights[1]["weight_pct"],
            "adjustment_per_gaj": transit_adj_gaj,
            "signal": f"Metro {int(metro_dist)}m | Expressway {int(highway_dist)}m",
        },
        {
            "criterion": weights[2]["criterion"],
            "ahp_weight_pct": weights[2]["weight_pct"],
            "adjustment_per_gaj": policy_adj_gaj,
            "signal": zone_meta["policies"][0]["name"],
        },
        {
            "criterion": weights[3]["criterion"],
            "ahp_weight_pct": weights[3]["weight_pct"],
            "adjustment_per_gaj": flood_adj_gaj,
            "signal": f"Hazard Buffer {int(payload.distance_to_hazard)}m (Risk {risk_score}/100)",
        },
        {
            "criterion": weights[4]["criterion"],
            "ahp_weight_pct": weights[4]["weight_pct"],
            "adjustment_per_gaj": social_adj_gaj,
            "signal": f"Hospital {int(hospital_dist)}m | Mall {int(mall_dist)}m",
        },
        {
            "criterion": weights[5]["criterion"],
            "ahp_weight_pct": weights[5]["weight_pct"],
            "adjustment_per_gaj": safety_adj_gaj,
            "signal": f"Safety Index {safety_score}/100 | Police {int(police_dist)}m",
        },
    ]

    net_adjustment = sum(item["adjustment_per_gaj"] for item in explainable_breakdown)
    market_rate_gaj = max(0.0, round(official_circle_rate_gaj + net_adjustment, 2))
    spread_pct = (
        round(((market_rate_gaj - official_circle_rate_gaj) / official_circle_rate_gaj) * 100.0, 2)
        if official_circle_rate_gaj > 0
        else 0.0
    )
    total_plot_valuation_inr = round(market_rate_gaj * plot_area_gaj, 2)

    # Generate 5 deterministic Recent Comparable Plot Transactions ("Aas-Paas Ki Registry")
    quarters = ["Q2 2025", "Q3 2025", "Q4 2025", "Q1 2026", "Q2 2026"]
    comparable_registries: List[Dict[str, Any]] = []
    for idx, qtr in enumerate(quarters):
        u_c = _deterministic_unit(f"{pid}:comp:{idx}")
        u_c2 = _deterministic_unit(f"{pid}:comp2:{idx}")
        dist_m = int(145 + idx * 195 + u_c * 140)
        comp_area_gaj = round(125.0 + u_c2 * 260.0, 0)
        rate_mult = 0.93 + u_c * 0.14
        comp_rate_gaj = round(market_rate_gaj * rate_mult, 0)
        deed_num = 1042 + int(u_c * 7900) + idx * 137
        comparable_registries.append(
            {
                "deed_id": f"REG-{qtr[-4:]}-{deed_num}",
                "distance_m": dist_m,
                "plot_area_gaj": comp_area_gaj,
                "quarter": qtr,
                "rate_per_gaj": comp_rate_gaj,
                "total_value_inr": round(comp_rate_gaj * comp_area_gaj, 2),
                "sub_registrar": zone_meta["sub_registrar"],
            }
        )

    forecast = forecast_price_trajectories(
        base_valuation=market_rate_gaj,
        risk_score=risk_score,
        circle_rate=official_circle_rate_gaj,
        horizon_years=10,
        policy_uplift_bonus=zone_meta["policy_uplift_bonus"],
    )

    return {
        "risk_score": risk_score,
        "market_rate_gaj": market_rate_gaj,
        "official_circle_rate_gaj": official_circle_rate_gaj,
        "spread_pct": spread_pct,
        "plot_area_gaj": plot_area_gaj,
        "plot_area_sqm": plot_area_sqm,
        "total_plot_valuation_inr": total_plot_valuation_inr,
        "zone_meta": zone_meta,
        "explainable_breakdown": explainable_breakdown,
        "comparable_registries": comparable_registries,
        "spatial_distances_m": {
            "hazard_buffer_m": round(float(payload.distance_to_hazard), 1),
            "metro_rrts_m": metro_dist,
            "expressway_highway_m": highway_dist,
            "hospital_m": hospital_dist,
            "mall_retail_m": mall_dist,
            "police_station_m": police_dist,
            "safety_index": safety_score,
        },
        "forecast": forecast,
    }


def _classify_risk_tier(risk_score: float) -> str:
    if risk_score >= 75.0:
        return "Critical"
    if risk_score >= 50.0:
        return "High"
    if risk_score >= 25.0:
        return "Moderate"
    return "Low"


def _generate_valuation_chat_reply(
    query: str,
    context: ParcelContext,
) -> ValuationChatResponse:
    """Build an INR/Gaj, AHP-weighted, policy-grounded response for the selected parcel."""
    bundle = _build_indian_valuation_bundle(
        RiskPredictionRequest(
            parcel_id=context.parcel_id,
            circle_rate=context.circle_rate,
            distance_to_hazard=context.distance_to_hazard,
            plot_area_gaj=context.plot_area_gaj,
            sub_region=context.sub_region,
        )
    )

    risk_score = context.risk_score if context.risk_score is not None else bundle["risk_score"]
    market_rate_gaj = (
        context.risk_adjusted_valuation
        if context.risk_adjusted_valuation is not None
        else bundle["market_rate_gaj"]
    )
    plot_area_gaj = bundle["plot_area_gaj"]
    total_plot_val = (
        context.total_plot_valuation_inr
        if context.total_plot_valuation_inr is not None
        else round(market_rate_gaj * plot_area_gaj, 2)
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
        scenarios = bundle["forecast"]["scenarios"]
        baseline_arr = scenarios["baseline"]
        infra_arr = scenarios["infrastructure_accelerated"]
        adverse_arr = scenarios["adverse_risk"]

    tier = _classify_risk_tier(risk_score)
    y3_base, y5_base, y10_base = baseline_arr[2], baseline_arr[4], baseline_arr[9]
    y3_infra, y5_infra, y10_infra = infra_arr[2], infra_arr[4], infra_arr[9]
    y3_adv, y5_adv, y10_adv = adverse_arr[2], adverse_arr[4], adverse_arr[9]

    infra_uplift_pct = (
        round(((y10_infra - y10_base) / y10_base) * 100.0, 2) if y10_base > 0 else 0.0
    )
    adverse_drop_pct = (
        round(((y10_base - y10_adv) / y10_base) * 100.0, 2) if y10_base > 0 else 0.0
    )

    top_policy = bundle["zone_meta"]["policies"][0]
    latest_comp = bundle["comparable_registries"][-1]
    breakdown_lines = "\n".join(
        f"- **{item['criterion']} ({item['ahp_weight_pct']}%)**: "
        f"{'+' if item['adjustment_per_gaj'] >= 0 else ''}{_format_inr(item['adjustment_per_gaj'])}/Gaj "
        f"({item['signal']})"
        for item in bundle["explainable_breakdown"]
    )

    q = query.lower()
    wants_ahp = any(kw in q for kw in ("ahp", "why", "price", "break", "weight", "gaj", "circle", "comp", "registry"))
    wants_forecast = any(kw in q for kw in ("forecast", "10", "5", "3", "year", "policy", "jewar", "mpd", "metro", "rrts", "infra", "adverse"))
    wants_risk = any(kw in q for kw in ("risk", "flood", "hazard", "distance", "safety", "crime"))

    sections: List[str] = []

    if wants_ahp or not (wants_forecast or wants_risk):
        sections.append(
            f"**Parcel {context.parcel_id} — Indian Valuation & AHP Breakdown (CR = {AHP_MODEL_CACHE['consistency_ratio']} < 0.10)**\n"
            f"- **Official Circle Rate ({bundle['zone_meta']['authority']})**: {_format_inr(bundle['official_circle_rate_gaj'])}/Gaj\n"
            f"- **AI Fair Market Rate**: **{_format_inr(market_rate_gaj)}/Gaj** (+{bundle['spread_pct']}% Circle-to-Market Spread)\n"
            f"- **Plot Area & Total Valuation**: {plot_area_gaj:.0f} Gaj ({bundle['plot_area_sqm']} Sq.m) → **{_format_inr_lakh_crore(total_plot_val)}**\n"
            f"- **Latest Nearby Registry ({latest_comp['deed_id']}, {latest_comp['distance_m']}m away)**: "
            f"{_format_inr(latest_comp['rate_per_gaj'])}/Gaj ({latest_comp['quarter']})\n\n"
            f"**Explainable AHP Rate Adjustments:**\n{breakdown_lines}"
        )

    if wants_risk:
        sections.append(
            f"**Hazard & Neighborhood Risk Telemetry ({tier} Risk — {risk_score}/100)**\n"
            f"- **Flood / Drainage Buffer**: {int(context.distance_to_hazard)} m from primary hazard corridor\n"
            f"- **Metro / Expressway Access**: Metro {int(bundle['spatial_distances_m']['metro_rrts_m'])} m | Expressway {int(bundle['spatial_distances_m']['expressway_highway_m'])} m\n"
            f"- **Safety & Social Infra**: Safety Index {bundle['spatial_distances_m']['safety_index']}/100 | Hospital {int(bundle['spatial_distances_m']['hospital_m'])} m"
        )

    if wants_forecast or not (wants_ahp or wants_risk):
        sections.append(
            f"**3Y / 5Y / 10Y ARIMA-X Price Forecast & Policy Catalyst**\n"
            f"- **Primary Catalyst**: {top_policy['name']} ({top_policy['estimated_uplift']} projected uplift)\n"
            f"- **Year 3**: Base `{_format_inr(y3_base)}/Gaj` | Policy-Accelerated `{_format_inr(y3_infra)}/Gaj` | Adverse `{_format_inr(y3_adv)}/Gaj`\n"
            f"- **Year 5**: Base `{_format_inr(y5_base)}/Gaj` | Policy-Accelerated `{_format_inr(y5_infra)}/Gaj` | Adverse `{_format_inr(y5_adv)}/Gaj`\n"
            f"- **Year 10**: Base `{_format_inr(y10_base)}/Gaj` | Policy-Accelerated `{_format_inr(y10_infra)}/Gaj` (+{infra_uplift_pct}%, Total **{_format_inr_lakh_crore(y10_infra * plot_area_gaj)}**) | Adverse `{_format_inr(y10_adv)}/Gaj` (-{adverse_drop_pct}%)"
        )

    return ValuationChatResponse(
        reply="\n\n".join(sections),
        parcel_id=context.parcel_id,
        computed_metrics={
            "risk_score": round(float(risk_score), 2),
            "risk_adjusted_valuation": round(float(market_rate_gaj), 2),
            "total_plot_valuation_inr": round(float(total_plot_val), 2),
            "ahp_consistency_ratio": AHP_MODEL_CACHE["consistency_ratio"],
            "year_10_baseline": round(float(y10_base), 2),
            "year_10_infrastructure": round(float(y10_infra), 2),
            "year_10_adverse_risk": round(float(y10_adv), 2),
        },
        suggested_questions=[
            "Explain the AHP weights & ₹/Gaj breakdown",
            "How do nearby registry sales compare?",
            "Show 10-year Policy Catalyst vs Adverse Risk forecast",
        ],
    )


@app.get("/health")
async def health_check() -> dict[str, str]:
    """Liveness probe for the Python FastAPI risk microservice."""
    return {"status": "ok", "service": "geovalue-python-risk-service"}


@app.post("/predict/risk", response_model=RiskPredictionResponse, status_code=status.HTTP_200_OK)
async def predict_risk(payload: RiskPredictionRequest) -> RiskPredictionResponse:
    """
    Predict parcel climate risk_score (0-100), AHP-weighted INR/Gaj valuation,
    comparable registry sales, NCR government policies, and 10-year ARIMA-X trajectories.
    """
    try:
        bundle = _build_indian_valuation_bundle(payload)
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

    forecast = bundle["forecast"]
    scenarios = forecast["scenarios"]
    return RiskPredictionResponse(
        parcel_id=payload.parcel_id,
        risk_score=bundle["risk_score"],
        risk_adjusted_valuation=bundle["market_rate_gaj"],
        official_circle_rate_gaj=bundle["official_circle_rate_gaj"],
        circle_to_market_spread_pct=bundle["spread_pct"],
        plot_area_gaj=bundle["plot_area_gaj"],
        plot_area_sqm=bundle["plot_area_sqm"],
        total_plot_valuation_inr=bundle["total_plot_valuation_inr"],
        sub_region=bundle["zone_meta"]["zone_name"],
        circle_rate_authority=bundle["zone_meta"]["authority"],
        ahp_consistency_ratio=AHP_MODEL_CACHE["consistency_ratio"],
        ahp_lambda_max=AHP_MODEL_CACHE["lambda_max"],
        ahp_weights=AHP_MODEL_CACHE["weights"],
        explainable_breakdown=bundle["explainable_breakdown"],
        comparable_registries=bundle["comparable_registries"],
        policy_catalysts=bundle["zone_meta"]["policies"],
        spatial_distances_m=bundle["spatial_distances_m"],
        forecast_years=forecast["years"],
        baseline_trajectory=scenarios["baseline"],
        infrastructure_trajectory=scenarios["infrastructure_accelerated"],
        adverse_risk_trajectory=scenarios["adverse_risk"],
        horizon_milestones=forecast["horizons"],
    )


@app.post("/chat/valuation", response_model=ValuationChatResponse, status_code=status.HTTP_200_OK)
async def valuation_chat(payload: ValuationChatRequest) -> ValuationChatResponse:
    """
    Answer conversational questions about the selected NCR parcel in ₹/Gaj and
    ₹ Lakhs/Crores using AHP weights, comparable registries, and ARIMA-X forecasts.
    """
    if payload.parcel_context is None:
        return ValuationChatResponse(
            reply=(
                "No municipal parcel is currently selected. Search for **Noida Sec 128**, "
                "**Delhi**, **Gurgaon**, **Ghaziabad**, or **Faridabad** and click any glowing "
                "parcel beacon to inspect its **₹/Gaj** valuation, Saaty **AHP weights** "
                f"(CR = {AHP_MODEL_CACHE['consistency_ratio']}), comparable registries, and 10-year forecast."
            ),
            parcel_id=None,
            computed_metrics=None,
            suggested_questions=[
                "How does Saaty AHP weight land value?",
                "Which NCR policies drive 10-year appreciation?",
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
