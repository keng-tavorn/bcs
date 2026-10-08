"use client"

import * as React from "react"
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react"

import { cn } from "@/ui/cn"
import { Button } from "@/ui/shadcn/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/ui/shadcn/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/shadcn/popover"

// Combobox of the radix base (§5.5: one base for the whole project): Popover with Command inside, as shadcn/ui documents
// it for Radix. The registry's combobox item is built on Base UI, which this project does not mix in.

interface ComboboxOption {
  readonly value: string
  readonly label: string
}

function Combobox({
  id,
  options,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  className,
  "aria-invalid": ariaInvalid,
}: {
  id?: string
  options: readonly ComboboxOption[]
  value: string | null
  onValueChange: (value: string | null) => void
  /** Shown on the button while nothing is chosen */
  placeholder: string
  searchPlaceholder: string
  /** Shown when no option matches what was typed */
  emptyText: string
  className?: string
  "aria-invalid"?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const chosen = options.find((option) => option.value === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={ariaInvalid}
          data-slot="combobox"
          className={cn("w-full justify-between font-normal", !chosen && "text-muted-foreground", className)}
        >
          {chosen?.label ?? placeholder}
          <ChevronsUpDownIcon aria-hidden="true" className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  onSelect={() => {
                    onValueChange(option.value === value ? null : option.value)
                    setOpen(false)
                  }}
                >
                  <CheckIcon aria-hidden="true" className={cn(option.value === value ? "opacity-100" : "opacity-0")} />
                  {option.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export { Combobox, type ComboboxOption }
