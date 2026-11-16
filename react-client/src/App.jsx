import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

import AIChatWidget from "./components/AIChatWidget.jsx";
import AuthModal from "./components/AuthModal.jsx";
import GISReportModal from "./components/GISReportModal.jsx";
import MapLayerControls from "./components/MapLayerControls.jsx";
import PortfolioView from "./components/PortfolioView.jsx";
import RegionSearchBar from "./components/RegionSearchBar.jsx";
import {
  formatInrLakhCrore,
  formatInrPerGaj,
  gajToSqm,
} from "./lib/formatInr.js";
import {
  fetchSavedPortfolio,
  getCurrentSessionUser,
  removeParcelFromPortfolio,
  saveParcelToPortfolio,
  signOutUser,
  subscribeToAuthChanges,
} from "./lib/supabaseClient.js";

function resolveServiceUrl(envUrl) {
  const configured = envUrl || import.meta.env.VITE_API_BASE_URL || "";
  if (
    !configured ||
    configured.includes("localhost") ||
    configured.includes("127.0.0.1")
  ) {
    return "";
  }
  return configured;
}

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN || "";
const NODE_API_URL = resolveServiceUrl(import.meta.env.VITE_NODE_API_URL);
const RISK_API_URL = resolveServiceUrl(import.meta.env.VITE_RISK_API_URL);
const TILE_SERVICE_ORIGIN =
  NODE_API_URL ||
  (typeof window !== "undefined" ? window.location.origin : "http://localhost:5173");

const INITIAL_CENTER = [77.3513, 28.5112];
const INITIAL_ZOOM = 13.8;
const INITIAL_PITCH = 52;
const INITIAL_BEARING = -18;
const HORIZON_OPTIONS = [3, 5, 10];
const EMPTY_FC = { type: "FeatureCollection", features: [] };

function extractFeatureCentroid(feature) {
  const props = feature?.properties || {};
  if (
    Number.isFinite(Number(props.centroid_lon)) &&
    Number.isFinite(Number(props.centroid_lat))
  ) {
    return [Number(props.centroid_lon), Number(props.centroid_lat)];
  }
  const geom = feature?.geometry;
  if (!geom) return null;
  if (geom.type === "Point" && Array.isArray(geom.coordinates)) {
    return [Number(geom.coordinates[0]), Number(geom.coordinates[1])];
  }
  const ring =
    geom.type === "Polygon"
      ? geom.coordinates?.[0]
      : geom.type === "MultiPolygon"
      ? geom.coordinates?.[0]?.[0]
      : null;
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < ring.length; i += 1) {
    sumX += Number(ring[i][0]) || 0;
    sumY += Number(ring[i][1]) || 0;
  }
  return [sumX / ring.length, sumY / ring.length];
}

function buildPointsFeatureCollection(featureCollection) {
  const features = (featureCollection?.features || [])
    .map((feat) => {
      const center = extractFeatureCentroid(feat);
      if (!center || !Number.isFinite(center[0]) || !Number.isFinite(center[1])) {
        return null;
      }
      return {
        type: "Feature",
        properties: {
          ...(feat.properties || {}),
          centroid_lon: center[0],
          centroid_lat: center[1],
        },
        geometry: {
          type: "Point",
          coordinates: center,
        },
      };
    })
    .filter(Boolean);

  return {
    type: "FeatureCollection",
    features,
  };
}

function buildDirectClickedParcelFeature(lng, lat) {
  const lon = Number(lng.toFixed(6));
  const latNum = Number(lat.toFixed(6));
  const latCode = Math.abs(Math.round(latNum * 10000)) % 10000;
  const lngCode = Math.abs(Math.round(lon * 10000)) % 10000;
  const parcelId = `NCR-PLOT-${String(latCode).padStart(4, "0")}-${String(lngCode).padStart(4, "0")}`;

  let subRegion = "Delhi NCR Corridor";
  let baseRate = 145000;
  let hazardLon = 77.333;
  let hazardLat = 28.504;
  let baseElev = 208.0;

  if (lon >= 77.31 && lon <= 77.41 && latNum >= 28.48 && latNum <= 28.56) {
    subRegion = "Noida Sector 128";
    baseRate = 145000;
  } else if (lon >= 77.3 && latNum < 28.61) {
    subRegion = "Noida Expressway";
    baseRate = 125000;
  } else if (lon >= 77.36 && latNum >= 28.61) {
    subRegion = "Ghaziabad Indirapuram";
    baseRate = 88000;
    hazardLon = 77.406;
    hazardLat = 28.655;
    baseElev = 211.0;
  } else if (lon <= 77.15 && latNum <= 28.55) {
    subRegion = "Gurugram Cyber City";
    baseRate = 245000;
    hazardLon = 77.082;
    hazardLat = 28.474;
    baseElev = 229.0;
  } else if (latNum < 28.47 && lon >= 77.22 && lon <= 77.4) {
    subRegion = "Faridabad Central";
    baseRate = 76000;
    hazardLon = 77.352;
    hazardLat = 28.423;
    baseElev = 205.5;
  } else if (lon >= 77.12 && lon <= 77.32 && latNum >= 28.54 && latNum <= 28.72) {
    subRegion = "New Delhi Central";
    baseRate = 340000;
    hazardLon = 77.253;
    hazardLat = 28.631;
    baseElev = 216.0;
  }

  const dLat = (latNum - hazardLat) * 111000;
  const dLon = (lon - hazardLon) * 111000 * Math.cos((latNum * Math.PI) / 180);
  const hazardDistance = Math.max(
    45,
    Math.min(1800, Math.round(Math.hypot(dLon, dLat) * 0.35))
  );

  const decay = Math.exp(-hazardDistance / 500);
  const leaf =
    hazardDistance <= 50
      ? 22
      : hazardDistance <= 150
      ? 14.5
      : hazardDistance <= 500
      ? 8
      : hazardDistance <= 1500
      ? 3.5
      : 0.5;
  const interaction = Math.min(8, Math.log1p(baseRate) * 0.45 * decay);
  const riskScore = Number(
    Math.max(5, Math.min(98, 70 * decay + leaf + interaction)).toFixed(2)
  );

  const halfW = 0.00055;
  const halfH = 0.00048;

  return {
    type: "Feature",
    properties: {
      parcel_id: parcelId,
      circle_rate: baseRate,
      risk_score: riskScore,
      distance_to_hazard: hazardDistance,
      hazard_distance_m: hazardDistance,
      plot_area_gaj: 250,
      metro_distance_m: 680,
      highway_distance_m: 540,
      hospital_distance_m: 1120,
      mall_distance_m: 1380,
      police_distance_m: 820,
      safety_score: 78.5,
      zone_type: "Commercial Mixed-Use",
      soil_class: "Indo-Gangetic Alluvial Loam",
      elevation_m: Number((baseElev + (1 - decay) * 6).toFixed(1)),
      sub_region: subRegion,
      centroid_lon: lon,
      centroid_lat: latNum,
      source_origin: "direct_click",
    },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [Number((lon - halfW).toFixed(6)), Number((latNum - halfH).toFixed(6))],
          [Number((lon + halfW).toFixed(6)), Number((latNum - halfH).toFixed(6))],
          [Number((lon + halfW).toFixed(6)), Number((latNum + halfH).toFixed(6))],
          [Number((lon - halfW).toFixed(6)), Number((latNum + halfH).toFixed(6))],
          [Number((lon - halfW).toFixed(6)), Number((latNum - halfH).toFixed(6))],
        ],
      ],
    },
  };
}

const RISK_CHOROPLETH_COLOR = [
  "interpolate",
  ["linear"],
  ["coalesce", ["get", "risk_score"], 0],
  0,
  "#10b981",
  30,
  "#06b6d4",
  60,
  "#f59e0b",
  85,
  "#f43f5e",
  100,
  "#e11d48",
];

function getMapStyleConfig(styleMode) {
  if (MAPBOX_TOKEN) {
    return styleMode === "satellite"
      ? "mapbox://styles/mapbox/satellite-streets-v12"
      : "mapbox://styles/mapbox/dark-v11";
  }

  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: {
          "background-color": styleMode === "satellite" ? "#0b191b" : "#0b0f19",
        },
      },
    ],
  };
}

function getRiskTier(score) {
  if (score >= 75) {
    return {
      label: "Critical",
      className: "badge-critical",
      color: "#f43f5e",
      cardGlow: "risk-glow-critical",
    };
  }
  if (score >= 50) {
    return {
      label: "High",
      className: "badge-high",
      color: "#f59e0b",
      cardGlow: "risk-glow-high",
    };
  }
  if (score >= 25) {
    return {
      label: "Moderate",
      className: "badge-moderate",
      color: "#06b6d4",
      cardGlow: "risk-glow-moderate",
    };
  }
  return {
    label: "Low",
    className: "badge-low",
    color: "#10b981",
    cardGlow: "risk-glow-low",
  };
}

/**
 * Animated circular SVG gauge for climate risk score (0-100).
 */
function RiskScoreRing({ score, tier }) {
  const clamped = Math.max(0, Math.min(100, Number(score) || 0));
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);

  return (
    <div className="risk-ring-wrap">
      <svg className="risk-ring-svg" viewBox="0 0 110 110" aria-label={`Risk score ${clamped} out of 100`}>
        <defs>
          <filter id="riskRingGlow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle
          className="risk-ring-track"
          cx="55"
          cy="55"
          r={radius}
          strokeWidth="8"
          fill="none"
        />
        <circle
          className="risk-ring-progress"
          cx="55"
          cy="55"
          r={radius}
          strokeWidth="8"
          fill="none"
          stroke={tier.color}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          filter="url(#riskRingGlow)"
          transform="rotate(-90 55 55)"
        />
      </svg>
      <div className="risk-ring-center">
        <strong className="risk-ring-value">{clamped}</strong>
        <span className="risk-ring-unit">/ 100</span>
      </div>
    </div>
  );
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

  addRow("Circle Rate", formatInrPerGaj(circleRate));
  addRow("Hazard Distance", `${distanceToHazard} m`);

  if (loading) {
    const status = document.createElement("div");
    status.className = "map-popup-status";
    status.textContent = "Computing AHP ₹/Gaj & ARIMA-X...";
    container.appendChild(status);
  } else if (error) {
    const errEl = document.createElement("div");
    errEl.className = "map-popup-error";
    errEl.textContent = error;
    container.appendChild(errEl);
  } else if (prediction) {
    addRow("Risk Score", `${prediction.risk_score} / 100`);
    addRow("AI Market Rate", formatInrPerGaj(prediction.risk_adjusted_valuation));
    addRow("Plot Value", formatInrLakhCrore(prediction.total_plot_valuation_inr));
  }

  return container;
}

export default function App() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const popupRef = useRef(null);
  const abortControllerRef = useRef(null);
  const hoverRafRef = useRef(null);

  const showChoroplethRef = useRef(true);
  const show3DExtrusionRef = useRef(true);
  const choroplethOpacityRef = useRef(0.55);
  const bboxGeoJsonRef = useRef(EMPTY_FC);
  const bboxPointsGeoJsonRef = useRef(EMPTY_FC);
  const customClickedFeaturesRef = useRef([]);
  const bboxAbortRef = useRef(null);
  const moveDebounceRef = useRef(null);
  const activeStyleRef = useRef("dark");

  const ncrOverlaysDataRef = useRef(null);
  const [ncrOverlays, setNcrOverlays] = useState({
    metro_rrts: true,
    roads_expressways: true,
    social_infra: false,
    flood_hazard: true,
    crime_safety: false,
  });
  const ncrOverlaysStateRef = useRef(ncrOverlays);

  useEffect(() => {
    ncrOverlaysStateRef.current = ncrOverlays;
  }, [ncrOverlays]);

  const [activeView, setActiveView] = useState(() =>
    window.location.hash === "#portfolio" ? "portfolio" : "map"
  );
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [reportModalOpen, setReportModalOpen] = useState(false);

  // Parcel & ML Valuation State
  const [selectedParcel, setSelectedParcel] = useState(null);
  const [prediction, setPrediction] = useState(null);
  const [forecastHorizon, setForecastHorizon] = useState(10);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Map Layer, 3D Camera & Region Search State
  const [baseStyle, setBaseStyle] = useState("dark");
  const [is3DTilt, setIs3DTilt] = useState(true);
  const [show3DExtrusion, setShow3DExtrusion] = useState(true);
  const [showChoropleth, setShowChoropleth] = useState(true);
  const [choroplethOpacity, setChoroplethOpacity] = useState(0.55);
  const [bboxParcelCount, setBboxParcelCount] = useState(null);
  const [loadingParcels, setLoadingParcels] = useState(false);
  const [bboxError, setBboxError] = useState(null);

  // Auth & Saved Portfolio State
  const [user, setUser] = useState(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [portfolio, setPortfolio] = useState([]);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioError, setPortfolioError] = useState(null);
  const [bookmarkSaving, setBookmarkSaving] = useState(false);
  const [bookmarkFeedback, setBookmarkFeedback] = useState(null);

  useEffect(() => {
    showChoroplethRef.current = showChoropleth;
  }, [showChoropleth]);

  useEffect(() => {
    show3DExtrusionRef.current = show3DExtrusion;
  }, [show3DExtrusion]);

  useEffect(() => {
    choroplethOpacityRef.current = choroplethOpacity;
  }, [choroplethOpacity]);

  // Keep hash routing (#map / #portfolio) synchronized
  useEffect(() => {
    const onHashChange = () => {
      setActiveView(window.location.hash === "#portfolio" ? "portfolio" : "map");
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigateView = useCallback((nextView) => {
    setActiveView(nextView);
    window.location.hash = nextView === "portfolio" ? "#portfolio" : "#map";
  }, []);

  // Load Supabase or local session user and subscribe to auth changes
  useEffect(() => {
    let mounted = true;
    getCurrentSessionUser().then((sessionUser) => {
      if (mounted) setUser(sessionUser);
    });
    const unsubscribe = subscribeToAuthChanges((nextUser) => {
      if (mounted) setUser(nextUser);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  // Refresh saved portfolio whenever authenticated user changes
  useEffect(() => {
    if (!user) {
      setPortfolio([]);
      setPortfolioError(null);
      return;
    }

    let cancelled = false;
    setPortfolioLoading(true);
    setPortfolioError(null);

    fetchSavedPortfolio(user)
      .then((items) => {
        if (!cancelled) setPortfolio(items);
      })
      .catch((err) => {
        if (!cancelled) {
          setPortfolioError(err.message || "Failed to load saved portfolio.");
        }
      })
      .finally(() => {
        if (!cancelled) setPortfolioLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  // Evaluate parcel via Python FastAPI /predict/risk and show Mapbox popup
  const handleParcelSelect = useCallback(async (parcelInfo, lngLatForPopup) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setSelectedParcel(parcelInfo);
    setPrediction(null);
    setError(null);
    setBookmarkFeedback(null);
    setLoading(true);

    const map = mapRef.current;
    let popup = null;

    if (map && lngLatForPopup) {
      if (popupRef.current) {
        popupRef.current.remove();
      }
      popup = new mapboxgl.Popup({ closeButton: true, maxWidth: "280px" })
        .setLngLat(lngLatForPopup)
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
    }

    try {
      const { data } = await axios.post(
        `${RISK_API_URL}/predict/risk`,
        {
          parcel_id: parcelInfo.parcel_id,
          circle_rate: parcelInfo.circle_rate,
          distance_to_hazard: parcelInfo.distance_to_hazard,
          plot_area_gaj: parcelInfo.plot_area_gaj,
          sub_region: parcelInfo.sub_region,
          metro_distance_m: parcelInfo.metro_distance_m,
          highway_distance_m: parcelInfo.highway_distance_m,
          hospital_distance_m: parcelInfo.hospital_distance_m,
          mall_distance_m: parcelInfo.mall_distance_m,
          police_distance_m: parcelInfo.police_distance_m,
          safety_score: parcelInfo.safety_score,
          longitude: parcelInfo.coordinates?.[0],
          latitude: parcelInfo.coordinates?.[1],
        },
        { signal: controller.signal }
      );

      setPrediction(data);
      setLoading(false);

      if (popup) {
        popup.setDOMContent(
          buildPopupContent({
            parcelId: parcelInfo.parcel_id,
            circleRate: parcelInfo.circle_rate,
            distanceToHazard: parcelInfo.distance_to_hazard,
            prediction: data,
            loading: false,
          })
        );
      }
    } catch (err) {
      if (axios.isCancel(err) || err.name === "CanceledError") return;
      const message =
        err.response?.data?.detail ||
        err.message ||
        "Failed to predict climate risk.";
      setError(message);
      setLoading(false);

      if (popup) {
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
    }
  }, []);

  const evaluateParcelRef = useRef(handleParcelSelect);
  useEffect(() => {
    evaluateParcelRef.current = handleParcelSelect;
  }, [handleParcelSelect]);

  const ensureParcelLayers = useCallback((map) => {
    const choroplethVis = showChoroplethRef.current ? "visible" : "none";
    const extrusionVis = show3DExtrusionRef.current ? "visible" : "none";
    const fillOpacity = choroplethOpacityRef.current;

    // Atmospheric volumetric fog on Mapbox v3 canvas
    try {
      map.setFog({
        color: "rgb(11, 15, 25)",
        "high-color": "rgb(20, 32, 58)",
        "horizon-blend": 0.08,
        "space-color": "rgb(6, 9, 17)",
        "star-intensity": 0.2,
      });
    } catch {
      // Fallback custom style may not support fog
    }

    // 3D volumetric urban building extrusions when Mapbox composite source is active
    if (map.getSource("composite") && !map.getLayer("building-3d")) {
      const labelLayerId = map
        .getStyle()
        ?.layers?.find((l) => l.type === "symbol" && l.layout?.["text-field"])?.id;

      map.addLayer(
        {
          id: "building-3d",
          source: "composite",
          "source-layer": "building",
          filter: ["==", "extrude", "true"],
          type: "fill-extrusion",
          minzoom: 13,
          paint: {
            "fill-extrusion-color": "#151e34",
            "fill-extrusion-height": ["coalesce", ["get", "height"], 12],
            "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
            "fill-extrusion-opacity": 0.65,
          },
        },
        labelLayerId
      );
    }

    if (!map.getSource("municipal-parcels")) {
      map.addSource("municipal-parcels", {
        type: "vector",
        tiles: [`${TILE_SERVICE_ORIGIN}/api/tiles/{z}/{x}/{y}.pbf`],
        minzoom: 0,
        maxzoom: 22,
      });
    }

    if (!map.getLayer("municipal-parcels-fill")) {
      map.addLayer({
        id: "municipal-parcels-fill",
        type: "fill",
        source: "municipal-parcels",
        "source-layer": "municipal_parcels",
        minzoom: 9,
        layout: { visibility: choroplethVis },
        paint: {
          "fill-color": RISK_CHOROPLETH_COLOR,
          "fill-opacity": fillOpacity,
        },
      });
    }

    if (!map.getLayer("municipal-parcels-extrusion")) {
      map.addLayer({
        id: "municipal-parcels-extrusion",
        type: "fill-extrusion",
        source: "municipal-parcels",
        "source-layer": "municipal_parcels",
        minzoom: 9,
        layout: { visibility: extrusionVis },
        paint: {
          "fill-extrusion-color": RISK_CHOROPLETH_COLOR,
          "fill-extrusion-height": [
            "*",
            ["coalesce", ["get", "risk_score"], 10],
            2.8,
          ],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.62,
        },
      });
    }

    if (!map.getLayer("municipal-parcels-glow")) {
      map.addLayer({
        id: "municipal-parcels-glow",
        type: "line",
        source: "municipal-parcels",
        minzoom: 9,
        "source-layer": "municipal_parcels",
        paint: {
          "line-color": RISK_CHOROPLETH_COLOR,
          "line-width": 4.5,
          "line-blur": 3.5,
          "line-opacity": 0.45,
        },
      });
    }

    if (!map.getLayer("municipal-parcels-outline")) {
      map.addLayer({
        id: "municipal-parcels-outline",
        type: "line",
        source: "municipal-parcels",
        minzoom: 9,
        "source-layer": "municipal_parcels",
        paint: {
          "line-color": "#67e8f9",
          "line-width": 1.5,
          "line-opacity": 0.9,
        },
      });
    }

    if (!map.getLayer("municipal-parcels-points")) {
      map.addLayer({
        id: "municipal-parcels-points",
        type: "circle",
        source: "municipal-parcels",
        "source-layer": "municipal_parcels",
        minzoom: 8,
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            4.5,
            13,
            6.5,
            16,
            8.5,
          ],
          "circle-color": RISK_CHOROPLETH_COLOR,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#38bdf8",
          "circle-opacity": 0.95,
        },
      });
    }

    if (!map.getSource("bbox-parcels")) {
      map.addSource("bbox-parcels", {
        type: "geojson",
        data: bboxGeoJsonRef.current,
      });
    }

    if (!map.getLayer("bbox-parcels-fill")) {
      map.addLayer({
        id: "bbox-parcels-fill",
        type: "fill",
        source: "bbox-parcels",
        minzoom: 9,
        layout: { visibility: choroplethVis },
        paint: {
          "fill-color": RISK_CHOROPLETH_COLOR,
          "fill-opacity": Math.min(0.95, fillOpacity + 0.12),
        },
      });
    }

    if (!map.getLayer("bbox-parcels-extrusion")) {
      map.addLayer({
        id: "bbox-parcels-extrusion",
        type: "fill-extrusion",
        source: "bbox-parcels",
        minzoom: 9,
        layout: { visibility: extrusionVis },
        paint: {
          "fill-extrusion-color": RISK_CHOROPLETH_COLOR,
          "fill-extrusion-height": [
            "*",
            ["coalesce", ["get", "risk_score"], 10],
            3.2,
          ],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.72,
        },
      });
    }

    if (!map.getLayer("bbox-parcels-glow")) {
      map.addLayer({
        id: "bbox-parcels-glow",
        type: "line",
        source: "bbox-parcels",
        minzoom: 9,
        paint: {
          "line-color": "#22d3ee",
          "line-width": 5,
          "line-blur": 4,
          "line-opacity": 0.48,
        },
      });
    }

    if (!map.getLayer("bbox-parcels-outline")) {
      map.addLayer({
        id: "bbox-parcels-outline",
        type: "line",
        source: "bbox-parcels",
        minzoom: 9,
        paint: {
          "line-color": "#38bdf8",
          "line-width": 1.8,
          "line-opacity": 0.95,
        },
      });
    }

    if (!map.getSource("bbox-parcel-points")) {
      map.addSource("bbox-parcel-points", {
        type: "geojson",
        data: bboxPointsGeoJsonRef.current,
      });
    }

    if (!map.getLayer("bbox-parcels-points-glow")) {
      map.addLayer({
        id: "bbox-parcels-points-glow",
        type: "circle",
        source: "bbox-parcel-points",
        minzoom: 8,
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            10,
            13,
            15,
            16,
            19,
          ],
          "circle-blur": 0.75,
          "circle-color": RISK_CHOROPLETH_COLOR,
          "circle-opacity": 0.5,
        },
      });
    }

    if (!map.getLayer("bbox-parcels-points")) {
      map.addLayer({
        id: "bbox-parcels-points",
        type: "circle",
        source: "bbox-parcel-points",
        minzoom: 8,
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            5,
            13,
            7,
            16,
            9,
          ],
          "circle-color": RISK_CHOROPLETH_COLOR,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#f8fafc",
          "circle-opacity": 0.98,
        },
      });
    }

    if (!map.getLayer("bbox-parcels-labels")) {
      map.addLayer({
        id: "bbox-parcels-labels",
        type: "symbol",
        source: "bbox-parcel-points",
        minzoom: 11.5,
        layout: {
          "text-field": ["get", "parcel_id"],
          "text-size": 10.5,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#e2e8f0",
          "text-halo-color": "#0b0f19",
          "text-halo-width": 1.6,
        },
      });
    }

    // 5 Delhi-NCR Spatial Map Overlays
    const overlayData = ncrOverlaysDataRef.current;
    const overlayState = ncrOverlaysStateRef.current;
    const vis = (key) => (overlayState[key] ? "visible" : "none");

    const upsertOverlaySource = (id, fc) => {
      const existing = map.getSource(id);
      if (existing) {
        if (fc) existing.setData(fc);
      } else {
        map.addSource(id, {
          type: "geojson",
          data: fc || EMPTY_FC,
        });
      }
    };

    upsertOverlaySource("ncr-metro-src", overlayData?.metro_rrts);
    if (!map.getLayer("ncr-metro-lines")) {
      map.addLayer({
        id: "ncr-metro-lines",
        type: "line",
        source: "ncr-metro-src",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { visibility: vis("metro_rrts") },
        paint: {
          "line-color": "#38bdf8",
          "line-width": 2.6,
          "line-dasharray": [2, 1.5],
          "line-opacity": 0.85,
        },
      });
    }
    if (!map.getLayer("ncr-metro-stations")) {
      map.addLayer({
        id: "ncr-metro-stations",
        type: "circle",
        source: "ncr-metro-src",
        filter: ["==", ["geometry-type"], "Point"],
        layout: { visibility: vis("metro_rrts") },
        paint: {
          "circle-radius": 6,
          "circle-color": "#0ea5e9",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#e0f2fe",
        },
      });
    }

    upsertOverlaySource("ncr-roads-src", overlayData?.roads_expressways);
    if (!map.getLayer("ncr-roads-lines")) {
      map.addLayer({
        id: "ncr-roads-lines",
        type: "line",
        source: "ncr-roads-src",
        layout: { visibility: vis("roads_expressways") },
        paint: {
          "line-color": "#fbbf24",
          "line-width": 3,
          "line-opacity": 0.78,
        },
      });
    }

    upsertOverlaySource("ncr-social-src", overlayData?.social_infra);
    if (!map.getLayer("ncr-social-points")) {
      map.addLayer({
        id: "ncr-social-points",
        type: "circle",
        source: "ncr-social-src",
        layout: { visibility: vis("social_infra") },
        paint: {
          "circle-radius": 6.5,
          "circle-color": "#a855f7",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#f3e8ff",
        },
      });
    }

    upsertOverlaySource("ncr-flood-src", overlayData?.flood_hazard);
    if (!map.getLayer("ncr-flood-fill")) {
      map.addLayer({
        id: "ncr-flood-fill",
        type: "fill",
        source: "ncr-flood-src",
        layout: { visibility: vis("flood_hazard") },
        paint: {
          "fill-color": "#f43f5e",
          "fill-opacity": 0.22,
        },
      });
    }
    if (!map.getLayer("ncr-flood-outline")) {
      map.addLayer({
        id: "ncr-flood-outline",
        type: "line",
        source: "ncr-flood-src",
        layout: { visibility: vis("flood_hazard") },
        paint: {
          "line-color": "#fb7185",
          "line-width": 1.6,
          "line-dasharray": [3, 2],
        },
      });
    }

    upsertOverlaySource("ncr-crime-src", overlayData?.crime_safety);
    if (!map.getLayer("ncr-crime-halo")) {
      map.addLayer({
        id: "ncr-crime-halo",
        type: "circle",
        source: "ncr-crime-src",
        layout: { visibility: vis("crime_safety") },
        paint: {
          "circle-radius": 28,
          "circle-blur": 0.85,
          "circle-color": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "safety_score"], 70],
            45,
            "#f43f5e",
            70,
            "#f59e0b",
            90,
            "#10b981",
          ],
          "circle-opacity": 0.55,
        },
      });
    }
  }, []);

  const syncBboxDataToMap = useCallback((fc) => {
    const map = mapRef.current;
    const customFeatures = customClickedFeaturesRef.current || [];
    const existingIds = new Set(
      (fc?.features || []).map((f) => f.properties?.parcel_id)
    );
    const mergedFeatures = [
      ...(fc?.features || []),
      ...customFeatures.filter((f) => !existingIds.has(f.properties?.parcel_id)),
    ];
    const mergedFc = {
      type: "FeatureCollection",
      features: mergedFeatures,
    };
    const pointsFc = buildPointsFeatureCollection(mergedFc);

    bboxGeoJsonRef.current = mergedFc;
    bboxPointsGeoJsonRef.current = pointsFc;
    setBboxParcelCount(mergedFeatures.length);

    const bboxSource = map?.getSource("bbox-parcels");
    if (bboxSource) {
      bboxSource.setData(mergedFc);
    }
    const ptsSource = map?.getSource("bbox-parcel-points");
    if (ptsSource) {
      ptsSource.setData(pointsFc);
    }
  }, []);

  const fetchParcelsForBounds = useCallback(
    async (minLon, minLat, maxLon, maxLat) => {
      if (bboxAbortRef.current) {
        bboxAbortRef.current.abort();
      }
      const controller = new AbortController();
      bboxAbortRef.current = controller;

      setLoadingParcels(true);
      setBboxError(null);
      try {
        const { data } = await axios.get(`${NODE_API_URL}/api/parcels/bbox`, {
          params: { minLon, minLat, maxLon, maxLat },
          signal: controller.signal,
        });
        const fc = data && data.type === "FeatureCollection" ? data : EMPTY_FC;
        syncBboxDataToMap(fc);
      } catch (err) {
        if (axios.isCancel(err) || err.name === "CanceledError") return;
        setBboxError(
          err.response?.data?.error ||
            "Could not fetch bounding-box parcels from Node API."
        );
      } finally {
        setLoadingParcels(false);
      }
    },
    [syncBboxDataToMap]
  );

  const fetchParcelsForBoundsRef = useRef(fetchParcelsForBounds);
  useEffect(() => {
    fetchParcelsForBoundsRef.current = fetchParcelsForBounds;
  }, [fetchParcelsForBounds]);

  // Initialize 3D Mapbox GL JS map once
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: getMapStyleConfig("dark"),
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      pitch: INITIAL_PITCH,
      bearing: INITIAL_BEARING,
      antialias: true,
    });

    map.addControl(
      new mapboxgl.NavigationControl({ visualizePitch: true }),
      "top-right"
    );
    mapRef.current = map;

    const ensureLayersOnLoad = () => ensureParcelLayers(map);
    map.on("load", () => {
      ensureLayersOnLoad();
      const bounds = map.getBounds();
      if (bounds) {
        fetchParcelsForBoundsRef.current(
          bounds.getWest(),
          bounds.getSouth(),
          bounds.getEast(),
          bounds.getNorth()
        );
      }
      axios
        .get(`${NODE_API_URL}/api/layers/ncr-overlays`)
        .then(({ data }) => {
          ncrOverlaysDataRef.current = data;
          ensureParcelLayers(map);
        })
        .catch(() => {
          // Non-fatal if overlays endpoint unreachable
        });
    });
    map.on("style.load", ensureLayersOnLoad);

    map.on("moveend", () => {
      if (moveDebounceRef.current) {
        clearTimeout(moveDebounceRef.current);
      }
      moveDebounceRef.current = setTimeout(() => {
        const bounds = map.getBounds();
        if (!bounds) return;
        fetchParcelsForBoundsRef.current(
          bounds.getWest(),
          bounds.getSouth(),
          bounds.getEast(),
          bounds.getNorth()
        );
      }, 280);
    });

    const getInteractiveLayers = () =>
      [
        "bbox-parcels-points",
        "municipal-parcels-points",
        "bbox-parcels-extrusion",
        "bbox-parcels-fill",
        "municipal-parcels-extrusion",
        "municipal-parcels-fill",
      ].filter((id) => Boolean(map.getLayer(id)));

    map.on("mousemove", (e) => {
      if (hoverRafRef.current) return;
      hoverRafRef.current = window.requestAnimationFrame(() => {
        hoverRafRef.current = null;
        const layers = getInteractiveLayers();
        if (layers.length === 0) return;
        const hits = map.queryRenderedFeatures(e.point, { layers });
        map.getCanvas().style.cursor = hits.length > 0 ? "pointer" : "crosshair";
      });
    });

    map.on("click", (e) => {
      const layers = getInteractiveLayers();
      const hits =
        layers.length > 0 ? map.queryRenderedFeatures(e.point, { layers }) : [];
      let feature = hits[0];

      // Direct map-click fallback: synthesize a parcel right at clicked coordinate
      if (!feature) {
        const directFeature = buildDirectClickedParcelFeature(
          e.lngLat.lng,
          e.lngLat.lat
        );
        customClickedFeaturesRef.current = [
          directFeature,
          ...customClickedFeaturesRef.current.filter(
            (f) => f.properties?.parcel_id !== directFeature.properties.parcel_id
          ),
        ].slice(0, 20);
        syncBboxDataToMap(bboxGeoJsonRef.current);
        feature = directFeature;
      }

      const props = feature.properties || {};
      const parcelId = String(props.parcel_id ?? props.id ?? "UNKNOWN");
      const circleRate = Number(props.circle_rate ?? 145000);
      const distanceToHazard = Number(
        props.distance_to_hazard ?? props.hazard_distance_m ?? props.distance ?? 250
      );

      const parcelInfo = {
        parcel_id: parcelId,
        circle_rate: Number.isFinite(circleRate) ? circleRate : 145000,
        distance_to_hazard: Number.isFinite(distanceToHazard)
          ? distanceToHazard
          : 250,
        plot_area_gaj:
          props.plot_area_gaj != null ? Number(props.plot_area_gaj) : 250,
        metro_distance_m:
          props.metro_distance_m != null ? Number(props.metro_distance_m) : undefined,
        highway_distance_m:
          props.highway_distance_m != null ? Number(props.highway_distance_m) : undefined,
        hospital_distance_m:
          props.hospital_distance_m != null ? Number(props.hospital_distance_m) : undefined,
        mall_distance_m:
          props.mall_distance_m != null ? Number(props.mall_distance_m) : undefined,
        police_distance_m:
          props.police_distance_m != null ? Number(props.police_distance_m) : undefined,
        safety_score:
          props.safety_score != null ? Number(props.safety_score) : undefined,
        zone_type: props.zone_type || "Commercial Mixed-Use",
        soil_class: props.soil_class || "Indo-Gangetic Sandy Loam",
        elevation_m:
          props.elevation_m != null ? Number(props.elevation_m) : undefined,
        sub_region: props.sub_region || "Delhi NCR Region",
        source_origin: props.source_origin || "postgis",
        coordinates: [
          Number(e.lngLat.lng.toFixed(5)),
          Number(e.lngLat.lat.toFixed(5)),
        ],
      };

      evaluateParcelRef.current(parcelInfo, e.lngLat);
    });

    return () => {
      if (moveDebounceRef.current) {
        clearTimeout(moveDebounceRef.current);
      }
      if (bboxAbortRef.current) {
        bboxAbortRef.current.abort();
      }
      if (hoverRafRef.current) {
        window.cancelAnimationFrame(hoverRafRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (popupRef.current) {
        popupRef.current.remove();
      }
      map.remove();
      mapRef.current = null;
    };
  }, [ensureParcelLayers, syncBboxDataToMap]);

  // Apply base style transitions (Dark <-> Satellite) while preserving 3D layers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || activeStyleRef.current === baseStyle) return;
    activeStyleRef.current = baseStyle;
    map.setStyle(getMapStyleConfig(baseStyle));
  }, [baseStyle]);

  // Smooth camera pitch transition for 3D Tilt toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({
      pitch: is3DTilt ? INITIAL_PITCH : 0,
      bearing: is3DTilt ? INITIAL_BEARING : 0,
      duration: 750,
    });
  }, [is3DTilt]);

  // Update 3D extrusion, choropleth visibility, and fill opacity live
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const choroplethVis = showChoropleth ? "visible" : "none";
    const extrusionVis = show3DExtrusion ? "visible" : "none";

    if (map.getLayer("municipal-parcels-fill")) {
      map.setLayoutProperty("municipal-parcels-fill", "visibility", choroplethVis);
      map.setPaintProperty("municipal-parcels-fill", "fill-opacity", choroplethOpacity);
    }
    if (map.getLayer("bbox-parcels-fill")) {
      map.setLayoutProperty("bbox-parcels-fill", "visibility", choroplethVis);
      map.setPaintProperty(
        "bbox-parcels-fill",
        "fill-opacity",
        Math.min(0.95, choroplethOpacity + 0.1)
      );
    }
    if (map.getLayer("municipal-parcels-extrusion")) {
      map.setLayoutProperty("municipal-parcels-extrusion", "visibility", extrusionVis);
    }
    if (map.getLayer("bbox-parcels-extrusion")) {
      map.setLayoutProperty("bbox-parcels-extrusion", "visibility", extrusionVis);
    }
  }, [showChoropleth, show3DExtrusion, choroplethOpacity]);

  // Update visibility for the 5 Delhi-NCR spatial overlays
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const setVis = (layerId, enabled) => {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", enabled ? "visible" : "none");
      }
    };
    setVis("ncr-metro-lines", ncrOverlays.metro_rrts);
    setVis("ncr-metro-stations", ncrOverlays.metro_rrts);
    setVis("ncr-roads-lines", ncrOverlays.roads_expressways);
    setVis("ncr-social-points", ncrOverlays.social_infra);
    setVis("ncr-flood-fill", ncrOverlays.flood_hazard);
    setVis("ncr-flood-outline", ncrOverlays.flood_hazard);
    setVis("ncr-crime-halo", ncrOverlays.crime_safety);
  }, [ncrOverlays]);

  const handleToggleNcrOverlay = useCallback((key, enabled) => {
    setNcrOverlays((prev) => ({ ...prev, [key]: enabled }));
  }, []);

  // Resize Mapbox canvas when returning from Portfolio view
  useEffect(() => {
    if (activeView === "map" && mapRef.current) {
      const timer = setTimeout(() => {
        mapRef.current?.resize();
      }, 40);
      return () => clearTimeout(timer);
    }
  }, [activeView]);

  // Fly to selected city/region and fetch PostGIS parcels within its bounding box
  const handleSelectRegion = useCallback(
    async (region) => {
      navigateView("map");
      setBboxError(null);

      const map = mapRef.current;
      const bbox =
        Array.isArray(region.bbox) && region.bbox.length === 4
          ? region.bbox
          : [
              region.center[0] - 0.08,
              region.center[1] - 0.06,
              region.center[0] + 0.08,
              region.center[1] + 0.06,
            ];

      if (map) {
        if (Array.isArray(region.bbox) && region.bbox.length === 4) {
          map.fitBounds(
            [
              [bbox[0], bbox[1]],
              [bbox[2], bbox[3]],
            ],
            {
              padding: { top: 90, bottom: 60, left: 450, right: 280 },
              maxZoom: 13.8,
              duration: 1300,
              pitch: is3DTilt ? INITIAL_PITCH : 0,
            }
          );
        } else {
          map.flyTo({
            center: region.center,
            zoom: region.zoom || 12.2,
            duration: 1300,
            pitch: is3DTilt ? INITIAL_PITCH : 0,
          });
        }
      }

      await fetchParcelsForBounds(bbox[0], bbox[1], bbox[2], bbox[3]);
    },
    [fetchParcelsForBounds, is3DTilt, navigateView]
  );

  // Bookmark or unbookmark the selected parcel
  const isSelectedBookmarked = useMemo(() => {
    if (!selectedParcel) return false;
    return portfolio.some((item) => item.parcel_id === selectedParcel.parcel_id);
  }, [portfolio, selectedParcel]);

  const handleToggleBookmark = async () => {
    if (!selectedParcel) return;
    if (!user) {
      setAuthModalOpen(true);
      return;
    }

    setBookmarkSaving(true);
    setBookmarkFeedback(null);

    try {
      if (isSelectedBookmarked) {
        await removeParcelFromPortfolio(user, selectedParcel.parcel_id);
        setPortfolio((prev) =>
          prev.filter((item) => item.parcel_id !== selectedParcel.parcel_id)
        );
        setBookmarkFeedback("Removed from portfolio.");
      } else {
        const saved = await saveParcelToPortfolio(user, {
          parcel_id: selectedParcel.parcel_id,
          circle_rate: selectedParcel.circle_rate,
          risk_score: prediction?.risk_score ?? 0,
          risk_adjusted_valuation: prediction?.risk_adjusted_valuation ?? null,
          distance_to_hazard: selectedParcel.distance_to_hazard,
          longitude: selectedParcel.coordinates?.[0] ?? null,
          latitude: selectedParcel.coordinates?.[1] ?? null,
        });
        setPortfolio((prev) => [
          saved,
          ...prev.filter((item) => item.parcel_id !== saved.parcel_id),
        ]);
        setBookmarkFeedback("Saved to portfolio.");
      }
    } catch (err) {
      setBookmarkFeedback(err.message || "Unable to update portfolio.");
    } finally {
      setBookmarkSaving(false);
    }
  };

  const handleRemoveFromPortfolio = async (parcelId) => {
    if (!user) return;
    try {
      await removeParcelFromPortfolio(user, parcelId);
      setPortfolio((prev) => prev.filter((item) => item.parcel_id !== parcelId));
    } catch (err) {
      setPortfolioError(err.message || "Failed to remove saved parcel.");
    }
  };

  const handleInspectSavedParcel = (item) => {
    navigateView("map");
    const coords =
      item.longitude != null && item.latitude != null
        ? [Number(item.longitude), Number(item.latitude)]
        : INITIAL_CENTER;

    if (mapRef.current && item.longitude != null && item.latitude != null) {
      mapRef.current.flyTo({
        center: coords,
        zoom: 14.2,
        pitch: is3DTilt ? INITIAL_PITCH : 0,
        duration: 1100,
      });
    }

    handleParcelSelect(
      {
        parcel_id: item.parcel_id,
        circle_rate: Number(item.circle_rate ?? 0),
        distance_to_hazard: Number(item.distance_to_hazard ?? 250),
        coordinates: coords,
      },
      item.longitude != null && item.latitude != null
        ? { lng: coords[0], lat: coords[1] }
        : null
    );
  };

  const handleSignOut = async () => {
    await signOutUser();
    setUser(null);
    setPortfolio([]);
  };

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
  const spreadPercent =
    prediction?.circle_to_market_spread_pct != null
      ? Number(prediction.circle_to_market_spread_pct)
      : selectedParcel && prediction && selectedParcel.circle_rate > 0
      ? Number(
          (
            ((prediction.risk_adjusted_valuation - selectedParcel.circle_rate) /
              selectedParcel.circle_rate) *
            100
          ).toFixed(1)
        )
      : null;

  return (
    <div className="app-shell">
      {/* Full-Viewport 3D Mapbox Stage */}
      <main className={`map-stage ${activeView === "map" ? "" : "hidden-stage"}`}>
        <div ref={mapContainerRef} className="map-container" />

        <RegionSearchBar
          mapboxToken={MAPBOX_TOKEN}
          onSelectRegion={handleSelectRegion}
          parcelCount={bboxParcelCount}
          loadingParcels={loadingParcels}
          bboxError={bboxError}
          dockCollapsed={dockCollapsed}
        />

        <MapLayerControls
          baseStyle={baseStyle}
          onChangeBaseStyle={setBaseStyle}
          is3DTilt={is3DTilt}
          onToggle3DTilt={setIs3DTilt}
          show3DExtrusion={show3DExtrusion}
          onToggle3DExtrusion={setShow3DExtrusion}
          showChoropleth={showChoropleth}
          onToggleChoropleth={setShowChoropleth}
          choroplethOpacity={choroplethOpacity}
          onChangeOpacity={setChoroplethOpacity}
          ncrOverlays={ncrOverlays}
          onToggleNcrOverlay={handleToggleNcrOverlay}
          mapboxTokenPresent={Boolean(MAPBOX_TOKEN)}
        />
      </main>

      {/* Protected Saved Portfolio View */}
      {activeView === "portfolio" && (
        <PortfolioView
          user={user}
          portfolio={portfolio}
          loading={portfolioLoading}
          error={portfolioError}
          onOpenAuth={() => setAuthModalOpen(true)}
          onInspectParcel={handleInspectSavedParcel}
          onRemoveParcel={handleRemoveFromPortfolio}
          onBackToMap={() => navigateView("map")}
        />
      )}

      {/* Left Floating Glassmorphic Intelligence Dock */}
      <aside
        className={`floating-dock glass-surface ${
          dockCollapsed ? "is-collapsed" : ""
        }`}
      >
        <header className="dock-header">
          <div className="header-top-row">
            <div className="brand-cluster">
              <span className="brand-pill">GeoValue 2.0</span>
              <span className="live-pulse-tag">3D Spatial</span>
            </div>

            <div className="header-actions-row">
              {user ? (
                <div className="auth-user-pill">
                  <span className="mono">{user.email}</span>
                  <button type="button" onClick={handleSignOut}>
                    Out
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="auth-trigger-btn"
                  onClick={() => setAuthModalOpen(true)}
                >
                  Sign In
                </button>
              )}

              <button
                type="button"
                className="dock-collapse-btn"
                onClick={() => setDockCollapsed((prev) => !prev)}
                title={dockCollapsed ? "Expand panel" : "Collapse panel"}
                aria-expanded={!dockCollapsed}
              >
                {dockCollapsed ? "»" : "«"}
              </button>
            </div>
          </div>

          {!dockCollapsed && (
            <>
              <h1>Indian Land Intelligence</h1>
              <p className="subtitle">
                Delhi-NCR PostGIS parcels, Saaty AHP ₹/Gaj valuation, registry
                comps &amp; 10-year ARIMA-X forecasts.
              </p>
            </>
          )}

          <nav className="view-nav" aria-label="Primary Workspace Views">
            <button
              type="button"
              className={`view-nav-btn ${activeView === "map" ? "active" : ""}`}
              onClick={() => navigateView("map")}
            >
              3D Spatial Map
            </button>
            <button
              type="button"
              className={`view-nav-btn ${activeView === "portfolio" ? "active" : ""}`}
              onClick={() => navigateView("portfolio")}
            >
              Portfolio ({portfolio.length})
            </button>
          </nav>
        </header>

        {!dockCollapsed && (
          <div className="dock-scroll-body">
            {!MAPBOX_TOKEN && (
              <div className="notice-banner">
                <strong>Mapbox Token Missing:</strong> Set{" "}
                <code>VITE_MAPBOX_ACCESS_TOKEN</code> in <code>.env</code> for
                3D buildings &amp; Satellite HD imagery.
              </div>
            )}

            <section className="glass-card">
              <div className="panel-title-row">
                <h2>Selected Parcel</h2>
                {selectedParcel && (
                  <button
                    type="button"
                    className={`bookmark-btn ${isSelectedBookmarked ? "bookmarked" : ""}`}
                    onClick={handleToggleBookmark}
                    disabled={bookmarkSaving}
                  >
                    {bookmarkSaving
                      ? "Saving..."
                      : isSelectedBookmarked
                      ? "Bookmarked ✓"
                      : "+ Bookmark"}
                  </button>
                )}
              </div>

              {bookmarkFeedback && (
                <div className="bookmark-feedback">{bookmarkFeedback}</div>
              )}

              {!selectedParcel ? (
                <p className="empty-state">
                  Click any glowing parcel beacon/polygon on the map — or click
                  anywhere across Delhi, Noida, Gurgaon, Ghaziabad, or Faridabad
                  to inspect land instantaneously.
                </p>
              ) : (
                <>
                  <div className="metrics-grid">
                    <div className="metric-card">
                      <span className="metric-label">Parcel ID</span>
                      <strong className="metric-value mono">
                        {selectedParcel.parcel_id}
                      </strong>
                    </div>
                    <div className="metric-card">
                      <span className="metric-label">Official Circle Rate</span>
                      <strong className="metric-value">
                        {formatInrPerGaj(selectedParcel.circle_rate)}
                      </strong>
                    </div>
                    <div className="metric-card">
                      <span className="metric-label">Plot Area</span>
                      <strong className="metric-value">
                        {prediction?.plot_area_gaj ?? selectedParcel.plot_area_gaj ?? 250} Gaj (
                        {gajToSqm(prediction?.plot_area_gaj ?? selectedParcel.plot_area_gaj ?? 250)} m²)
                      </strong>
                    </div>
                    <div className="metric-card">
                      <span className="metric-label">Hazard Buffer</span>
                      <strong className="metric-value">
                        {selectedParcel.distance_to_hazard} m
                      </strong>
                    </div>
                    <div className="metric-card">
                      <span className="metric-label">Sub-Region</span>
                      <strong className="metric-value">
                        {selectedParcel.sub_region || "Delhi NCR"}
                      </strong>
                    </div>
                    <div className="metric-card">
                      <span className="metric-label">Coordinates</span>
                      <strong className="metric-value mono">
                        {selectedParcel.coordinates[1]}, {selectedParcel.coordinates[0]}
                      </strong>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="report-cta-btn"
                    onClick={() => setReportModalOpen(true)}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="16" y1="13" x2="8" y2="13" />
                      <line x1="16" y1="17" x2="8" y2="17" />
                    </svg>
                    <span>Generate 4-Page Senior GIS Report (150 Factors)</span>
                  </button>
                </>
              )}
            </section>

            <section className={`glass-card ${riskTier ? riskTier.cardGlow : ""}`}>
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
                  Running ensemble risk model &amp; ARIMA-X forecast...
                </div>
              )}

              {error && (
                <div className="status-box error-box">
                  <strong>Prediction Error:</strong> {error}
                </div>
              )}

              {!loading && !error && !prediction && (
                <p className="empty-state">
                  Select a parcel polygon to calculate climate risk &amp;
                  adjusted property value.
                </p>
              )}

              {!loading && !error && prediction && (
                <div className="risk-hero-row">
                  <RiskScoreRing score={prediction.risk_score} tier={riskTier} />

                  <div className="valuation-summary-box">
                    <span className="metric-label">AI Fair Market Rate</span>
                    <strong className="valuation-number">
                      {formatInrPerGaj(prediction.risk_adjusted_valuation)}
                    </strong>
                    <span className="total-plot-value-tag">
                      Total Plot:{" "}
                      <strong>
                        {formatInrLakhCrore(prediction.total_plot_valuation_inr)}
                      </strong>
                    </span>
                    {spreadPercent !== null && (
                      <span className="discount-note">
                        {spreadPercent >= 0 ? `+${spreadPercent}%` : `${spreadPercent}%`} vs Official Circle Rate
                      </span>
                    )}
                  </div>
                </div>
              )}
            </section>

            {prediction?.explainable_breakdown && (
              <section className="glass-card explain-card">
                <div className="panel-title-row">
                  <h2>Explainable AI: Why This Price?</h2>
                  <span className="ahp-cr-badge mono" title="Saaty AHP Consistency Ratio">
                    CR = {prediction.ahp_consistency_ratio} &lt; 0.10
                  </span>
                </div>

                <div className="explain-ledger-list">
                  {prediction.explainable_breakdown.map((item) => {
                    const isPos = item.adjustment_per_gaj >= 0;
                    return (
                      <div key={item.criterion} className="explain-ledger-row">
                        <div className="explain-row-left">
                          <span className="explain-criterion">
                            {item.criterion}{" "}
                            <em className="mono">({item.ahp_weight_pct}%)</em>
                          </span>
                          <span className="explain-signal">{item.signal}</span>
                        </div>
                        <strong
                          className={`explain-delta mono ${
                            isPos ? "delta-pos" : "delta-neg"
                          }`}
                        >
                          {isPos ? "+" : ""}
                          {formatInrPerGaj(item.adjustment_per_gaj)}
                        </strong>
                      </div>
                    );
                  })}
                </div>

                {Array.isArray(prediction.comparable_registries) &&
                  prediction.comparable_registries.length > 0 && (
                    <div className="comps-preview-block">
                      <span className="metric-label">
                        Aas-Paas Ki Registry (Recent Sales)
                      </span>
                      <div className="comps-mini-list">
                        {prediction.comparable_registries.slice(0, 3).map((comp) => (
                          <div key={comp.deed_id} className="comp-mini-row">
                            <span className="mono">
                              {comp.deed_id} • {comp.distance_m}m
                            </span>
                            <strong className="mono">
                              {formatInrPerGaj(comp.rate_per_gaj)} ({comp.quarter})
                            </strong>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                {Array.isArray(prediction.policy_catalysts) &&
                  prediction.policy_catalysts.length > 0 && (
                    <div className="policy-catalyst-chip">
                      <span>Govt Catalyst:</span>
                      <strong>
                        {prediction.policy_catalysts[0].name} (
                        {prediction.policy_catalysts[0].estimated_uplift})
                      </strong>
                    </div>
                  )}
              </section>
            )}

            <section className="glass-card scenario-panel">
              <div className="panel-title-row">
                <h2>ARIMA-X Forecast</h2>
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
                  Select a parcel to render 3Y / 5Y / 10Y trajectories across
                  Baseline, Infra-Accelerated, and Adverse-Risk scenarios.
                </p>
              ) : (
                <>
                  <div className="chart-container">
                    <ResponsiveContainer width="100%" height={205}>
                      <LineChart
                        data={chartData}
                        margin={{ top: 10, right: 10, left: 2, bottom: 2 }}
                      >
                        <defs>
                          <linearGradient id="gradBaseline" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="#38bdf8" />
                            <stop offset="100%" stopColor="#06b6d4" />
                          </linearGradient>
                          <linearGradient id="gradInfra" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="#10b981" />
                            <stop offset="100%" stopColor="#4ade80" />
                          </linearGradient>
                          <linearGradient id="gradRisk" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="#f59e0b" />
                            <stop offset="100%" stopColor="#f43f5e" />
                          </linearGradient>
                        </defs>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="rgba(148, 163, 184, 0.12)"
                        />
                        <XAxis dataKey="year" stroke="#94a3b8" fontSize={11} />
                        <YAxis
                          stroke="#94a3b8"
                          fontSize={11}
                          width={64}
                          tickFormatter={formatInrLakhCrore}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "rgba(11, 15, 25, 0.95)",
                            borderColor: "rgba(56, 189, 248, 0.35)",
                            borderRadius: "10px",
                            fontSize: "12px",
                            backdropFilter: "blur(12px)",
                          }}
                          formatter={(value) => formatInrPerGaj(Number(value))}
                        />
                        <Legend wrapperStyle={{ fontSize: "11px" }} />
                        <Line
                          type="monotone"
                          dataKey="Baseline"
                          name="Conservative Base"
                          stroke="url(#gradBaseline)"
                          strokeWidth={2.5}
                          dot={{ r: 2.5, fill: "#38bdf8" }}
                          activeDot={{ r: 5 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="Infra"
                          name="Policy Catalyst"
                          stroke="url(#gradInfra)"
                          strokeWidth={2.5}
                          dot={{ r: 2.5, fill: "#10b981" }}
                          activeDot={{ r: 5 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="Risk"
                          name="Adverse Hazard"
                          stroke="url(#gradRisk)"
                          strokeWidth={2.5}
                          dot={{ r: 2.5, fill: "#f43f5e" }}
                          activeDot={{ r: 5 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  {terminalSnapshot && (
                    <div className="scenario-summary-grid">
                      <div className="scenario-chip chip-baseline">
                        <span>Y{forecastHorizon} Base</span>
                        <strong>{formatInrLakhCrore(terminalSnapshot.Baseline)}/Gaj</strong>
                      </div>
                      <div className="scenario-chip chip-infra">
                        <span>Y{forecastHorizon} Policy</span>
                        <strong>{formatInrLakhCrore(terminalSnapshot.Infra)}/Gaj</strong>
                      </div>
                      <div className="scenario-chip chip-risk">
                        <span>Y{forecastHorizon} Risk</span>
                        <strong>{formatInrLakhCrore(terminalSnapshot.Risk)}/Gaj</strong>
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>

            <footer className="legend">
              <div className="legend-header">
                <span>Risk Gradient</span>
                <span className="mono">SRID 4326 → 3857</span>
              </div>
              <div className="legend-bar" />
              <div className="legend-labels">
                <span>0 Emerald</span>
                <span>50 Amber</span>
                <span>100 Crimson</span>
              </div>
            </footer>
          </div>
        )}
      </aside>

      <AIChatWidget
        nodeApiUrl={NODE_API_URL}
        riskApiUrl={RISK_API_URL}
        selectedParcel={selectedParcel}
        prediction={prediction}
      />

      <AuthModal
        isOpen={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        onAuthenticated={(authedUser) => setUser(authedUser)}
      />

      <GISReportModal
        isOpen={reportModalOpen}
        onClose={() => setReportModalOpen(false)}
        selectedParcel={selectedParcel}
        prediction={prediction}
      />
    </div>
  );
}
