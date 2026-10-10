/** IPC channel names between preload and main. */
export const CH = {
  /** sendSync at preload start: origin, app version, platform. */
  init: 'agentdeck:init',
  /** sendSync before the page runs: pair this device now (no login saved). */
  pairSync: 'agentdeck:pair-sync',
  /** invoke after the server rejected the saved login. */
  pairAgain: 'agentdeck:pair-again',
  getSettings: 'agentdeck:get-settings',
  setSettings: 'agentdeck:set-settings',
  getServerStatus: 'agentdeck:get-server-status',
  serviceAction: 'agentdeck:service-action',
  quit: 'agentdeck:quit',
  /** main → page: the server status changed. */
  serverStatus: 'agentdeck:server-status',
} as const;

export interface InitInfo {
  origin: string;
  appVersion: string;
  platform: string;
}
