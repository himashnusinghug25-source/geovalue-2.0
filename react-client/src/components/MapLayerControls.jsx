import { useState } from "react";

const OVERLAY_ITEMS = [
  { key: "metro_rrts", label: "Metro & RRTS Transit", dotColor: "#38bdf8" },
  { key: "roads_expressways", label: "Expressways & RoW", dotColor: "#fbbf24" },
  { key: "social_infra", label: "Hospitals, Malls & Schools", dotColor: "#a855f7" },
  { key: "flood_hazard", label: "Floodplain & Hazards", dotColor: "#f43f5e" },
  { key: "crime_safety", label: "Crime & Safety Heatmap", dotColor: "#10b981" },
];

export default function MapLayerControls({
  baseStyle,
  onChangeBaseStyle,
  is3DTilt,
  onToggle3DTilt,
  show3DExtrusion,
  onToggle3DExtrusion,
  showChoropleth,
  onToggleChoropleth,
  choroplethOpacity,
  onChangeOpacity,
  ncrOverlays,
  onToggleNcrOverlay,
  mapboxTokenPresent,
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="layer-control-panel glass-surface">
      <div className="layer-control-header">
        <div className="layer-header-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="12 2 2 7 12 12 22 7 12 2" />
            <polyline points="2 17 12 22 22 17" />
            <polyline points="2 12 12 17 22 12" />
          </svg>
          <span>NCR Spatial Layers</span>
        </div>
        <button
          type="button"
          className="layer-collapse-btn"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand layer controls" : "Collapse layer controls"}
        >
          {collapsed ? "+" : "−"}
        </button>
      </div>

      {!collapsed && (
        <div className="layer-control-body">
          <div className="layer-group">
            <span className="layer-group-label">Base Canvas</span>
            <div className="style-toggle-group">
              <button
                type="button"
                className={`style-toggle-btn ${baseStyle === "dark" ? "active" : ""}`}
                onClick={() => onChangeBaseStyle("dark")}
              >
                Obsidian Dark
              </button>
              <button
                type="button"
                className={`style-toggle-btn ${baseStyle === "satellite" ? "active" : ""}`}
                onClick={() => onChangeBaseStyle("satellite")}
              >
                Satellite HD
              </button>
            </div>
            {!mapboxTokenPresent && baseStyle === "satellite" && (
              <span className="layer-hint">
                Add Mapbox token in .env for satellite imagery.
              </span>
            )}
          </div>

          <div className="layer-group">
            <span className="layer-group-label">Volumetric 3D &amp; Choropleth</span>
            <label className="switch-row">
              <span>3D Camera Tilt (52°)</span>
              <input
                type="checkbox"
                checked={is3DTilt}
                onChange={(e) => onToggle3DTilt(e.target.checked)}
              />
            </label>
            <label className="switch-row">
              <span>3D Risk Extrusion</span>
              <input
                type="checkbox"
                checked={show3DExtrusion}
                onChange={(e) => onToggle3DExtrusion(e.target.checked)}
              />
            </label>
            <label className="switch-row">
              <span>Parcel Risk Choropleth</span>
              <input
                type="checkbox"
                checked={showChoropleth}
                onChange={(e) => onToggleChoropleth(e.target.checked)}
              />
            </label>

            {showChoropleth && (
              <div className="opacity-slider-row">
                <div className="opacity-label-row">
                  <span>Fill Intensity</span>
                  <span className="mono">{Math.round(choroplethOpacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.15"
                  max="0.95"
                  step="0.05"
                  value={choroplethOpacity}
                  onChange={(e) =>
                    onChangeOpacity(Number.parseFloat(e.target.value))
                  }
                />
              </div>
            )}
          </div>

          <div className="layer-group">
            <span className="layer-group-label">5 Delhi-NCR Overlays</span>
            {OVERLAY_ITEMS.map((item) => (
              <label key={item.key} className="switch-row">
                <span className="overlay-label-cell">
                  <i
                    className="overlay-color-dot"
                    style={{ backgroundColor: item.dotColor }}
                  />
                  <span>{item.label}</span>
                </span>
                <input
                  type="checkbox"
                  checked={Boolean(ncrOverlays?.[item.key])}
                  onChange={(e) =>
                    onToggleNcrOverlay(item.key, e.target.checked)
                  }
                />
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
