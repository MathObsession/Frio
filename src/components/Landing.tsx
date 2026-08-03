import { Logo } from './Logo';

export function Landing({ onOAuth }: { onOAuth: () => void }) {
  return (
    <div className="landing">
      <div className="landing-inner">
        <div className="landing-brand">
          <Logo />
          <span className="landing-name">Frio</span>
        </div>
        <h1 className="landing-tagline">
          Your private AI chat,
          <br />
          ready to talk.
        </h1>
        <p className="landing-desc">
          A calm, focused space for thoughtful conversation. Sign in with your
          Cloudflare account to stream from your own Workers AI models.
        </p>
        <div className="landing-features">
          <span className="landing-chip">Chat</span>
          <span className="landing-chip">Private</span>
          <span className="landing-chip">Files</span>
        </div>
        <div className="landing-actions">
          <button className="landing-btn landing-btn-primary" onClick={onOAuth}>
            Continue with Cloudflare
          </button>
        </div>
      </div>
    </div>
  );
}
