import { Logo } from './Logo';

export function Landing({
  onSignIn,
  onSignUp,
}: {
  onSignIn: () => void;
  onSignUp: () => void;
}) {
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
          A calm, focused space for thoughtful conversation. Stream from your
          favorite models, and share images and files.
        </p>
        <div className="landing-features">
          <span className="landing-chip">Chat</span>
          <span className="landing-chip">Private</span>
          <span className="landing-chip">Files</span>
        </div>
        <div className="landing-actions">
          <button className="landing-btn landing-btn-primary" onClick={onSignIn}>
            Sign in
          </button>
          <button className="landing-btn landing-btn-ghost" onClick={onSignUp}>
            Sign up
          </button>
        </div>
      </div>
    </div>
  );
}
