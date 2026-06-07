import { useState, useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { verifyToken, clearToken, getToken } from './api';
import { LoginPage } from './components/LoginPage';
import { Layout } from './components/Layout';
import { DownloadsPage } from './pages/DownloadsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ROUTES } from './routes';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    const checkAuth = async () => {
      if (!getToken()) { setIsAuthenticated(false); return; }
      const valid = await verifyToken();
      setIsAuthenticated(valid);
      if (!valid) clearToken();
    };
    checkAuth();
  }, []);

  const handleLogin = () => setIsAuthenticated(true);
  const handleLogout = () => { clearToken(); setIsAuthenticated(false); };

  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-cyan-500 animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <Routes>
      <Route element={<Layout onLogout={handleLogout} />}>
        <Route path={ROUTES.DOWNLOADS} element={<DownloadsPage />} />
        <Route path={ROUTES.ANALYTICS} element={<AnalyticsPage />} />
        <Route path={ROUTES.SETTINGS} element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}

export default App;
