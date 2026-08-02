import { Monitor, Moon, Sun, X } from 'lucide-react';
import type { Theme, UserSettings } from '../lib/settings';

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

export function Settings({
  settings,
  onChange,
  onClose,
}: {
  settings: UserSettings;
  onChange: (next: Partial<UserSettings>) => void;
  onClose: () => void;
}) {
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2 className="settings-title">Settings</h2>
          <button className="settings-close" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="settings-section">
          <span className="settings-label">Theme</span>
          <div className="theme-segmented">
            {THEME_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              return (
                <button
                  key={opt.value}
                  className={`theme-opt${settings.theme === opt.value ? ' active' : ''}`}
                  onClick={() => onChange({ theme: opt.value })}
                >
                  <Icon size={15} />
                  {opt.label}
                </button>
              );
            })}
          </div>
          <p className="settings-hint">
            System follows your OS color scheme.
          </p>
        </div>

        <div className="settings-section">
          <span className="settings-label">Personality</span>
          <textarea
            className="settings-textarea"
            placeholder="e.g. Always be warm and use a friendly tone. Refer to yourself as Frio and keep answers short and playful."
            value={settings.personality}
            onChange={(e) => onChange({ personality: e.target.value })}
            rows={5}
          />
          <p className="settings-hint">
            This is added as an extra system instruction on every chat.
          </p>
        </div>
      </div>
    </div>
  );
}
