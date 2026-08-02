import { useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Logo } from './Logo';
import { login } from '../lib/auth';

export function Login({
  onBack,
  onSwitch,
  onSuccess,
}: {
  onBack: () => void;
  onSwitch: () => void;
  onSuccess: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await login(username.trim(), password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="auth-card">
        <button className="auth-back" onClick={onBack} title="Back">
          <ArrowLeft size={18} />
        </button>
        <div className="login-brand">
          <Logo />
          <span className="login-title">Frio</span>
        </div>
        <p className="login-sub">Sign in to continue</p>
        <form onSubmit={submit} className="login-form">
          <label className="login-label">
            <span>Username</span>
            <input
              className="login-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
            />
          </label>
          <label className="login-label">
            <span>Password</span>
            <input
              className="login-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && <div className="login-error">{error}</div>}
          <button className="login-btn" type="submit" disabled={busy}>
            {busy ? <Loader2 className="spin" size={16} /> : 'Sign in'}
          </button>
        </form>
        <p className="auth-switch">
          Don&apos;t have an account?{' '}
          <button className="auth-switch-btn" onClick={onSwitch}>
            Sign up
          </button>
        </p>
      </div>
    </div>
  );
}
