import { useEffect, useRef, useState } from "react";

const SCRIPT_ID = "google-maps-3d-script";
const GOOGLE_MAPS_SCRIPT = "https://maps.googleapis.com/maps/api/js";

function loadGoogleMaps3D(apiKey) {
  if (customElements.get("gmp-map-3d")) return Promise.resolve();

  const existingScript = document.getElementById(SCRIPT_ID);
  if (existingScript) {
    return new Promise((resolve, reject) => {
      existingScript.addEventListener("load", resolve, { once: true });
      existingScript.addEventListener("error", reject, { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = `${GOOGLE_MAPS_SCRIPT}?key=${encodeURIComponent(
      apiKey
    )}&v=alpha&libraries=maps3d`;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Google 3D Maps failed to load."));
    document.head.appendChild(script);
  });
}

function formatCenter(center) {
  const [longitude, latitude] = center;
  return `${latitude},${longitude},0`;
}

export default function Google3DMap({ apiKey, center, zoom = 12 }) {
  const mapRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let mounted = true;
    loadGoogleMaps3D(apiKey)
      .then(() => {
        if (mounted) setMapReady(true);
      })
      .catch((error) => {
        if (mounted) setLoadError(error.message);
      });

    return () => {
      mounted = false;
    };
  }, [apiKey]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    map.setAttribute("center", formatCenter(center));
    map.setAttribute("range", String(Math.max(450, 4800 - zoom * 260)));
    map.setAttribute("tilt", "62");
    map.setAttribute("heading", "24");
  }, [center, mapReady, zoom]);

  return (
    <div className="google-3d-map-shell" aria-label="Photorealistic 3D map">
      {!mapReady && !loadError && (
        <div className="google-3d-loading">
          <span className="google-3d-loading-orb" />
          <span>Loading photorealistic city model</span>
        </div>
      )}
      {loadError && (
        <div className="google-3d-error" role="status">
          {loadError} Add a valid VITE_GOOGLE_MAPS_API_KEY to enable 3D mode.
        </div>
      )}
      {mapReady && (
        <gmp-map-3d
          ref={mapRef}
          mode="hybrid"
          center={formatCenter(center)}
          range={String(Math.max(450, 4800 - zoom * 260))}
          tilt="62"
          heading="24"
        />
      )}
      <div className="google-3d-hud" aria-hidden="true">
        <span className="hud-live-dot" />
        <span>Photorealistic 3D</span>
      </div>
    </div>
  );
}
