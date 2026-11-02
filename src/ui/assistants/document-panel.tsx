import { Sparkles } from 'lucide-react'
import { AiBrief, type AiBriefProps } from '../tasks/ai-brief'
import { ItemGroup } from '../shadcn/item'
import { AskShortcuts } from './ask-shortcuts'
import { AssistantNote, type AssistantNoteView } from './assistant-note'
import { FeedbackButtons, type AiFeedback, type GiveAiFeedback } from './feedback-buttons'

// The panel "จากผู้ช่วย" of a document page — request, PO and invoice (NEW-122 · ADR-079): where the assistants of BCS
// speak about the document open, in place of the old box of the AI's summary. On a computer it stands in the right
// column under the decision bar; on a phone under the document's header. Three parts, each only when it has something:
//  · the Approval Brief for the one who decides now (FR-AI-301), set apart with Sparkles, with "ช่วยได้" "ไม่ช่วย";
//  · what the assistants found in this document by the rules the system has (the look of ADR-078, no Sparkles), each
//    with one way to where it is dealt with — said to be nothing when nothing, so the panel never hides;
//  · "ถามเรื่องนี้" and "สรุปให้" while "ถาม BCS AI" is on (NEW-118).
// With the AI module off only the rules' part is left. Nothing here decides (BR-AI-01) and nothing opens by itself (NG-13).

export const ASSISTANT_PANEL_ID = 'assistant-panel'

export interface AssistantPanelView {
  readonly title: string
  readonly brief: (AiBriefProps & { readonly feedback: { readonly agentActionId: string; readonly given: AiFeedback | null } | null }) | null
  readonly found: { readonly title: string; readonly notes: readonly AssistantNoteView[]; readonly none: string; readonly list: string }
  readonly ask: { readonly title: string; readonly hint: string; readonly draft: string; readonly summarize: string; readonly labels: { readonly ask: string; readonly summarize: string } } | null
}

export function AssistantPanel({ view, give }: { view: AssistantPanelView; give?: GiveAiFeedback }) {
  const brief = view.brief
  return (
    <section id={ASSISTANT_PANEL_ID} aria-labelledby={`${ASSISTANT_PANEL_ID}-title`} className="flex flex-col gap-4 rounded-md border border-line bg-bg p-4">
      <h2 id={`${ASSISTANT_PANEL_ID}-title`} className="text-lg font-semibold text-ink">
        {view.title}
      </h2>
      {brief ? <AiBrief brief={brief} feedback={brief.feedback && give ? <FeedbackButtons agentActionId={brief.feedback.agentActionId} initial={brief.feedback.given} give={give} /> : null} /> : null}

      <section aria-labelledby={`${ASSISTANT_PANEL_ID}-found`} className="flex flex-col gap-2">
        <h3 id={`${ASSISTANT_PANEL_ID}-found`} className="font-semibold text-ink">
          {view.found.title}
        </h3>
        {view.found.notes.length ? (
          <ItemGroup aria-label={view.found.list} className="gap-0">
            {view.found.notes.map((note) => (
              <AssistantNote key={note.key} note={note} />
            ))}
          </ItemGroup>
        ) : (
          <p className="text-base text-ink-muted md:text-sm">{view.found.none}</p>
        )}
      </section>

      {view.ask ? (
        <section aria-labelledby={`${ASSISTANT_PANEL_ID}-ask`} className="flex flex-col gap-2">
          <h3 id={`${ASSISTANT_PANEL_ID}-ask`} className="flex items-center gap-2 font-semibold text-ink">
            <Sparkles className="size-4 text-info" aria-hidden="true" />
            {view.ask.title}
          </h3>
          <p className="text-base text-ink-muted md:text-sm">{view.ask.hint}</p>
          <AskShortcuts draft={view.ask.draft} summarize={view.ask.summarize} labels={view.ask.labels} />
        </section>
      ) : null}
    </section>
  )
}
