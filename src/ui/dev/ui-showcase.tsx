'use client'

import {
  Ban,
  CalendarIcon,
  CircleCheck,
  CircleX,
  Clock,
  FilePen,
  FileText,
  Home,
  Inbox,
  ListChecks,
  MoreHorizontal,
  Search,
  ShoppingCart,
  AlarmClock,
  Undo2,
  Upload,
  Zap,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import { useLocale, useTranslations } from 'next-intl'
import { useState, type ReactNode } from 'react'
import { useDropzone } from 'react-dropzone'
import { toast } from 'sonner'
import { buddhistYear } from '@/core/thai'
import { monthNamesShort } from '@/core/thai/day'
import { BYTES_PER_KIB } from '@/lib/constants'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/ui/shadcn/alert-dialog'
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle } from '@/ui/shadcn/attachment'
import { Avatar, AvatarFallback } from '@/ui/shadcn/avatar'
import { Badge } from '@/ui/shadcn/badge'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/ui/shadcn/breadcrumb'
import { Bubble, BubbleContent } from '@/ui/shadcn/bubble'
import { Button } from '@/ui/shadcn/button'
import { ButtonGroup } from '@/ui/shadcn/button-group'
import { Calendar } from '@/ui/shadcn/calendar'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/shadcn/card'
import { Checkbox } from '@/ui/shadcn/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/shadcn/collapsible'
import { Combobox } from '@/ui/shadcn/combobox'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/ui/shadcn/command'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/ui/shadcn/dialog'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/ui/shadcn/drawer'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/shadcn/dropdown-menu'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/ui/shadcn/empty'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/ui/shadcn/field'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/ui/shadcn/hover-card'
import { Input } from '@/ui/shadcn/input'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/ui/shadcn/input-group'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/ui/shadcn/input-otp'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/ui/shadcn/item'
import { Kbd } from '@/ui/shadcn/kbd'
import { Marker, MarkerContent, MarkerIcon } from '@/ui/shadcn/marker'
import { Message, MessageAvatar, MessageContent, MessageHeader } from '@/ui/shadcn/message'
import { NativeSelect, NativeSelectOption } from '@/ui/shadcn/native-select'
import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from '@/ui/shadcn/pagination'
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover'
import { Progress } from '@/ui/shadcn/progress'
import { RadioGroup, RadioGroupItem } from '@/ui/shadcn/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/shadcn/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/ui/shadcn/sheet'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/ui/shadcn/sidebar'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { Toaster } from '@/ui/shadcn/sonner'
import { Spinner } from '@/ui/shadcn/spinner'
import { Switch } from '@/ui/shadcn/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/shadcn/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/shadcn/tabs'
import { Textarea } from '@/ui/shadcn/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/ui/shadcn/toggle-group'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/shadcn/tooltip'

// Every component of the table in §9.10 with the BCS tokens (/dev/ui, S16-02). The words are sample text from the
// devUi messages; nothing here reads or writes data. The chart is loaded with import() as §9.10 asks of every chart.

const UiChart = dynamic(() => import('./ui-chart').then((m) => m.UiChart), { ssr: false, loading: () => <ChartLoading /> })

function ChartLoading() {
  const t = useTranslations('devUi.chart')
  return (
    <div className="flex items-center gap-2 text-ink-muted">
      <Spinner />
      {t('loading')}
    </div>
  )
}

/** The tokens of §9.9 and §9.10, by name: each swatch draws its own variable */
const TOKENS = [
  'bg', 'surface', 'line', 'line-strong', 'ink', 'ink-muted', 'primary', 'primary-hover', 'primary-tint', 'on-primary', 'focus',
  'warn', 'danger', 'info', 'nav', 'nav-active', 'nav-ink', 'nav-ink-muted',
  'ok-bg', 'ok-ink', 'warn-bg', 'warn-ink', 'danger-bg', 'danger-ink', 'info-bg', 'info-ink', 'neutral-bg', 'neutral-ink',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'budget-reserved', 'budget-committed', 'budget-actual',
] as const

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  )
}

export function UiShowcase() {
  const t = useTranslations('devUi')
  const locale = useLocale() === 'en' ? 'en' : 'th'
  const [supplier, setSupplier] = useState<string | null>(null)
  const [neededBy, setNeededBy] = useState<Date | undefined>()
  const [commandOpen, setCommandOpen] = useState(false)
  const [files, setFiles] = useState<readonly File[]>([])
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop: (accepted) => setFiles(accepted) })
  const months = monthNamesShort(locale)
  const dayText = (date: Date) => `${date.getDate()} ${months[date.getMonth()]} ${buddhistYear(date)}`

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-10">
        <Section title={t('sections.colors')}>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {TOKENS.map((token) => (
              <li key={token} className="flex items-center gap-2">
                <span aria-hidden="true" className="size-8 shrink-0 rounded-md border border-line" style={{ background: `var(--${token})` }} />
                <code className="text-sm break-all">{`--${token}`}</code>
              </li>
            ))}
          </ul>
        </Section>

        <Section title={t('sections.status')}>
          <div className="flex flex-wrap gap-2">
            <Badge variant="neutral"><FilePen aria-hidden="true" />{t('status.draft')}</Badge>
            <Badge variant="warn"><Clock aria-hidden="true" />{t('status.pending')}</Badge>
            <Badge variant="warn"><Undo2 aria-hidden="true" />{t('status.returned')}</Badge>
            <Badge variant="ok"><CircleCheck aria-hidden="true" />{t('status.approved')}</Badge>
            <Badge variant="info"><ShoppingCart aria-hidden="true" />{t('status.ordered')}</Badge>
            <Badge variant="danger"><CircleX aria-hidden="true" />{t('status.rejected')}</Badge>
            <Badge variant="neutral"><Ban aria-hidden="true" />{t('status.cancelled')}</Badge>
            <Badge variant="danger"><AlarmClock aria-hidden="true" />{t('status.overdue', { hours: 3 })}</Badge>
            <Badge variant="warn"><Zap aria-hidden="true" />{t('status.urgent')}</Badge>
          </div>
        </Section>

        <Section title={t('sections.buttons')}>
          <div className="flex flex-wrap items-center gap-3">
            <Button className="rounded-full">{t('buttons.newRequest')}</Button>
            <Button>{t('buttons.submit')}</Button>
            <Button variant="outline">{t('buttons.saveDraft')}</Button>
            <ButtonGroup>
              <Button variant="outline">{t('buttons.back')}</Button>
              <Button variant="outline">{t('buttons.next')}</Button>
            </ButtonGroup>
          </div>
          <div className="flex flex-wrap items-center gap-6">
            <Button>{t('buttons.approve')}</Button>
            <Button variant="destructive">{t('buttons.reject')}</Button>
          </div>
          <ToggleGroup type="single" defaultValue="mine" variant="outline" aria-label={t('buttons.chips')}>
            <ToggleGroupItem value="mine" className="rounded-full">{t('buttons.myWork')}</ToggleGroupItem>
            <ToggleGroupItem value="new" className="rounded-full">{t('buttons.newRequestChip')}</ToggleGroupItem>
            <ToggleGroupItem value="suppliers" className="rounded-full">{t('buttons.suppliers')}</ToggleGroupItem>
          </ToggleGroup>
          <div className="flex items-center gap-2 text-ink-muted">
            <span>{t('buttons.shortcut')}</span>
            <Kbd>{t('buttons.shortcutMac')}</Kbd>
            <Kbd>{t('buttons.shortcutOther')}</Kbd>
          </div>
        </Section>

        <Section title={t('sections.form')}>
          <FieldGroup className="max-w-xl">
            <Field data-invalid>
              <FieldLabel htmlFor="ui-title">{t('form.title')}</FieldLabel>
              <Input id="ui-title" aria-invalid aria-describedby="ui-title-hint ui-title-error" />
              <FieldDescription id="ui-title-hint">{t('form.titleHint')}</FieldDescription>
              <FieldError id="ui-title-error">{t('form.titleError')}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="ui-amount">{t('form.amount')}</FieldLabel>
              <InputGroup>
                <InputGroupInput id="ui-amount" inputMode="decimal" className="money" />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>{t('form.baht')}</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </Field>
            <Field>
              <FieldLabel htmlFor="ui-note">{t('form.note')}</FieldLabel>
              <Textarea id="ui-note" />
            </Field>
            <FieldSet>
              <FieldLegend variant="label">{t('form.urgency')}</FieldLegend>
              <RadioGroup defaultValue="normal">
                <Field orientation="horizontal">
                  <RadioGroupItem value="normal" id="ui-normal" />
                  <FieldLabel htmlFor="ui-normal">{t('form.normal')}</FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <RadioGroupItem value="urgent" id="ui-urgent" />
                  <FieldLabel htmlFor="ui-urgent">{t('form.urgent')}</FieldLabel>
                </Field>
              </RadioGroup>
            </FieldSet>
            <Field>
              <FieldLabel htmlFor="ui-site">{t('form.site')}</FieldLabel>
              <Select>
                <SelectTrigger id="ui-site" className="w-full">
                  <SelectValue placeholder={t('form.sitePick')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="head">{t('form.siteHead')}</SelectItem>
                  <SelectItem value="store">{t('form.siteStore')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="ui-site-native">{t('form.siteNative')}</FieldLabel>
              <NativeSelect id="ui-site-native">
                <NativeSelectOption value="head">{t('form.siteHead')}</NativeSelectOption>
                <NativeSelectOption value="store">{t('form.siteStore')}</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="ui-supplier">{t('form.supplier')}</FieldLabel>
              <Combobox
                id="ui-supplier"
                options={[
                  { value: 'a', label: t('form.supplierA') },
                  { value: 'b', label: t('form.supplierB') },
                ]}
                value={supplier}
                onValueChange={setSupplier}
                placeholder={t('form.supplierPick')}
                searchPlaceholder={t('form.supplierSearch')}
                emptyText={t('form.supplierNone')}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ui-needed-by">{t('form.neededBy')}</FieldLabel>
              <Popover>
                <PopoverTrigger asChild>
                  <Button id="ui-needed-by" variant="outline" className="w-full justify-start font-normal">
                    <CalendarIcon aria-hidden="true" />
                    {neededBy ? dayText(neededBy) : t('form.pickDate')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar
                    mode="single"
                    selected={neededBy}
                    onSelect={setNeededBy}
                    formatters={{ formatCaption: (month) => `${months[month.getMonth()]} ${buddhistYear(month)}` }}
                  />
                </PopoverContent>
              </Popover>
            </Field>
            <Field orientation="horizontal">
              <Checkbox id="ui-checked" />
              <FieldLabel htmlFor="ui-checked">{t('form.checked')}</FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <Switch id="ui-notify" defaultChecked />
              <FieldLabel htmlFor="ui-notify">{t('form.notify')}</FieldLabel>
            </Field>
            <Field>
              <FieldLabel htmlFor="ui-pin">{t('form.pin')}</FieldLabel>
              <InputOTP id="ui-pin" maxLength={6} inputMode="numeric">
                <InputOTPGroup>
                  {[0, 1, 2, 3, 4, 5].map((index) => (
                    <InputOTPSlot key={index} index={index} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            </Field>
            <div
              {...getRootProps({
                className: `flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong p-4 text-center text-ink-muted ${isDragActive ? 'bg-primary-tint' : 'bg-surface'}`,
              })}
            >
              <input {...getInputProps()} />
              <Upload aria-hidden="true" />
              <span>{t('form.files')}</span>
            </div>
            {files.map((file) => (
              <Attachment key={file.name}>
                <AttachmentMedia>
                  <FileText aria-hidden="true" />
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{file.name}</AttachmentTitle>
                  <AttachmentDescription>
                    {t('form.fileReady')} · {t('form.fileSize', { size: Math.ceil(file.size / BYTES_PER_KIB) })}
                  </AttachmentDescription>
                </AttachmentContent>
              </Attachment>
            ))}
          </FieldGroup>
        </Section>

        <Section title={t('sections.display')}>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href="/">{t('display.home')}</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{t('display.requests')}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <Card className="max-w-xl">
            <CardHeader>
              <CardTitle>{t('display.cardTitle')}</CardTitle>
              <CardDescription>{t('display.cardDescription')}</CardDescription>
              <CardAction>
                <Button variant="link">{t('display.seeAll')}</Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <Item variant="outline">
                <Avatar>
                  <AvatarFallback>{t('display.initials')}</AvatarFallback>
                </Avatar>
                <ItemContent>
                  <ItemTitle>{t('display.itemTitle')}</ItemTitle>
                  <ItemDescription>{t('display.itemDescription')}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button variant="outline" size="sm">{t('display.open')}</Button>
                </ItemActions>
              </Item>
            </CardContent>
          </Card>
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">{t('display.overview')}</TabsTrigger>
              <TabsTrigger value="history">{t('display.history')}</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">{t('display.overviewText')}</TabsContent>
            <TabsContent value="history">{t('display.historyText')}</TabsContent>
          </Tabs>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('display.document')}</TableHead>
                <TableHead>{t('display.subject')}</TableHead>
                <TableHead className="text-right">{t('display.amount')}</TableHead>
                <TableHead>{t('display.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>{t('display.documentSample')}</TableCell>
                <TableCell>{t('display.itemTitle')}</TableCell>
                <TableCell className="money">{t('display.amountSample')}</TableCell>
                <TableCell>
                  <Badge variant="warn"><Clock aria-hidden="true" />{t('status.pending')}</Badge>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious href="#" />
              </PaginationItem>
              <PaginationItem>
                <PaginationLink href="#" isActive>1</PaginationLink>
              </PaginationItem>
              <PaginationItem>
                <PaginationLink href="#">2</PaginationLink>
              </PaginationItem>
              <PaginationItem>
                <PaginationNext href="#" />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </Section>

        <Section title={t('sections.feedback')}>
          <Empty className="border border-line">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{t('feedback.emptyTitle')}</EmptyTitle>
              <EmptyDescription>{t('feedback.emptyDescription')}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline">{t('feedback.emptyAction')}</Button>
            </EmptyContent>
          </Empty>
          <div className="flex max-w-xl flex-col gap-2">
            <span>{t('feedback.budgetUsed', { percent: 62 })}</span>
            <Progress value={62} aria-label={t('feedback.budgetUsed', { percent: 62 })} />
          </div>
          <div className="flex max-w-xl items-center gap-4">
            <Spinner />
            <Skeleton className="h-6 flex-1" />
          </div>
        </Section>

        <Section title={t('sections.overlays')}>
          <div className="flex flex-wrap gap-3">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">{t('overlays.openDialog')}</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t('overlays.dialogTitle')}</DialogTitle>
                  <DialogDescription>{t('overlays.dialogDescription')}</DialogDescription>
                </DialogHeader>
                <RadioGroup defaultValue="goods">
                  <Field orientation="horizontal">
                    <RadioGroupItem value="goods" id="ui-goods" />
                    <FieldLabel htmlFor="ui-goods">{t('overlays.goods')}</FieldLabel>
                  </Field>
                  <Field orientation="horizontal">
                    <RadioGroupItem value="service" id="ui-service" />
                    <FieldLabel htmlFor="ui-service">{t('overlays.service')}</FieldLabel>
                  </Field>
                </RadioGroup>
                <DialogFooter>
                  <Button>{t('overlays.start')}</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Drawer>
              <DrawerTrigger asChild>
                <Button variant="outline">{t('overlays.openDrawer')}</Button>
              </DrawerTrigger>
              <DrawerContent>
                <DrawerHeader>
                  <DrawerTitle>{t('overlays.drawerTitle')}</DrawerTitle>
                  <DrawerDescription>{t('overlays.drawerDescription')}</DrawerDescription>
                </DrawerHeader>
              </DrawerContent>
            </Drawer>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline">{t('overlays.openSheet')}</Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>{t('overlays.sheetTitle')}</SheetTitle>
                  <SheetDescription>{t('overlays.sheetDescription')}</SheetDescription>
                </SheetHeader>
              </SheetContent>
            </Sheet>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline">{t('overlays.cancelRequest')}</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('overlays.alertTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('overlays.alertDescription')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('overlays.keep')}</AlertDialogCancel>
                  <AlertDialogAction variant="destructive">{t('overlays.cancelRequest')}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <MoreHorizontal aria-hidden="true" />
                  {t('overlays.documentMenu')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem>{t('overlays.printPdf')}</DropdownMenuItem>
                <DropdownMenuItem>{t('overlays.copyLink')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">{t('overlays.notifications')}</Button>
              </PopoverTrigger>
              <PopoverContent>{t('overlays.notificationsText')}</PopoverContent>
            </Popover>
            <HoverCard>
              <HoverCardTrigger asChild>
                <Button variant="link">{t('overlays.person')}</Button>
              </HoverCardTrigger>
              <HoverCardContent>{t('overlays.personDetail')}</HoverCardContent>
            </HoverCard>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" aria-label={t('overlays.collapse')}>
                  <ListChecks aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('overlays.collapse')}</TooltipContent>
            </Tooltip>
            <Button variant="outline" onClick={() => toast.success(t('overlays.toast'))}>
              {t('overlays.showToast')}
            </Button>
            <Button variant="outline" onClick={() => setCommandOpen(true)}>
              <Search aria-hidden="true" />
              {t('overlays.openCommand')}
            </Button>
          </div>
          <CommandDialog open={commandOpen} onOpenChange={setCommandOpen} title={t('overlays.commandTitle')} description={t('overlays.commandDescription')}>
            <CommandInput placeholder={t('buttons.search')} />
            <CommandList>
              <CommandEmpty>{t('overlays.commandEmpty')}</CommandEmpty>
              <CommandGroup heading={t('overlays.documents')}>
                <CommandItem>
                  <FileText aria-hidden="true" />
                  {t('display.itemTitle')}
                </CommandItem>
              </CommandGroup>
              <CommandGroup heading={t('overlays.pages')}>
                <CommandItem>
                  <Home aria-hidden="true" />
                  {t('sidebar.home')}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </CommandDialog>
          <Toaster />
        </Section>

        <Section title={t('sections.conversation')}>
          <div className="flex max-w-xl flex-col gap-4">
            <Message>
              <MessageAvatar>
                <Avatar>
                  <AvatarFallback>{t('display.initials')}</AvatarFallback>
                </Avatar>
              </MessageAvatar>
              <MessageContent>
                <MessageHeader>{t('conversation.author')}</MessageHeader>
                <Bubble variant="muted">
                  <BubbleContent>{t('conversation.question')}</BubbleContent>
                </Bubble>
              </MessageContent>
            </Message>
            <Message align="end">
              <MessageContent>
                <Bubble variant="tinted">
                  <BubbleContent>{t('conversation.answer')}</BubbleContent>
                </Bubble>
              </MessageContent>
            </Message>
            <Marker>
              <MarkerIcon>
                <CircleCheck />
              </MarkerIcon>
              <MarkerContent>{t('conversation.event')}</MarkerContent>
            </Marker>
            <Attachment>
              <AttachmentMedia>
                <FileText aria-hidden="true" />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{t('conversation.attachment')}</AttachmentTitle>
                <AttachmentDescription>{t('conversation.attachmentSize')}</AttachmentDescription>
              </AttachmentContent>
            </Attachment>
          </div>
        </Section>

        <Section title={t('sections.chart')}>
          <div className="max-w-xl">
            <UiChart />
          </div>
        </Section>

        <Section title={t('sections.sidebar')}>
          <SidebarProvider className="min-h-0 overflow-hidden rounded-lg border border-line">
            <Sidebar collapsible="none" className="h-72">
              <SidebarContent>
                <SidebarGroup>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      <SidebarMenuItem>
                        <SidebarMenuButton isActive tooltip={t('sidebar.home')}>
                          <Home aria-hidden="true" />
                          <span>{t('sidebar.home')}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                      <SidebarMenuItem>
                        <SidebarMenuButton tooltip={t('sidebar.tasks')}>
                          <ListChecks aria-hidden="true" />
                          <span>{t('sidebar.tasks')}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                      <SidebarMenuItem>
                        <SidebarMenuButton tooltip={t('sidebar.requests')}>
                          <FilePen aria-hidden="true" />
                          <span>{t('sidebar.requests')}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
                <Collapsible defaultOpen className="group/collapsible">
                  <SidebarGroup>
                    <SidebarGroupLabel asChild>
                      <CollapsibleTrigger>{t('sidebar.procurement')}</CollapsibleTrigger>
                    </SidebarGroupLabel>
                    <CollapsibleContent>
                      <SidebarGroupContent>
                        <SidebarMenu>
                          <SidebarMenuItem>
                            <SidebarMenuButton tooltip={t('sidebar.pool')}>
                              <ShoppingCart aria-hidden="true" />
                              <span>{t('sidebar.pool')}</span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                          <SidebarMenuItem>
                            <SidebarMenuButton tooltip={t('sidebar.orders')}>
                              <FileText aria-hidden="true" />
                              <span>{t('sidebar.orders')}</span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        </SidebarMenu>
                      </SidebarGroupContent>
                    </CollapsibleContent>
                  </SidebarGroup>
                </Collapsible>
              </SidebarContent>
            </Sidebar>
          </SidebarProvider>
        </Section>
      </div>
    </TooltipProvider>
  )
}
