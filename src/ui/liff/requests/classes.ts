// The classes of the request form's controls, as the workspace's src/ui/request-form/controls.tsx writes them: the LIFF
// form's first screen uses them without importing that module, whose error line brings lucide's client code into the
// first JavaScript of the page (§9.4: at most 200 KB gzip with the LINE SDK; Turbopack keeps a module whole). Steps 2
// and 3, loaded later, use the workspace's own controls.

export const inputClass =
  'h-11 w-full min-w-0 rounded-md border border-input bg-bg px-3 text-base text-ink placeholder:text-ink-muted aria-[invalid=true]:border-danger disabled:cursor-not-allowed disabled:opacity-60'
export const textareaClass =
  'min-h-28 w-full min-w-0 rounded-md border border-input bg-bg px-3 py-2 text-base text-ink placeholder:text-ink-muted aria-[invalid=true]:border-danger'
/** A checkbox or radio button: 20 px, never squeezed; src/app/globals.css draws it from the tokens */
export const checkboxClass = 'size-5 shrink-0'

/** A link that leads to the next thing to do, drawn as the main button (src/ui/form/button.tsx primary), 44 px high */
export const primaryLinkClass =
  'inline-flex min-h-11 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-center font-medium text-primary-foreground underline-offset-4 transition-colors duration-150 hover:underline'

/** The ids a control is described by: its hint and its error, when shown */
export const describedBy = (id: string, hint: boolean, error: boolean) => [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined
