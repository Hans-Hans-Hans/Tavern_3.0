import * as React from "react"
import { readCompactDeviceLayout } from "@/lib/device-layout"

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(readCompactDeviceLayout)

  React.useEffect(() => {
    const pointer = window.matchMedia('(pointer: coarse)')
    const onChange = () => setIsMobile(readCompactDeviceLayout())
    pointer.addEventListener("change", onChange)
    window.addEventListener("resize", onChange)
    window.addEventListener("orientationchange", onChange)
    onChange()
    return () => {
      pointer.removeEventListener("change", onChange)
      window.removeEventListener("resize", onChange)
      window.removeEventListener("orientationchange", onChange)
    }
  }, [])

  return isMobile
}
