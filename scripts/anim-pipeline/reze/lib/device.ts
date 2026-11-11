"use client"

// Is this page running somewhere other than the site it was built for: a
// repackaged WebView, an unknown host? Asked once on mount; the answer does not
// change while the page lives.

import { useSyncExternalStore } from "react"

const P =
  "eyJoIjpbInJpZy5yZXplLm9uZSIsInd3dy5yaWcucmV6ZS5vbmUiLCJsb2NhbGhvc3QiLCIxMjcuMC4wLjEiXSwicyI6Ii52ZXJjZWwuYXBwIiwiZSI6IkVsZWN0cm9uLyIsInciOiI7IHd2XFwpIiwiYiI6IkFuZHJvaWQgV2ViVmlldyIsImEiOiJNaWNyb01lc3NlbmdlcnxXZUNoYXR8UVEvfE1RUUJyb3dzZXJ8V2VpYm98QmlsaUFwcHxiaWxpLXxhd2VtZXxBd2VtZXxOZXdzQXJ0aWNsZXx4aHNkaXNjb3ZlcnxEaW5nVGFsa3xMYXJrfEZlaXNodXxUZWxlZ3JhbXxEaXNjb3JkfEZCQU58RkJBVnxJbnN0YWdyYW18TGluZS98VHdpdHRlciJ9"

function noticeDue(): boolean {
  try {
    const p = JSON.parse(atob(P)) as { h: string[]; s: string; e: string; w: string; b: string; a: string }
    const u = navigator.userAgent
    if (u.includes(p.e)) return false
    const h = window.location.hostname
    if (!p.h.includes(h) && !h.endsWith(p.s)) return true
    const d = (navigator as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData
    const marked = new RegExp(p.w).test(u) || !!d?.brands?.some((x) => x.brand === p.b)
    return marked && !new RegExp(p.a).test(u)
  } catch {
    return false
  }
}

const never = () => () => {}

/** Server render answers false: the notice is a client decision. */
export function useNotice(): boolean {
  return useSyncExternalStore(never, noticeDue, () => false)
}
