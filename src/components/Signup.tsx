import { useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Logo } from './Logo';
import { register } from '../lib/auth';

export function Signup({
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
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const name = username.trim();
    if (name.length < 3) {
      setError('Username must be at least 3 characters');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await register(name, password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign up failed');
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
        <p className="login-sub">Create your account</p>
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
              autoComplete="new-password"
            />
          </label>
          <label className="login-label">
            <span>Confirm password</span>
            <input
              className="login-input"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          {error && <div className="login-error">{error}</div>}
          <button className="login-btn" type="submit" disabled={busy}>
            {busy ? <Loader2 className="spin" size={16} /> : 'Sign up'}
          </button>
        </form>
        <p className="auth-switch">
          Already have an account?{' '}
          <button className="auth-switch-btn" onClick={onSwitch}>
            Sign in
          </button>
        </p>
      </div>
    </div>
  );
}
