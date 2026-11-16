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
import MapLayerControls from "./components/MapLayerControls.jsx";
import PortfolioView from "./components/PortfolioView.jsx";
import RegionSearchBar from "./components/RegionSearchBar.jsx";
import {
  fetchSavedPortfolio,
  getCurrentSessionUser,
  removeParcelFromPortfolio,
  saveParcelToPortfolio,
  signOutUser,
  subscribeToAuthChanges,
} from "./lib/supabaseClient.js";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN || "";
const NODE_API_URL = import.meta.env.VITE_NODE_API_URL || "http://localhost:3000";
const RISK_API_URL = import.meta.env.VITE_RISK_API_URL || "http://localhost:8000";

const INITIAL_CENTER = [77.209, 28.6139];
const INITIAL_ZOOM = 12.2;
const INITIAL_PITCH = 52;
const INITIAL_BEARING = -18;
const HORIZON_OPTIONS = [3, 5, 10];
const EMPTY_FC = { type: "FeatureCollection", features: [] };

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

  addRow("Circle Rate", formatCurrency(circleRate));
  addRow("Hazard Distance", `${distanceToHazard} m`);

  if (loading) {
    const status = document.createElement("div");
    status.className = "map-popup-status";
    status.textContent = "Computing ML risk & 10Y ARIMA-X...";
    container.appendChild(status);
  } else if (error) {
    const errEl = document.createElement("div");
    errEl.className = "map-popup-error";
    errEl.textContent = error;
    container.appendChild(errEl);
  } else if (prediction) {
    addRow("Risk Score", `${prediction.risk_score} / 100`);
    addRow("Adjusted Value", formatCurrency(prediction.risk_adjusted_valuation));
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
  const activeStyleRef = useRef("dark");

  const [activeView, setActiveView] = useState(() =>
    window.location.hash === "#portfolio" ? "portfolio" : "map"
  );
  const [dockCollapsed, setDockCollapsed] = useState(false);

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
  const evaluateParcel = useCallback(async (parcelInfo, lngLatForPopup) => {
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

  const evaluateParcelRef = useRef(evaluateParcel);
  useEffect(() => {
    evaluateParcelRef.current = evaluateParcel;
  }, [evaluateParcel]);

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
        tiles: [`${NODE_API_URL}/api/tiles/{z}/{x}/{y}.pbf`],
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
        "source-layer": "municipal_parcels",
        paint: {
          "line-color": RISK_CHOROPLETH_COLOR,
          "line-width": 4.5,
          "line-blur": 3.5,
          "line-opacity": 0.42,
        },
      });
    }

    if (!map.getLayer("municipal-parcels-outline")) {
      map.addLayer({
        id: "municipal-parcels-outline",
        type: "line",
        source: "municipal-parcels",
        "source-layer": "municipal_parcels",
        paint: {
          "line-color": "#67e8f9",
          "line-width": 1.35,
          "line-opacity": 0.85,
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
        layout: { visibility: choroplethVis },
        paint: {
          "fill-color": RISK_CHOROPLETH_COLOR,
          "fill-opacity": Math.min(0.95, fillOpacity + 0.1),
        },
      });
    }

    if (!map.getLayer("bbox-parcels-extrusion")) {
      map.addLayer({
        id: "bbox-parcels-extrusion",
        type: "fill-extrusion",
        source: "bbox-parcels",
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
        paint: {
          "line-color": "#22d3ee",
          "line-width": 5,
          "line-blur": 4,
          "line-opacity": 0.45,
        },
      });
    }

    if (!map.getLayer("bbox-parcels-outline")) {
      map.addLayer({
        id: "bbox-parcels-outline",
        type: "line",
        source: "bbox-parcels",
        paint: {
          "line-color": "#38bdf8",
          "line-width": 1.65,
          "line-opacity": 0.95,
        },
      });
    }
  }, []);

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

    map.on("style.load", () => {
      ensureParcelLayers(map);
    });

    const getInteractiveLayers = () =>
      [
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
        map.getCanvas().style.cursor = hits.length > 0 ? "pointer" : "";
      });
    });

    map.on("click", (e) => {
      const layers = getInteractiveLayers();
      if (layers.length === 0) return;
      const hits = map.queryRenderedFeatures(e.point, { layers });
      const feature = hits[0];
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

      evaluateParcelRef.current(parcelInfo, e.lngLat);
    });

    return () => {
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
  }, [ensureParcelLayers]);

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

      setLoadingParcels(true);
      try {
        const { data } = await axios.get(`${NODE_API_URL}/api/parcels/bbox`, {
          params: {
            minLon: bbox[0],
            minLat: bbox[1],
            maxLon: bbox[2],
            maxLat: bbox[3],
          },
        });

        const fc =
          data && data.type === "FeatureCollection" ? data : EMPTY_FC;
        bboxGeoJsonRef.current = fc;
        setBboxParcelCount(fc.features.length);

        const bboxSource = map?.getSource("bbox-parcels");
        if (bboxSource) {
          bboxSource.setData(fc);
        }
      } catch (err) {
        setBboxError(
          err.response?.data?.error ||
            "Could not fetch bounding-box parcels from Node API."
        );
      } finally {
        setLoadingParcels(false);
      }
    },
    [is3DTilt, navigateView]
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

    evaluateParcel(
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
  const discountPercent =
    selectedParcel && prediction && selectedParcel.circle_rate > 0
      ? (
          ((selectedParcel.circle_rate - prediction.risk_adjusted_valuation) /
            selectedParcel.circle_rate) *
          100
        ).toFixed(1)
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
              <h1>Climate Risk Intelligence</h1>
              <p className="subtitle">
                Real-time PostGIS 3D parcel risk telemetry, ML valuation, and
                10-year ARIMA-X trajectories.
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
                  Click any glowing 3D parcel on the map or search Delhi,
                  Gurgaon, or Noida to run valuation analytics.
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
                    <span className="metric-label">Circle Rate</span>
                    <strong className="metric-value">
                      {formatCurrency(selectedParcel.circle_rate)}
                    </strong>
                  </div>
                  <div className="metric-card">
                    <span className="metric-label">Hazard Buffer</span>
                    <strong className="metric-value">
                      {selectedParcel.distance_to_hazard} m
                    </strong>
                  </div>
                  <div className="metric-card">
                    <span className="metric-label">Coordinates</span>
                    <strong className="metric-value mono">
                      {selectedParcel.coordinates[1]}, {selectedParcel.coordinates[0]}
                    </strong>
                  </div>
                </div>
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
                    <span className="metric-label">Risk-Adjusted Value</span>
                    <strong className="valuation-number">
                      {formatCurrency(prediction.risk_adjusted_valuation)}
                    </strong>
                    {discountPercent !== null && (
                      <span className="discount-note">
                        -{discountPercent}% climate risk haircut
                      </span>
                    )}
                  </div>
                </div>
              )}
            </section>

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
                          width={60}
                          tickFormatter={formatCompactCurrency}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "rgba(11, 15, 25, 0.95)",
                            borderColor: "rgba(56, 189, 248, 0.35)",
                            borderRadius: "10px",
                            fontSize: "12px",
                            backdropFilter: "blur(12px)",
                          }}
                          formatter={(value) => formatCurrency(Number(value))}
                        />
                        <Legend wrapperStyle={{ fontSize: "11px" }} />
                        <Line
                          type="monotone"
                          dataKey="Baseline"
                          name="Baseline"
                          stroke="url(#gradBaseline)"
                          strokeWidth={2.5}
                          dot={{ r: 2.5, fill: "#38bdf8" }}
                          activeDot={{ r: 5 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="Infra"
                          name="Infra (+15-20%)"
                          stroke="url(#gradInfra)"
                          strokeWidth={2.5}
                          dot={{ r: 2.5, fill: "#10b981" }}
                          activeDot={{ r: 5 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="Risk"
                          name="Adverse Risk"
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
    </div>
  );
}
