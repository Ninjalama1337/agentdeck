/** User-facing strings of the shell (German, like the dialogs in the plan). */
export const TEXTS = {
  appName: 'AgentDeck',
  serviceOffer: {
    message: 'Als Hintergrunddienst einrichten?',
    detail:
      'AgentDeck kann als Dienst Ihres Benutzerkontos laufen (systemd --user). Er startet beim Anmelden, ' +
      'auch ohne dieses Fenster: Agenten, Routinen und Benachrichtigungen laufen weiter. ' +
      'Terminals laufen in tmux und gehen dabei nicht verloren. ' +
      'Das Handy erreicht ihn, sobald Sie in den Einstellungen „Handy-Zugriff im LAN“ einschalten.\n\n' +
      'Ohne Dienst läuft der Server nur, solange Sie ihn über diese App gestartet haben. ' +
      'Sie können das jederzeit in den Einstellungen ändern.',
    install: 'Als Dienst einrichten',
    decline: 'Ohne Dienst starten',
  },
  portBusy: (port: number) => ({
    message: `Port ${port} ist belegt`,
    detail:
      `Auf 127.0.0.1:${port} antwortet ein anderes Programm als AgentDeck. ` +
      'AgentDeck weicht bewusst nicht auf einen anderen Port aus, weil die Anmeldung an der Adresse hängt.\n\n' +
      `Beenden Sie das andere Programm oder stellen Sie AgentDeck auf einen freien Port um ` +
      '(Konfiguration: port in ~/.config/agentdeck/config.json).',
  }),
  startFailed: 'AgentDeck konnte den Server nicht starten',
  retry: 'Erneut versuchen',
  quit: 'Beenden',
  serverBinMissing:
    'Der mitgelieferte AgentDeck-Server wurde nicht gefunden. Die Installation ist unvollständig — bitte AgentDeck neu installieren.',
  stopFailed: 'Der Dienst konnte nicht gestoppt werden',
  stopFailedQuit: 'Trotzdem beenden (Dienst läuft weiter)',
  cancel: 'Abbrechen',
  portUnresponsive: (port: number) => ({
    message: `Port ${port} antwortet nicht`,
    detail:
      `Auf 127.0.0.1:${port} nimmt ein Programm Verbindungen an, antwortet aber nicht rechtzeitig. ` +
      'Läuft AgentDeck gerade erst hoch, hilft „Erneut versuchen“. Sonst das Programm beenden, das den Port hält. ' +
      'AgentDeck weicht bewusst nicht auf einen anderen Port aus.',
  }),
  renderCrash: {
    title: 'Das Fenster ist mehrfach abgestürzt',
    detail: 'AgentDeck lädt die Seite nicht noch einmal automatisch. Neu laden mit Strg+Umschalt+R, oder die App neu starten.',
  },
  update: {
    message: (version: string) => `AgentDeck ${version} ist verfügbar`,
    detail:
      'Eine neuere Version dieser App ist erschienen. Der Dienst wird beim nächsten Start der neuen Version automatisch aktualisiert; Terminals bleiben dabei erhalten.',
    open: 'Release-Seite öffnen',
    later: 'Später',
    ignore: 'Diese Version ignorieren',
  },
} as const;
