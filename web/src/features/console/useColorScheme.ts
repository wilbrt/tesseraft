import { useEffect, useState } from 'react';
import { getJson } from '../../lib/api';
import { projectApiUrl } from '../../lib/project';

export type ColorScheme = 'classic' | 'matrix';

export const useColorScheme = (projectId: string) => {
  const [colorScheme, setColorScheme] = useState<ColorScheme>('classic');

  useEffect(() => {
    document.documentElement.dataset.colorScheme = colorScheme;
  }, [colorScheme]);

  useEffect(() => {
    let cancelled = false;
    setColorScheme('classic');
    getJson<{ settings?: { color_scheme?: unknown } }>(projectApiUrl('/api/settings', projectId))
      .then((data) => { if (!cancelled) setColorScheme(data.settings?.color_scheme === 'matrix' ? 'matrix' : 'classic'); })
      .catch(() => { if (!cancelled) setColorScheme('classic'); });
    return () => { cancelled = true; };
  }, [projectId]);

  return [colorScheme, setColorScheme] as const;
};
