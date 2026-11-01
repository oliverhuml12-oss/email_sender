import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { supabase } from "./lib/supabase";
import Campaigns from "./pages/Campaigns";
import CampaignDetail from "./pages/CampaignDetail";
import Contacts from "./pages/Contacts";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import SettingsPage from "./pages/Settings";
import Templates from "./pages/Templates";
import Unsubscribe from "./pages/Unsubscribe";

export default function App() {
  const location = useLocation();
  if (location.pathname === "/unsubscribe") return <Unsubscribe />;
  return <AdminApp />;
}

function AdminApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setIsAdmin(null);
      return;
    }
    supabase.rpc("is_admin").then(async ({ data }) => {
      setIsAdmin(!!data);
      if (data) {
        // Remember where the app lives so emails can link to the unsubscribe page.
        const origin = window.location.origin;
        if (!/localhost|127\.0\.0\.1/.test(origin)) {
          await supabase.from("settings").update({ app_url: origin }).eq("id", 1).is("app_url", null);
        }
      }
    });
  }, [session]);

  if (session === undefined || (session && isAdmin === null)) return <div className="boot">Loading…</div>;
  if (!session) return <Login />;
  if (!isAdmin) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <h1>No access</h1>
          <p className="muted">
            {session.user.email} is signed in, but this tool has a single admin account and this isn't it.
          </p>
          <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden><rect width="32" height="32" rx="8" fill="currentColor" /><path d="M7 11l9 6 9-6M7 10h18v13H7z" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" /><circle cx="24.5" cy="9" r="3.6" fill="#ff2e88" style={{ filter: "drop-shadow(0 0 3px rgba(255,46,136,.9))" }} /></svg>
          <span>Email Sender</span>
        </div>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/campaigns">Campaigns</NavLink>
          <NavLink to="/contacts">Contacts</NavLink>
          <NavLink to="/templates">Templates</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="sidebar-foot">
          <span className="muted small" title={session.user.email}>{session.user.email}</span>
          <button className="btn-link small" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/campaigns/:id" element={<CampaignDetail />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/templates" element={<Templates userEmail={session.user.email ?? ""} />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
