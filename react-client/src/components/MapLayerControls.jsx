import { useState } from "react";

export default function MapLayerControls({
  baseStyle,
  onChangeBaseStyle,
  showChoropleth,
  onToggleChoropleth,
  choroplethOpacity,
  onChangeOpacity,
  mapboxTokenPresent,
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="layer-control-panel">
      <div className="layer-control-header">
        <span>Map Layers</span>
        <button
          type="button"
          className="layer-collapse-btn"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
        >
          {collapsed ? "+" : "−"}
        </button>
      </div>

      {!collapsed && (
        <div className="layer-control-body">
          <div className="layer-group">
            <span className="layer-group-label">Base Style</span>
            <div className="style-toggle-group">
              <button
                type="button"
                className={`style-toggle-btn ${baseStyle === "dark" ? "active" : ""}`}
                onClick={() => onChangeBaseStyle("dark")}
              >
                Dark
              </button>
              <button
                type="button"
                className={`style-toggle-btn ${baseStyle === "satellite" ? "active" : ""}`}
                onClick={() => onChangeBaseStyle("satellite")}
              >
                Satellite
              </button>
            </div>
            {!mapboxTokenPresent && baseStyle === "satellite" && (
              <span className="layer-hint">
                Add Mapbox token in .env for satellite imagery.
              </span>
            )}
          </div>

          <div className="layer-group">
            <label className="choropleth-toggle">
              <input
                type="checkbox"
                checked={showChoropleth}
                onChange={(e) => onToggleChoropleth(e.target.checked)}
              />
              <span>Risk Choropleth (risk_score)</span>
            </label>

            {showChoropleth && (
              <div className="opacity-slider-row">
                <span>Opacity {Math.round(choroplethOpacity * 100)}%</span>
                <input
                  type="range"
                  min="0.15"
                  max="0.9"
                  step="0.05"
                  value={choroplethOpacity}
                  onChange={(e) =>
                    onChangeOpacity(Number.parseFloat(e.target.value))
                  }
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
