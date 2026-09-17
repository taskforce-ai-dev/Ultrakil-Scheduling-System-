"use client"

import * as React from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

interface SliderProps extends Omit<SliderPrimitive.Root.Props<number>, "children"> {
  /**
   * The slider's own accessible name. Base UI's guidance is explicit: a
   * single-thumb slider with no visible <Slider.Label> needs this on the
   * thumb itself, or it has no name a screen reader can announce.
   */
  "aria-label": string
}

function Slider({ className, "aria-label": ariaLabel, ...props }: SliderProps) {
  return (
    <SliderPrimitive.Root data-slot="slider" className={cn("w-full", className)} {...props}>
      <SliderPrimitive.Control className="flex w-full touch-none items-center py-2 select-none">
        <SliderPrimitive.Track className="relative h-1.5 w-full grow rounded-full bg-muted select-none">
          <SliderPrimitive.Indicator className="absolute h-full rounded-full bg-primary select-none" />
          <SliderPrimitive.Thumb
            aria-label={ariaLabel}
            className="block size-4 rounded-full border-2 border-primary bg-background shadow-sm transition-colors select-none outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
