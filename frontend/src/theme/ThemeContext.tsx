import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { readJson, writeJson } from "../library/storage";

// Also read by public/theme-init.js before the first paint.
export const THEME_KEY = "ytc.theme.v1";

export type ThemeMode = "system" | "dark" | "light";

interface ThemeValue {
  mode: ThemeMode;
  dark: boolean;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

const systemDark = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches !== false;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() =>
    readJson<ThemeMode>(THEME_KEY, (v) => (v === "dark" || v === "light" ? v : null), "system"),
  );
  const [prefersDark, setPrefersDark] = useState(systemDark);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const onChange = () => setPrefersDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const dark = mode === "dark" || (mode === "system" && prefersDark);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    // theme-init.js reads a bare string, so store "system" as a removal.
    try {
      if (next === "system") window.localStorage.removeItem(THEME_KEY);
      else writeJson(THEME_KEY, next);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
  }, []);

  const value = useMemo(() => ({ mode, dark, setMode }), [mode, dark, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
