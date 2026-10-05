// The LINE message objects BCS builds (developers.line.biz/en/reference/messaging-api/#message-objects), written out as
// plain JSON types. Channels may not import src/integrations (§4.10), so the shapes live here; every one of them is a
// `LineMessage` of src/integrations/line (a type and its fields), and tests check them against its limits module. They
// are type aliases on purpose: an alias has the implicit index signature that LineMessage asks for, an interface not.

export type CardLocale = 'th' | 'en'

export type FlexAction =
  /** A button that sends `data` to the webhook (BR-TOK-02: v=1&a=<action>&k=<tokenId> and nothing else) */
  | { readonly type: 'postback'; readonly label: string; readonly data: string; readonly displayText: string }
  /** A button that opens a page: a LIFF page, or the workspace when the organization has no LIFF app */
  | { readonly type: 'uri'; readonly label: string; readonly uri: string }

export type FlexSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'
export type FlexSpacing = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl'

export type FlexText = {
  readonly type: 'text'
  readonly text: string
  readonly size?: FlexSize
  readonly weight?: 'regular' | 'bold'
  readonly color?: string
  readonly wrap?: boolean
  readonly flex?: number
  readonly align?: 'start' | 'end' | 'center'
  readonly margin?: FlexSpacing
}

export type FlexButton = {
  readonly type: 'button'
  readonly action: FlexAction
  readonly style: 'primary' | 'secondary' | 'link'
  readonly height?: 'sm' | 'md'
  readonly color?: string
  readonly margin?: FlexSpacing
}

export type FlexSeparator = { readonly type: 'separator'; readonly margin?: FlexSpacing; readonly color?: string }

export type FlexBox = {
  readonly type: 'box'
  readonly layout: 'vertical' | 'horizontal' | 'baseline'
  readonly contents: readonly FlexComponent[]
  readonly spacing?: FlexSpacing
  readonly margin?: FlexSpacing
  readonly paddingAll?: string
  readonly backgroundColor?: string
}

export type FlexComponent = FlexText | FlexButton | FlexSeparator | FlexBox

export type FlexBubble = {
  readonly type: 'bubble'
  readonly size?: 'kilo' | 'mega'
  readonly header?: FlexBox
  readonly body: FlexBox
  readonly footer?: FlexBox
}

export type FlexMessage = { readonly type: 'flex'; readonly altText: string; readonly contents: FlexBubble }

export type TextMessage = { readonly type: 'text'; readonly text: string }

/** What the builders return: one message object of LINE's push or reply */
export type OutgoingLineMessage = FlexMessage | TextMessage
