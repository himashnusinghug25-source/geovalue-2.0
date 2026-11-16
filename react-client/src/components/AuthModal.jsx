import { useState } from "react";
import {
  isSupabaseConfigured,
  signInWithEmail,
  signInWithGoogle,
  signUpWithEmail,
} from "../lib/supabaseClient";

export default function AuthModal({ isOpen, onClose, onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  if (!isOpen) return null;

  const supabaseActive = isSupabaseConfigured();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setInfo(null);

    try {
      if (mode === "login") {
        const user = await signInWithEmail(email, password);
        onAuthenticated(user);
        onClose();
      } else {
        const result = await signUpWithEmail(email, password);
        if (result.needsConfirmation) {
          setInfo(
            "Check your inbox to confirm your email before signing in."
          );
        } else {
          onAuthenticated(result.user);
          onClose();
        }
      }
    } catch (err) {
      setError(err.message || "Authentication failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleLogin = async () => {
    setSubmitting(true);
    setError(null);
    setInfo(null);
    try {
      const user = await signInWithGoogle();
      if (user) {
        onAuthenticated(user);
        onClose();
      }
    } catch (err) {
      setError(err.message || "Google sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="auth-modal glass-surface">
        <div className="auth-modal-header">
          <div>
            <span className="brand-pill">Portfolio Vault</span>
            <h2>{mode === "login" ? "Sign In to GeoValue" : "Create Account"}</h2>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        {!supabaseActive && (
          <div className="notice-banner">
            <strong>Local Demo Auth Mode:</strong> Configure{" "}
            <code>VITE_SUPABASE_URL</code> and{" "}
            <code>VITE_SUPABASE_ANON_KEY</code> for live Supabase Auth.
            Local sessions persist bookmarks via Node.js/PostgreSQL.
          </div>
        )}

        <div className="auth-mode-tabs">
          <button
            type="button"
            className={`auth-tab ${mode === "login" ? "active" : ""}`}
            onClick={() => {
              setMode("login");
              setError(null);
              setInfo(null);
            }}
          >
            Email Sign In
          </button>
          <button
            type="button"
            className={`auth-tab ${mode === "signup" ? "active" : ""}`}
            onClick={() => {
              setMode("signup");
              setError(null);
              setInfo(null);
            }}
          >
            Sign Up
          </button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-field">
            <span>Email Address</span>
            <input
              type="email"
              required
              placeholder="analyst@geovalue.io"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          <label className="auth-field">
            <span>Password</span>
            <input
              type="password"
              required
              minLength={6}
              placeholder="At least 6 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && <div className="status-box error-box">{error}</div>}
          {info && <div className="status-box loading-box">{info}</div>}

          <button
            type="submit"
            className="primary-btn"
            disabled={submitting}
          >
            {submitting
              ? "Authenticating..."
              : mode === "login"
              ? "Sign In"
              : "Create Account"}
          </button>
        </form>

        <div className="auth-divider">
          <span>or</span>
        </div>

        <button
          type="button"
          className="google-btn"
          onClick={handleGoogleLogin}
          disabled={submitting}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="#EA4335"
              d="M12 10.2v3.9h5.4c-.2 1.2-1.4 3.6-5.4 3.6-3.2 0-5.9-2.7-5.9-6s2.7-6 5.9-6c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.2 14.6 2.2 12 2.2 6.6 2.2 2.2 6.6 2.2 12s4.4 9.8 9.8 9.8c5.6 0 9.4-4 9.4-9.5 0-.6-.1-1.1-.2-1.6H12z"
            />
          </svg>
          <span>Continue with Google</span>
        </button>
      </div>
    </div>
  );
}
