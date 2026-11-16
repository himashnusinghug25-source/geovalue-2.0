import { useEffect, useRef, useState } from "react";
import axios from "axios";

const CITY_PRESETS = [
  {
    id: "preset-noida-128",
    name: "Noida Sector 128, Uttar Pradesh",
    shortName: "Noida Sec 128",
    center: [77.3513, 28.5112],
    bbox: [77.335, 28.498, 77.368, 28.524],
    zoom: 14.2,
  },
  {
    id: "preset-delhi",
    name: "New Delhi, Delhi NCR",
    shortName: "Delhi",
    center: [77.209, 28.6139],
    bbox: [77.12, 28.54, 77.29, 28.68],
    zoom: 12.4,
  },
  {
    id: "preset-gurgaon",
    name: "Gurugram (Gurgaon), Haryana",
    shortName: "Gurgaon",
    center: [77.0266, 28.4595],
    bbox: [76.95, 28.40, 77.11, 28.52],
    zoom: 12.5,
  },
  {
    id: "preset-ghaziabad",
    name: "Ghaziabad, Uttar Pradesh",
    shortName: "Ghaziabad",
    center: [77.4538, 28.6692],
    bbox: [77.36, 28.61, 77.52, 28.72],
    zoom: 12.5,
  },
  {
    id: "preset-faridabad",
    name: "Faridabad, Haryana",
    shortName: "Faridabad",
    center: [77.3178, 28.4089],
    bbox: [77.25, 28.35, 77.39, 28.46],
    zoom: 12.5,
  },
];

export default function RegionSearchBar({
  mapboxToken,
  onSelectRegion,
  parcelCount,
  loadingParcels,
  bboxError,
  dockCollapsed,
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    const handleOutsideClick = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setDropdownOpen(false);
      }
    };
    const handleShortcut = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleShortcut);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleShortcut);
    };
  }, []);

  const runGeocodeSearch = async (text) => {
    const trimmed = text.trim();
    if (!trimmed) {
      setResults([]);
      setSearchError(null);
      return;
    }

    const presetMatches = CITY_PRESETS.filter(
      (city) =>
        city.name.toLowerCase().includes(trimmed.toLowerCase()) ||
        city.shortName.toLowerCase().includes(trimmed.toLowerCase())
    );

    if (!mapboxToken) {
      setResults(presetMatches);
      if (presetMatches.length === 0) {
        setSearchError(
          "Set VITE_MAPBOX_ACCESS_TOKEN for global geocoding, or choose Noida Sec 128, Delhi, Gurgaon, Ghaziabad, or Faridabad."
        );
      } else {
        setSearchError(null);
      }
      setDropdownOpen(true);
      return;
    }

    setSearching(true);
    setSearchError(null);

    try {
      const endpoint = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
        trimmed
      )}.json`;
      const { data } = await axios.get(endpoint, {
        params: {
          access_token: mapboxToken,
          limit: 5,
          types: "place,locality,district,region,neighborhood",
        },
      });

      const mapped = (data?.features || []).map((feat) => {
        const [lon, lat] = feat.center || [77.209, 28.6139];
        const bbox =
          Array.isArray(feat.bbox) && feat.bbox.length === 4
            ? feat.bbox
            : [lon - 0.08, lat - 0.06, lon + 0.08, lat + 0.06];
        return {
          id: feat.id,
          name: feat.place_name,
          shortName: feat.text,
          center: [lon, lat],
          bbox,
          zoom: 12.2,
        };
      });

      const merged = [
        ...presetMatches,
        ...mapped.filter(
          (m) =>
            !presetMatches.some(
              (p) => p.shortName.toLowerCase() === m.shortName.toLowerCase()
            )
        ),
      ].slice(0, 6);

      setResults(merged);
      setDropdownOpen(true);
    } catch (err) {
      setResults(presetMatches);
      setSearchError(
        err.response?.data?.message || "Mapbox geocoding request failed."
      );
      setDropdownOpen(true);
    } finally {
      setSearching(false);
    }
  };

  const handleInputChange = (e) => {
    const nextValue = e.target.value;
    setQuery(nextValue);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      runGeocodeSearch(nextValue);
    }, 280);
  };

  const handleChooseRegion = (region) => {
    setQuery(region.shortName || region.name);
    setDropdownOpen(false);
    setSearchError(null);
    onSelectRegion(region);
  };

  const handleFormSubmit = async (e) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    await runGeocodeSearch(query);
  };

  return (
    <div
      className={`region-search-wrapper ${dockCollapsed ? "dock-is-collapsed" : ""}`}
      ref={containerRef}
    >
      <form className="region-search-bar glass-surface" onSubmit={handleFormSubmit}>
        <span className="search-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
          </svg>
        </span>

        <input
          ref={inputRef}
          type="text"
          className="region-search-input"
          placeholder="Search city or coordinates (Delhi, Gurgaon, Noida...)"
          value={query}
          onChange={handleInputChange}
          onFocus={() => {
            if (results.length > 0) setDropdownOpen(true);
          }}
          aria-label="Search region"
        />

        {query && (
          <button
            type="button"
            className="search-clear-btn"
            onClick={() => {
              setQuery("");
              setResults([]);
              setDropdownOpen(false);
              setSearchError(null);
            }}
            aria-label="Clear search"
          >
            ✕
          </button>
        )}

        <kbd className="shortcut-kbd" title="Focus search (Cmd+K / Ctrl+K)">
          ⌘K
        </kbd>

        <button
          type="submit"
          className="region-search-btn"
          disabled={searching}
        >
          {searching ? "..." : "Fly"}
        </button>
      </form>

      <div className="region-presets-row">
        {CITY_PRESETS.map((city) => (
          <button
            key={city.id}
            type="button"
            className="preset-pill"
            onClick={() => handleChooseRegion(city)}
          >
            <span className="preset-dot" />
            {city.shortName}
          </button>
        ))}

        <span className={`bbox-status-pill ${loadingParcels ? "is-loading" : ""}`}>
          <span className="telemetry-dot" />
          {loadingParcels
            ? "Scanning PostGIS bbox..."
            : parcelCount !== null
            ? `${parcelCount} parcels loaded`
            : "PostGIS MVT live"}
        </span>
      </div>

      {(searchError || bboxError) && (
        <div className="search-feedback-error">
          {searchError || bboxError}
        </div>
      )}

      {dropdownOpen && results.length > 0 && (
        <ul className="region-dropdown glass-surface" role="listbox">
          {results.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="region-dropdown-item"
                onClick={() => handleChooseRegion(item)}
              >
                <span className="pin-icon" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 21s-6-5.686-6-10a6 6 0 1112 0c0 4.314-6 10-6 10z" />
                    <circle cx="12" cy="11" r="2" />
                  </svg>
                </span>
                <span className="region-item-text">
                  <span className="region-item-title">{item.shortName}</span>
                  <span className="region-item-sub">{item.name}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
