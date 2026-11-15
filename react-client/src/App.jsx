import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import mapboxgl from "mapbox-gl";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN || "";
const NODE_API_URL = import.meta.env.VITE_NODE_API_URL || "http://localhost:3000";
const RISK_API_URL = import.meta.env.VITE_RISK_API_URL || "http://localhost:8000";

const INITIAL_CENTER = [77.209, 28.6139];
const INITIAL_ZOOM = 12;
const HORIZON_OPTIONS = [3, 5, 10];

function getRiskTier(score) {
  if (score >= 75) return { label: "Critical", className: "badge-critical" };
  if (score >= 50) return { label: "High", className: "badge-high" };
  if (score >= 25) return { label: "Moderate", className: "badge-moderate" };
  return { label: "Low", className: "badge-low" };
}

function formatCurrency(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatCompactCurrency(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Build a safe DOM node for the Mapbox popup without raw HTML string interpolation.
 */
function buildPopupContent({ parcelId, circleRate, distanceToHazard, prediction, error, loading }) {
  const container = document.createElement("div");
  container.className = "map-popup";

  const title = document.createElement("div");
  title.className = "map-popup-title";
  title.textContent = `Parcel ${parcelId}`;
  container.appendChild(title);

  const addRow = (label, val) => {
    const row = document.createElement("div");
    row.className = "map-popup-row";
    const key = document.createElement("span");
    key.textContent = label;
    const valueEl = document.createElement("strong");
    valueEl.textContent = val;
    row.append(key, valueEl);
    container.appendChild(row);
  };

  addRow("Circle Rate", formatCurrency(circleRate));
  addRow("Hazard Distance", `${distanceToHazard} m`);

  if (loading) {
    const status = document.createElement("div");
    status.className = "map-popup-status";
    status.textContent = "Computing ML risk score & 10Y forecast...";
    container.appendChild(status);
  } else if (error) {
    const errEl = document.createElement("div");
    errEl.className = "map-popup-error";
    errEl.textContent = error;
    container.appendChild(errEl);
  } else if (prediction) {
    addRow("Predicted Risk", `${prediction.risk_score} / 100`);
    addRow("Adjusted Valuation", formatCurrency(prediction.risk_adjusted_valuation));
  }

  return container;
}

export default function App() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const popupRef = useRef(null);
  const abortControllerRef = useRef(null);

  const [selectedParcel, setSelectedParcel] = useState(null);
  const [prediction, setPrediction] = useState(null);
  const [forecastHorizon, setForecastHorizon] = useState(10);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;

    const mapStyle = MAPBOX_TOKEN
      ? "mapbox://styles/mapbox/dark-v11"
      : {
          version: 8,
          sources: {},
          layers: [
            {
              id: "background",
              type: "background",
              paint: { "background-color": "#0b1120" },
            },
          ],
        };

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: mapStyle,
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
    });

    map.addControl(new mapboxgl.NavigationControl(), "top-right");
    mapRef.current = map;

    map.on("load", () => {
      map.addSource("municipal-parcels", {
        type: "vector",
        tiles: [`${NODE_API_URL}/api/tiles/{z}/{x}/{y}.pbf`],
        minzoom: 0,
        maxzoom: 22,
      });

      map.addLayer({
        id: "municipal-parcels-fill",
        type: "fill",
        source: "municipal-parcels",
        "source-layer": "municipal_parcels",
        paint: {
          "fill-color": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "risk_score"], 0],
            0,
            "#22c55e",
            35,
            "#eab308",
            65,
            "#f97316",
            100,
            "#ef4444",
          ],
          "fill-opacity": 0.55,
        },
      });

      map.addLayer({
        id: "municipal-parcels-outline",
        type: "line",
        source: "municipal-parcels",
        "source-layer": "municipal_parcels",
        paint: {
          "line-color": "#e2e8f0",
          "line-width": 1.25,
          "line-opacity": 0.75,
        },
      });

      map.on("mouseenter", "municipal-parcels-fill", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "municipal-parcels-fill", () => {
        map.getCanvas().style.cursor = "";
      });

      map.on("click", "municipal-parcels-fill", async (e) => {
        const feature = e.features?.[0];
        if (!feature) return;

        const props = feature.properties || {};
        const parcelId = String(props.parcel_id ?? props.id ?? "UNKNOWN");
        const circleRate = Number(props.circle_rate ?? 0);
        const distanceToHazard = Number(
          props.distance_to_hazard ?? props.distance ?? 250
        );

        const parcelInfo = {
          parcel_id: parcelId,
          circle_rate: Number.isFinite(circleRate) ? circleRate : 0,
          distance_to_hazard: Number.isFinite(distanceToHazard)
            ? distanceToHazard
            : 250,
          coordinates: [
            Number(e.lngLat.lng.toFixed(5)),
            Number(e.lngLat.lat.toFixed(5)),
          ],
        };

        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
        }
        const controller = new AbortController();
        abortControllerRef.current = controller;

        setSelectedParcel(parcelInfo);
        setPrediction(null);
        setError(null);
        setLoading(true);

        if (popupRef.current) {
          popupRef.current.remove();
        }
        const popup = new mapboxgl.Popup({ closeButton: true, maxWidth: "280px" })
          .setLngLat(e.lngLat)
          .setDOMContent(
            buildPopupContent({
              parcelId: parcelInfo.parcel_id,
              circleRate: parcelInfo.circle_rate,
              distanceToHazard: parcelInfo.distance_to_hazard,
              loading: true,
            })
          )
          .addTo(map);
        popupRef.current = popup;

        try {
          const { data } = await axios.post(
            `${RISK_API_URL}/predict/risk`,
            {
              parcel_id: parcelInfo.parcel_id,
              circle_rate: parcelInfo.circle_rate,
              distance_to_hazard: parcelInfo.distance_to_hazard,
            },
            { signal: controller.signal }
          );

          setPrediction(data);
          setLoading(false);
          popup.setDOMContent(
            buildPopupContent({
              parcelId: parcelInfo.parcel_id,
              circleRate: parcelInfo.circle_rate,
              distanceToHazard: parcelInfo.distance_to_hazard,
              prediction: data,
              loading: false,
            })
          );
        } catch (err) {
          if (axios.isCancel(err) || err.name === "CanceledError") return;
          const message =
            err.response?.data?.detail ||
            err.message ||
            "Failed to predict climate risk.";
          setError(message);
          setLoading(false);
          popup.setDOMContent(
            buildPopupContent({
              parcelId: parcelInfo.parcel_id,
              circleRate: parcelInfo.circle_rate,
              distanceToHazard: parcelInfo.distance_to_hazard,
              error: message,
              loading: false,
            })
          );
        }
      });
    });

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (popupRef.current) {
        popupRef.current.remove();
      }
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const chartData = useMemo(() => {
    if (!prediction) return [];
    const years = prediction.forecast_years || [];
    const baseline = prediction.baseline_trajectory || [];
    const infra = prediction.infrastructure_trajectory || [];
    const risk = prediction.adverse_risk_trajectory || [];

    return years.slice(0, forecastHorizon).map((yr, idx) => ({
      year: `Y${yr}`,
      Baseline: baseline[idx] ?? 0,
      Infra: infra[idx] ?? 0,
      Risk: risk[idx] ?? 0,
    }));
  }, [prediction, forecastHorizon]);

  const terminalSnapshot = chartData.length > 0 ? chartData[chartData.length - 1] : null;
  const riskTier = prediction ? getRiskTier(prediction.risk_score) : null;
  const discountPercent =
    selectedParcel && prediction && selectedParcel.circle_rate > 0
      ? (
          ((selectedParcel.circle_rate - prediction.risk_adjusted_valuation) /
            selectedParcel.circle_rate) *
          100
        ).toFixed(1)
      : null;

  return (
    <div className="layout">
      <aside className="sidebar">
        <header className="sidebar-header">
          <span className="brand-pill">GeoValue 2.0</span>
          <h1>Climate Risk &amp; Valuation</h1>
          <p className="subtitle">
            Click any municipal parcel on the map to evaluate real-time climate
            hazard exposure, ML valuation, and 10-year investment trajectories.
          </p>
        </header>

        {!MAPBOX_TOKEN && (
          <div className="notice-banner">
            <strong>Mapbox Token Missing:</strong> Set{" "}
            <code>VITE_MAPBOX_ACCESS_TOKEN</code> in <code>.env</code> to load
            Mapbox basemap tiles. Vector parcel tiles still render over the dark
            canvas.
          </div>
        )}

        <section className="panel">
          <h2>Selected Parcel</h2>
          {!selectedParcel ? (
            <p className="empty-state">
              No parcel selected. Click a polygon rendered from{" "}
              <code>municipal_parcels</code> to inspect risk metrics.
            </p>
          ) : (
            <div className="metrics-grid">
              <div className="metric-card">
                <span className="metric-label">Parcel ID</span>
                <strong className="metric-value mono">
                  {selectedParcel.parcel_id}
                </strong>
              </div>
              <div className="metric-card">
                <span className="metric-label">Base Circle Rate</span>
                <strong className="metric-value">
                  {formatCurrency(selectedParcel.circle_rate)}
                </strong>
              </div>
              <div className="metric-card">
                <span className="metric-label">Distance to Hazard</span>
                <strong className="metric-value">
                  {selectedParcel.distance_to_hazard} m
                </strong>
              </div>
              <div className="metric-card">
                <span className="metric-label">Clicked Coordinates</span>
                <strong className="metric-value mono">
                  {selectedParcel.coordinates[1]}, {selectedParcel.coordinates[0]}
                </strong>
              </div>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-title-row">
            <h2>ML Risk Valuation</h2>
            {riskTier && (
              <span className={`risk-badge ${riskTier.className}`}>
                {riskTier.label} Risk
              </span>
            )}
          </div>

          {loading && (
            <div className="status-box loading-box">
              Running FastAPI risk scoring &amp; ARIMA-X forecasting...
            </div>
          )}

          {error && (
            <div className="status-box error-box">
              <strong>Prediction Error:</strong> {error}
            </div>
          )}

          {!loading && !error && !prediction && (
            <p className="empty-state">
              Awaiting parcel selection for <code>POST /predict/risk</code>.
            </p>
          )}

          {!loading && !error && prediction && (
            <div className="prediction-results">
              <div className="highlight-card">
                <span className="metric-label">Predicted Risk Score</span>
                <div className="score-row">
                  <strong className="score-number">
                    {prediction.risk_score}
                  </strong>
                  <span className="score-max">/ 100</span>
                </div>
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{ width: `${Math.min(100, prediction.risk_score)}%` }}
                  />
                </div>
              </div>

              <div className="highlight-card valuation-card">
                <span className="metric-label">Risk-Adjusted Valuation</span>
                <strong className="valuation-number">
                  {formatCurrency(prediction.risk_adjusted_valuation)}
                </strong>
                {discountPercent !== null && (
                  <span className="discount-note">
                    -{discountPercent}% climate risk adjustment from base circle
                    rate
                  </span>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="panel scenario-panel">
          <div className="panel-title-row">
            <h2>Investment Scenario Tool</h2>
            <div className="horizon-pills" role="group" aria-label="Forecast Horizon">
              {HORIZON_OPTIONS.map((yr) => (
                <button
                  key={yr}
                  type="button"
                  className={`horizon-pill ${forecastHorizon === yr ? "active" : ""}`}
                  onClick={() => setForecastHorizon(yr)}
                >
                  {yr}Y
                </button>
              ))}
            </div>
          </div>

          {!prediction || chartData.length === 0 ? (
            <p className="empty-state">
              Select a parcel to render the 3Y / 5Y / 10Y ARIMA-X price
              trajectories across Baseline, Infrastructure-Accelerated, and
              Adverse-Risk scenarios.
            </p>
          ) : (
            <>
              <div className="chart-container">
                <ResponsiveContainer width="100%" height={230}>
                  <LineChart
                    data={chartData}
                    margin={{ top: 8, right: 12, left: 4, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="year" stroke="#94a3b8" fontSize={11} />
                    <YAxis
                      stroke="#94a3b8"
                      fontSize={11}
                      width={64}
                      tickFormatter={formatCompactCurrency}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#0f172a",
                        borderColor: "#334155",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                      formatter={(value) => formatCurrency(Number(value))}
                    />
                    <Legend wrapperStyle={{ fontSize: "11px" }} />
                    <Line
                      type="monotone"
                      dataKey="Baseline"
                      name="Baseline"
                      stroke="#38bdf8"
                      strokeWidth={2.2}
                      dot={{ r: 2.5 }}
                      activeDot={{ r: 5 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="Infra"
                      name="Infra (+15-20%)"
                      stroke="#22c55e"
                      strokeWidth={2.2}
                      dot={{ r: 2.5 }}
                      activeDot={{ r: 5 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="Risk"
                      name="Adverse Risk"
                      stroke="#ef4444"
                      strokeWidth={2.2}
                      dot={{ r: 2.5 }}
                      activeDot={{ r: 5 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {terminalSnapshot && (
                <div className="scenario-summary-grid">
                  <div className="scenario-chip chip-baseline">
                    <span>Y{forecastHorizon} Baseline</span>
                    <strong>{formatCompactCurrency(terminalSnapshot.Baseline)}</strong>
                  </div>
                  <div className="scenario-chip chip-infra">
                    <span>Y{forecastHorizon} Infra</span>
                    <strong>{formatCompactCurrency(terminalSnapshot.Infra)}</strong>
                  </div>
                  <div className="scenario-chip chip-risk">
                    <span>Y{forecastHorizon} Risk</span>
                    <strong>{formatCompactCurrency(terminalSnapshot.Risk)}</strong>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        <footer className="legend">
          <h3>Risk Score Choropleth</h3>
          <div className="legend-bar" />
          <div className="legend-labels">
            <span>0 (Low)</span>
            <span>50 (Moderate)</span>
            <span>100 (Critical)</span>
          </div>
        </footer>
      </aside>

      <main className="map-stage">
        <div ref={mapContainerRef} className="map-container" />
      </main>
    </div>
  );
}
