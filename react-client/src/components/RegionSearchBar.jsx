import { useEffect, useRef, useState } from "react";
import axios from "axios";

const CITY_PRESETS = [
  {
    id: "preset-delhi",
    name: "New Delhi, Delhi NCR",
    shortName: "Delhi",
    center: [77.209, 28.6139],
    bbox: [77.08, 28.5, 77.32, 28.72],
    zoom: 12.2,
  },
  {
    id: "preset-gurgaon",
    name: "Gurugram (Gurgaon), Haryana",
    shortName: "Gurgaon",
    center: [77.0266, 28.4595],
    bbox: [76.92, 28.38, 77.14, 28.53],
    zoom: 12.3,
  },
  {
    id: "preset-noida",
    name: "Noida, Uttar Pradesh",
    shortName: "Noida",
    center: [77.391, 28.5355],
    bbox: [77.29, 28.46, 77.49, 28.63],
    zoom: 12.3,
  },
];

export default function RegionSearchBar({
  mapboxToken,
  onSelectRegion,
  parcelCount,
  loadingParcels,
  bboxError,
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const containerRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    const handleOutsideClick = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
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
          "Set VITE_MAPBOX_ACCESS_TOKEN for global geocoding, or choose Delhi, Gurgaon, or Noida."
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
    }, 300);
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
    <div className="region-search-wrapper" ref={containerRef}>
      <form className="region-search-bar" onSubmit={handleFormSubmit}>
        <input
          type="text"
          className="region-search-input"
          placeholder="Search city or region (Delhi, Gurgaon, Noida...)"
          value={query}
          onChange={handleInputChange}
          onFocus={() => {
            if (results.length > 0) setDropdownOpen(true);
          }}
          aria-label="Search region"
        />
        <button
          type="submit"
          className="region-search-btn"
          disabled={searching}
        >
          {searching ? "..." : "Go"}
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
            {city.shortName}
          </button>
        ))}

        <span className="bbox-status-pill">
          {loadingParcels
            ? "Loading parcels..."
            : parcelCount !== null
            ? `${parcelCount} parcels in view`
            : "Vector tiles live"}
        </span>
      </div>

      {(searchError || bboxError) && (
        <div className="search-feedback-error">
          {searchError || bboxError}
        </div>
      )}

      {dropdownOpen && results.length > 0 && (
        <ul className="region-dropdown" role="listbox">
          {results.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="region-dropdown-item"
                onClick={() => handleChooseRegion(item)}
              >
                <span className="region-item-title">{item.shortName}</span>
                <span className="region-item-sub">{item.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
