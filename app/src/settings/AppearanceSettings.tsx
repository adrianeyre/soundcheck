import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";

import {
  choosePalette,
  chooseTheme,
  PALETTES,
  readPalette,
  readThemePreference,
  THEME_PREFERENCES,
  type ThemePreference,
} from "./theme";

const ICONS: Record<ThemePreference, typeof Sun> = { system: Monitor, dark: Moon, light: Sun };

/** The colour theme (dark, light, or following the system) and the accent palette. */
export function AppearanceSettings() {
  const [preference, setPreference] = useState(readThemePreference);
  const [palette, setPalette] = useState(readPalette);
  return (
    <div className="stack">
      <fieldset>
        <legend className="field-legend">Theme</legend>
        <div className="choice-group">
          {THEME_PREFERENCES.map(({ id, label }) => {
            const Icon = ICONS[id];
            return (
              <label key={id} className="choice">
                <input
                  type="radio"
                  name="theme"
                  value={id}
                  checked={preference === id}
                  onChange={() => {
                    setPreference(id);
                    chooseTheme(id);
                  }}
                />
                <Icon size={16} aria-hidden />
                {label}
              </label>
            );
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend className="field-legend">Colour palette</legend>
        <div className="choice-group">
          {PALETTES.map(({ id, label }) => (
            <label key={id} className="choice">
              <input
                type="radio"
                name="palette"
                value={id}
                checked={palette === id}
                onChange={() => {
                  setPalette(id);
                  choosePalette(id);
                }}
              />
              <span className="swatch" data-swatch={id} aria-hidden />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
