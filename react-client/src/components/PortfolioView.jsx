import {
  formatInrLakhCrore,
  formatInrPerGaj,
  gajToSqm,
} from "../lib/formatInr.js";

function getRiskTier(score) {
  if (score >= 75) return { label: "Critical", className: "badge-critical", cardClass: "glow-critical" };
  if (score >= 50) return { label: "High", className: "badge-high", cardClass: "glow-high" };
  if (score >= 25) return { label: "Moderate", className: "badge-moderate", cardClass: "glow-moderate" };
  return { label: "Low", className: "badge-low", cardClass: "glow-low" };
}

export default function PortfolioView({
  user,
  portfolio,
  loading,
  error,
  onOpenAuth,
  onInspectParcel,
  onRemoveParcel,
  onBackToMap,
}) {
  if (!user) {
    return (
      <main className="portfolio-stage">
        <div className="portfolio-gate-card glass-surface">
          <span className="brand-pill">Protected Vault</span>
          <h2>Sign In to Access Saved Portfolios</h2>
          <p>
            Your bookmarked NCR land parcels, AHP valuations (₹/Gaj), and
            10-year forecasts are protected by Supabase Row Level Security.
          </p>
          <div className="gate-actions">
            <button type="button" className="primary-btn" onClick={onOpenAuth}>
              Sign In / Create Account
            </button>
            <button type="button" className="secondary-btn" onClick={onBackToMap}>
              Return to 3D Map
            </button>
          </div>
        </div>
      </main>
    );
  }

  const totalBaseValue = portfolio.reduce((sum, item) => {
    const areaGaj = Number(item.plot_area_gaj) || 250;
    return sum + (Number(item.circle_rate) || 0) * areaGaj;
  }, 0);

  const totalAdjustedValue = portfolio.reduce((sum, item) => {
    const areaGaj = Number(item.plot_area_gaj) || 250;
    const rate = Number(item.risk_adjusted_valuation ?? item.circle_rate) || 0;
    return sum + rate * areaGaj;
  }, 0);

  const avgRisk =
    portfolio.length > 0
      ? (
          portfolio.reduce((sum, item) => sum + (Number(item.risk_score) || 0), 0) /
          portfolio.length
        ).toFixed(1)
      : "0.0";

  return (
    <main className="portfolio-stage">
      <div className="portfolio-container">
        <header className="portfolio-header glass-surface">
          <div>
            <span className="brand-pill">Asset Portfolio</span>
            <h2>Bookmarked NCR Land Parcels</h2>
            <p className="subtitle">
              Authenticated analyst: <strong className="mono">{user.email}</strong>
            </p>
          </div>
          <button type="button" className="secondary-btn" onClick={onBackToMap}>
            ← Return to 3D Spatial Map
          </button>
        </header>

        <div className="portfolio-stats-grid">
          <div className="highlight-card glass-surface">
            <span className="metric-label">Saved Properties</span>
            <strong className="score-number">{portfolio.length}</strong>
          </div>
          <div className="highlight-card glass-surface">
            <span className="metric-label">Avg Climate Risk</span>
            <strong className="score-number">{avgRisk} / 100</strong>
          </div>
          <div className="highlight-card glass-surface">
            <span className="metric-label">Circle Benchmark Total</span>
            <strong className="valuation-number">
              {formatInrLakhCrore(totalBaseValue)}
            </strong>
          </div>
          <div className="highlight-card glass-surface">
            <span className="metric-label">AHP Market Portfolio</span>
            <strong className="valuation-number">
              {formatInrLakhCrore(totalAdjustedValue)}
            </strong>
          </div>
        </div>

        {loading && (
          <div className="status-box loading-box">
            Syncing saved parcels from Supabase portfolio...
          </div>
        )}

        {error && (
          <div className="status-box error-box">
            <strong>Portfolio Error:</strong> {error}
          </div>
        )}

        {!loading && portfolio.length === 0 && (
          <div className="portfolio-empty-card glass-surface">
            <h3>No Properties Bookmarked Yet</h3>
            <p>
              Select any parcel on the 3D Map and click{" "}
              <strong>+ Bookmark</strong> to track its ₹/Gaj valuation and AHP
              risk score.
            </p>
            <button type="button" className="primary-btn" onClick={onBackToMap}>
              Explore Parcels on 3D Map
            </button>
          </div>
        )}

        {!loading && portfolio.length > 0 && (
          <div className="portfolio-cards-grid">
            {portfolio.map((item) => {
              const riskScore = Number(item.risk_score ?? 0);
              const tier = getRiskTier(riskScore);
              const areaGaj = Number(item.plot_area_gaj) || 250;
              const marketRate = Number(item.risk_adjusted_valuation ?? item.circle_rate);
              const totalPlotValue = marketRate * areaGaj;

              return (
                <article
                  key={item.parcel_id}
                  className={`portfolio-item-card glass-surface ${tier.cardClass}`}
                >
                  <div className="panel-title-row">
                    <strong className="mono portfolio-parcel-id">
                      Parcel {item.parcel_id}
                    </strong>
                    <span className={`risk-badge ${tier.className}`}>
                      {tier.label} ({riskScore})
                    </span>
                  </div>

                  <div className="portfolio-metrics">
                    <div>
                      <span className="metric-label">Govt Circle Rate</span>
                      <strong>{formatInrPerGaj(Number(item.circle_rate))}</strong>
                    </div>
                    <div>
                      <span className="metric-label">AI Market Rate</span>
                      <strong className="accent-text">
                        {formatInrPerGaj(marketRate)}
                      </strong>
                    </div>
                    <div>
                      <span className="metric-label">Total Est. Value</span>
                      <strong>{formatInrLakhCrore(totalPlotValue)}</strong>
                    </div>
                    <div>
                      <span className="metric-label">Plot Area / Buffer</span>
                      <strong>
                        {areaGaj} Gaj ({gajToSqm(areaGaj)} m²)
                        {item.distance_to_hazard != null
                          ? ` • ${item.distance_to_hazard}m`
                          : ""}
                      </strong>
                    </div>
                  </div>

                  <div className="portfolio-item-actions">
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => onInspectParcel(item)}
                    >
                      Fly to 3D Parcel
                    </button>
                    <button
                      type="button"
                      className="danger-btn"
                      onClick={() => onRemoveParcel(item.parcel_id)}
                    >
                      Remove
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
