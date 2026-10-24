"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"

interface ValueHistoryApi {
  get: (key: string) => number[]
  push: (key: string, value: number) => void
  pop: (key: string) => void
}

const ValueHistoryContext = createContext<ValueHistoryApi | null>(null)

/**
 * Every earlier value of each setting on the Settings card, newest last, so "was" can step back through them one at a
 * time. Kept here rather than in each field, so switching tabs doesn't forget them. Starts over for each mechanism.
 */
export function ValueHistoryProvider({ children }: { children: ReactNode }) {
  const [stacks, setStacks] = useState<Record<string, number[]>>({})
  const get = useCallback((key: string) => stacks[key] ?? [], [stacks])
  const push = useCallback((key: string, value: number) => {
    setStacks((s) => ({ ...s, [key]: [...(s[key] ?? []), value] }))
  }, [])
  const pop = useCallback((key: string) => {
    setStacks((s) => ({ ...s, [key]: (s[key] ?? []).slice(0, -1) }))
  }, [])
  return <ValueHistoryContext.Provider value={{ get, push, pop }}>{children}</ValueHistoryContext.Provider>
}

/**
 * A setting's earlier values, last in, first out. Each time the value changes, the one before it is saved. Undo restores
 * the most recent one and drops it, so the next undo goes one further back. The undo itself is not saved.
 */
export function useValueHistory(key: string, value: number | null | undefined, restore: (v: number) => boolean | void) {
  const api = useContext(ValueHistoryContext)
  if (!api) throw new Error("useValueHistory must be used inside ValueHistoryProvider")
  const { push, pop } = api
  const previous = useRef(value)
  /** The value an undo just sent, which is not saved when it comes back. */
  const restoring = useRef<number | null>(null)

  useEffect(() => {
    const before = previous.current
    previous.current = value
    if (before === value) return
    if (restoring.current !== null && value === restoring.current) {
      restoring.current = null
      return
    }
    if (typeof before === "number" && typeof value === "number") push(key, before)
  }, [key, value, push])

  const stack = api.get(key)
  const last = stack.length > 0 ? stack[stack.length - 1] : null
  const undo = () => {
    if (last === null) return
    restoring.current = last
    if (restore(last) === false) {
      restoring.current = null
      return
    }
    pop(key)
  }
  return { last, depth: stack.length, undo }
}
