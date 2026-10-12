import { Menu, type MenuItemConstructorOptions } from 'electron';

export function buildMenu(options: {
  onQuit(): void;
  onReload(): void;
  devTools: boolean;
}): Menu {
  const view: MenuItemConstructorOptions[] = [
    { label: 'Neu laden', accelerator: 'CmdOrCtrl+Shift+R', click: options.onReload },
    { type: 'separator' },
    { role: 'zoomIn', label: 'Vergrößern' },
    { role: 'zoomOut', label: 'Verkleinern' },
    { role: 'resetZoom', label: 'Originalgröße' },
    { type: 'separator' },
    { role: 'togglefullscreen', label: 'Vollbild' },
  ];
  if (options.devTools) view.push({ type: 'separator' }, { role: 'toggleDevTools', label: 'Entwicklerwerkzeuge' });

  return Menu.buildFromTemplate([
    {
      label: 'Datei',
      submenu: [{ label: 'Beenden', accelerator: 'CmdOrCtrl+Q', click: options.onQuit }],
    },
    {
      label: 'Bearbeiten',
      submenu: [
        { role: 'undo', label: 'Rückgängig' },
        { role: 'redo', label: 'Wiederholen' },
        { type: 'separator' },
        { role: 'cut', label: 'Ausschneiden' },
        { role: 'copy', label: 'Kopieren' },
        { role: 'paste', label: 'Einfügen' },
        { role: 'selectAll', label: 'Alles auswählen' },
      ],
    },
    { label: 'Ansicht', submenu: view },
  ]);
}
