import { createClient } from "@supabase/supabase-js";
import axios from "axios";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const RAW_NODE_API_URL =
  import.meta.env.VITE_NODE_API_URL || import.meta.env.VITE_API_BASE_URL || "";
const NODE_API_URL =
  !RAW_NODE_API_URL ||
  RAW_NODE_API_URL.includes("localhost") ||
  RAW_NODE_API_URL.includes("127.0.0.1")
    ? ""
    : RAW_NODE_API_URL;

const LOCAL_SESSION_KEY = "geovalue_local_user";
const LOCAL_PORTFOLIO_KEY = "geovalue_local_portfolio";

const hasValidSupabaseConfig =
  Boolean(SUPABASE_URL) &&
  Boolean(SUPABASE_ANON_KEY) &&
  SUPABASE_URL.startsWith("http") &&
  !SUPABASE_URL.includes("your-project-ref") &&
  !SUPABASE_ANON_KEY.includes("your_supabase_anon_key");

export const supabase = hasValidSupabaseConfig
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

export function isSupabaseConfigured() {
  return Boolean(supabase);
}

const localAuthListeners = new Set();

function notifyLocalAuth(user) {
  localAuthListeners.forEach((cb) => {
    try {
      cb(user);
    } catch {
      // ignore subscriber errors
    }
  });
}

function readLocalUser() {
  try {
    const raw = window.localStorage.getItem(LOCAL_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLocalUser(user) {
  try {
    if (user) {
      window.localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(user));
    } else {
      window.localStorage.removeItem(LOCAL_SESSION_KEY);
    }
  } catch {
    // ignore storage errors
  }
  notifyLocalAuth(user);
}

export async function getCurrentSessionUser() {
  if (supabase) {
    const { data, error } = await supabase.auth.getUser();
    if (error) return null;
    return data?.user || null;
  }
  return readLocalUser();
}

export function subscribeToAuthChanges(callback) {
  if (supabase) {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      callback(session?.user || null);
    });
    return () => {
      data.subscription.unsubscribe();
    };
  }

  localAuthListeners.add(callback);
  return () => {
    localAuthListeners.delete(callback);
  };
}

export async function signInWithEmail(email, password) {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !password) {
    throw new Error("Email and password are required.");
  }

  if (supabase) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: cleanEmail,
      password,
    });
    if (error) throw error;
    return data.user;
  }

  const localUser = {
    id: `local-${cleanEmail}`,
    email: cleanEmail,
    provider: "local-email",
  };
  writeLocalUser(localUser);
  return localUser;
}

export async function signUpWithEmail(email, password) {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || password.length < 6) {
    throw new Error("Provide a valid email and a password of at least 6 characters.");
  }

  if (supabase) {
    const { data, error } = await supabase.auth.signUp({
      email: cleanEmail,
      password,
    });
    if (error) throw error;
    return {
      user: data.user,
      needsConfirmation: !data.session,
    };
  }

  const localUser = {
    id: `local-${cleanEmail}`,
    email: cleanEmail,
    provider: "local-email",
  };
  writeLocalUser(localUser);
  return { user: localUser, needsConfirmation: false };
}

export async function signInWithGoogle() {
  if (supabase) {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
      },
    });
    if (error) throw error;
    return null;
  }

  const demoGoogleUser = {
    id: "local-google-analyst",
    email: "analyst.demo@geovalue.local",
    provider: "local-google",
  };
  writeLocalUser(demoGoogleUser);
  return demoGoogleUser;
}

export async function signOutUser() {
  if (supabase) {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    return;
  }
  writeLocalUser(null);
}

function readLocalStoragePortfolio(userId) {
  try {
    const raw = window.localStorage.getItem(`${LOCAL_PORTFOLIO_KEY}:${userId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeLocalStoragePortfolio(userId, items) {
  try {
    window.localStorage.setItem(`${LOCAL_PORTFOLIO_KEY}:${userId}`, JSON.stringify(items));
  } catch {
    // ignore storage errors
  }
}

export async function fetchSavedPortfolio(user) {
  if (!user?.id) return [];

  if (supabase) {
    const { data, error } = await supabase
      .from("saved_portfolios")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return data || [];
  }

  try {
    const { data } = await axios.get(`${NODE_API_URL}/api/portfolios`, {
      params: { user_id: user.id },
    });
    const items = data?.items || [];
    writeLocalStoragePortfolio(user.id, items);
    return items;
  } catch {
    return readLocalStoragePortfolio(user.id);
  }
}

export async function saveParcelToPortfolio(user, parcel) {
  if (!user?.id) {
    throw new Error("Please sign in to bookmark properties.");
  }

  const record = {
    user_id: user.id,
    parcel_id: String(parcel.parcel_id),
    circle_rate: Number(parcel.circle_rate ?? 0),
    risk_score: Number(parcel.risk_score ?? 0),
    risk_adjusted_valuation:
      parcel.risk_adjusted_valuation != null
        ? Number(parcel.risk_adjusted_valuation)
        : null,
    distance_to_hazard:
      parcel.distance_to_hazard != null
        ? Number(parcel.distance_to_hazard)
        : null,
    longitude: parcel.longitude != null ? Number(parcel.longitude) : null,
    latitude: parcel.latitude != null ? Number(parcel.latitude) : null,
  };

  if (supabase) {
    const { data, error } = await supabase
      .from("saved_portfolios")
      .upsert(record, { onConflict: "user_id,parcel_id" })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  try {
    const { data } = await axios.post(`${NODE_API_URL}/api/portfolios`, record);
    const saved = data?.item || { ...record, created_at: new Date().toISOString() };
    const existing = readLocalStoragePortfolio(user.id).filter(
      (item) => item.parcel_id !== saved.parcel_id
    );
    writeLocalStoragePortfolio(user.id, [saved, ...existing]);
    return saved;
  } catch {
    const fallbackSaved = {
      ...record,
      id: Date.now(),
      created_at: new Date().toISOString(),
    };
    const existing = readLocalStoragePortfolio(user.id).filter(
      (item) => item.parcel_id !== fallbackSaved.parcel_id
    );
    writeLocalStoragePortfolio(user.id, [fallbackSaved, ...existing]);
    return fallbackSaved;
  }
}

export async function removeParcelFromPortfolio(user, parcelId) {
  if (!user?.id) {
    throw new Error("Authentication required.");
  }

  if (supabase) {
    const { error } = await supabase
      .from("saved_portfolios")
      .delete()
      .eq("user_id", user.id)
      .eq("parcel_id", String(parcelId));
    if (error) throw error;
    return;
  }

  const remaining = readLocalStoragePortfolio(user.id).filter(
    (item) => item.parcel_id !== String(parcelId)
  );
  writeLocalStoragePortfolio(user.id, remaining);

  try {
    await axios.delete(
      `${NODE_API_URL}/api/portfolios/${encodeURIComponent(parcelId)}`,
      { params: { user_id: user.id } }
    );
  } catch {
    // localStorage cache already updated
  }
}
