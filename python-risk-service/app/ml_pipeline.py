"""Spatially blocked ML valuation training pipeline for GeoValue 2.0."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional, Sequence, Union

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor, VotingRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import mean_squared_error, r2_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

try:
    import geopandas as gpd
except ImportError:  # pragma: no cover
    gpd = None

try:
    from xgboost import XGBRegressor

    _XGBOOST_IMPORT_ERROR: Optional[Exception] = None
except Exception as exc:  # pragma: no cover - e.g. missing OpenMP runtime (libomp) on macOS
    XGBRegressor = None  # type: ignore[assignment]
    _XGBOOST_IMPORT_ERROR = exc


DEFAULT_FEATURE_COLUMNS = [
    "circle_rate",
    "distance_to_hazard",
    "flood_depth_m",
    "impervious_surface_pct",
    "centroid_x",
    "centroid_y",
]


def assign_spatial_blocks(
    gdf_or_coords: Union[Any, Sequence[Sequence[float]], np.ndarray],
    n_blocks_per_axis: int = 5,
) -> np.ndarray:
    """
    Partition parcel locations into a 2D spatial grid of block IDs.

    Spatially blocked cross-validation ensures neighboring parcels remain in the
    same fold, preventing spatial autocorrelation leakage during evaluation.
    """
    if n_blocks_per_axis < 1:
        raise ValueError("n_blocks_per_axis must be >= 1.")

    if gpd is not None and isinstance(gdf_or_coords, gpd.GeoDataFrame):
        if gdf_or_coords.empty:
            return np.array([], dtype=int)
        # Compute centroids in projected CRS when geographic, if possible
        geom = gdf_or_coords.geometry
        if gdf_or_coords.crs is not None and gdf_or_coords.crs.is_geographic:
            try:
                projected = geom.to_crs(gdf_or_coords.estimate_utm_crs())
                centroids = projected.centroid
            except Exception:
                centroids = geom.centroid
        else:
            centroids = geom.centroid
        xs = centroids.x.to_numpy(dtype=float)
        ys = centroids.y.to_numpy(dtype=float)
    else:
        coords = np.asarray(gdf_or_coords, dtype=float)
        if coords.ndim != 2 or coords.shape[1] != 2:
            raise ValueError("Expected a GeoDataFrame or an (N, 2) array of (x, y) coordinates.")
        if len(coords) == 0:
            return np.array([], dtype=int)
        xs = coords[:, 0]
        ys = coords[:, 1]

    x_min, x_max = float(np.min(xs)), float(np.max(xs))
    y_min, y_max = float(np.min(ys)), float(np.max(ys))

    x_span = x_max - x_min if x_max > x_min else 1.0
    y_span = y_max - y_min if y_max > y_min else 1.0

    col_idx = np.clip(
        np.floor(((xs - x_min) / x_span) * n_blocks_per_axis).astype(int),
        0,
        n_blocks_per_axis - 1,
    )
    row_idx = np.clip(
        np.floor(((ys - y_min) / y_span) * n_blocks_per_axis).astype(int),
        0,
        n_blocks_per_axis - 1,
    )
    return row_idx * n_blocks_per_axis + col_idx


def build_valuation_ensemble(
    rf_weight: float = 0.45,
    xgb_weight: float = 0.55,
    random_state: int = 42,
) -> Pipeline:
    """
    Build a preprocessing + weighted ensemble Pipeline combining
    RandomForestRegressor and XGBRegressor.
    """
    if XGBRegressor is None:
        raise RuntimeError(
            "XGBoost could not be loaded. On macOS, ensure OpenMP is installed "
            "(`brew install libomp`). "
            f"Original error: {_XGBOOST_IMPORT_ERROR}"
        )

    rf_model = RandomForestRegressor(
        n_estimators=250,
        max_depth=14,
        min_samples_leaf=3,
        n_jobs=-1,
        random_state=random_state,
    )
    xgb_model = XGBRegressor(
        n_estimators=300,
        max_depth=6,
        learning_rate=0.05,
        subsample=0.85,
        colsample_bytree=0.85,
        objective="reg:squarederror",
        random_state=random_state,
        n_jobs=-1,
    )

    ensemble = VotingRegressor(
        estimators=[("rf", rf_model), ("xgb", xgb_model)],
        weights=[rf_weight, xgb_weight],
    )

    return Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="median")),
            ("scaler", StandardScaler()),
            ("ensemble", ensemble),
        ]
    )


def _prepare_features(
    gdf: Any,
    target_col: str,
) -> tuple[pd.DataFrame, pd.Series, list[str]]:
    """Preprocess GeoPackage attributes and extract centroid coordinates."""
    if target_col not in gdf.columns:
        raise ValueError(f"Target column '{target_col}' not found in dataset.")

    df = gdf.copy()
    centroids = df.geometry.centroid
    df["centroid_x"] = centroids.x.astype(float)
    df["centroid_y"] = centroids.y.astype(float)

    excluded = {target_col, "geometry", "id", "parcel_id", "created_at", "updated_at"}
    candidate_cols = [col for col in DEFAULT_FEATURE_COLUMNS if col in df.columns]
    extra_numeric = [
        col
        for col in df.select_dtypes(include=[np.number]).columns
        if col not in excluded and col not in candidate_cols
    ]
    feature_cols = candidate_cols + extra_numeric
    if not feature_cols:
        raise ValueError("No numeric feature columns available for training.")

    valid_mask = df[target_col].notna()
    df = df.loc[valid_mask].reset_index(drop=True)

    X = df[feature_cols].astype(float)
    y = df[target_col].astype(float)
    return X, y, feature_cols


def train_and_save_model(
    data_path: Union[str, Path],
    model_output_path: Union[str, Path] = "models/geovalue_ensemble.joblib",
    target_col: str = "risk_adjusted_valuation",
    n_blocks_per_axis: int = 5,
    n_splits: int = 5,
) -> dict[str, Any]:
    """
    Ingest a GeoPackage (.gpkg), run spatially blocked cross-validation using
    GroupKFold, fit the RF + XGBoost weighted ensemble, and persist via joblib.
    """
    if gpd is None:
        raise ImportError("geopandas is required to ingest GeoPackage datasets.")

    gdf = gpd.read_file(str(data_path))
    if gdf.empty:
        raise ValueError(f"GeoPackage at '{data_path}' contains no parcel records.")

    X, y, feature_cols = _prepare_features(gdf, target_col=target_col)
    spatial_groups = assign_spatial_blocks(
        gdf.loc[gdf[target_col].notna()].reset_index(drop=True),
        n_blocks_per_axis=n_blocks_per_axis,
    )

    unique_groups = int(np.unique(spatial_groups).size)
    effective_splits = min(n_splits, unique_groups)
    if effective_splits < 2:
        raise ValueError(
            "Insufficient spatial blocks for GroupKFold cross-validation "
            f"(found {unique_groups} unique block(s))."
        )

    gkf = GroupKFold(n_splits=effective_splits)
    fold_metrics: list[dict[str, float]] = []

    for fold_idx, (train_idx, val_idx) in enumerate(gkf.split(X, y, groups=spatial_groups), start=1):
        fold_pipeline = build_valuation_ensemble()
        fold_pipeline.fit(X.iloc[train_idx], y.iloc[train_idx])
        preds = fold_pipeline.predict(X.iloc[val_idx])

        rmse = float(np.sqrt(mean_squared_error(y.iloc[val_idx], preds)))
        r2 = float(r2_score(y.iloc[val_idx], preds)) if len(val_idx) > 1 else 0.0
        fold_metrics.append({"fold": float(fold_idx), "rmse": round(rmse, 4), "r2": round(r2, 4)})

    mean_rmse = round(float(np.mean([m["rmse"] for m in fold_metrics])), 4)
    mean_r2 = round(float(np.mean([m["r2"] for m in fold_metrics])), 4)

    # Fit final ensemble on all available parcels
    final_pipeline = build_valuation_ensemble()
    final_pipeline.fit(X, y)

    output_path = Path(model_output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    artifact = {
        "pipeline": final_pipeline,
        "feature_columns": feature_cols,
        "target_col": target_col,
        "cv_strategy": "spatially_blocked_group_kfold",
        "n_splits": effective_splits,
        "cv_metrics": {
            "mean_rmse": mean_rmse,
            "mean_r2": mean_r2,
            "folds": fold_metrics,
        },
    }
    joblib.dump(artifact, output_path)

    return {
        "model_path": str(output_path),
        "samples": int(len(X)),
        "feature_columns": feature_cols,
        "cv_metrics": artifact["cv_metrics"],
    }
