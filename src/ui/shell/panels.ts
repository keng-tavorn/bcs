// The panels of the workspace shell's top bar that open over the page — the bell's notifications
// (notification-bell.tsx) and the user menu (user-menu.tsx) — are <details> of one exclusive group, the name they share:
// opening one closes the other, without JavaScript, so a panel never opens over another (§9.9: no modal over a modal).

export const SHELL_PANELS = 'shell-panel'
