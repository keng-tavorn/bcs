// The panels of the workspace shell that open over the page — the phone's menu (workspace-shell.tsx) and the bell's
// notifications (notification-bell.tsx) — are <details> of one exclusive group, the name they share: opening one closes
// the other, without JavaScript, so a panel never opens over another (§9.9: no modal over a modal).

export const SHELL_PANELS = 'shell-panel'
