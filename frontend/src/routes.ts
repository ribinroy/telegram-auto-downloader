export const ROUTES = {
  DOWNLOADS: '/',
  ANALYTICS: '/analytics',
  SETTINGS: '/settings',
  SETTINGS_VPS: '/settings/vps',
  VPS: '/vps',
  VPS_FILES: '/vps/files',
  VPS_TRANSMISSION: '/vps/transmission',
  VPS_QBITTORRENT: '/vps/qbittorrent',
} as const;

// Build a settings URL for a specific tab, e.g. settingsTab('vps') => '/settings/vps'
export const settingsTab = (tab: string) => `/settings/${tab}`;
